# Current Cluster Stabilization Checklist

## Situation

Based on the latest `kubectl get pods -A` snapshot on `2026-04-03`, the cluster is no longer in a "single service issue" state.

There are now several degraded workloads:

- `spark-operator/spark-history-server` is in `CrashLoopBackOff`
- `spark-operator/spark-operator-controller` is in `Error`
- `spark-operator/spark-operator-webhook` is in `Error`
- `data-infra/airflow-api-server` is `0/1 Running`
- `data-infra/airflow-dag-processor` is `1/2 Error`
- `data-infra/airflow-statsd` is `0/1 Running`
- `argocd/argocd-repo-server` is `0/1 Running`
- `kube-system/metrics-server` is `0/1 Running`

The safest path is:

1. Stop new restart storms from the newest broken stack first
2. Stop non-essential Airflow churn if there are no DAG files yet
3. Check whether the node is under resource pressure
4. Diagnose the remaining degraded pods one by one
5. Avoid cluster-wide restart, reinstall, or mass pod deletion

## Red Lines

Do **not** do these now:

- `k3s-uninstall.sh`
- `k3s-killall.sh`
- reboot the server "just to try"
- `kubectl delete pod -A --all`
- `kubectl rollout restart -A`
- global password resets for unrelated older services

## Step 1: Stop the Spark Restart Storm

If Spark is not immediately needed, the most conservative stabilization move is to stop the new broken Spark stack first.

```bash
kubectl scale deployment spark-history-server -n spark-operator --replicas=0
kubectl scale deployment spark-operator-controller -n spark-operator --replicas=0
kubectl scale deployment spark-operator-webhook -n spark-operator --replicas=0
kubectl get pods -n spark-operator -w
```

Why:

- It removes the noisiest restart churn
- It protects limited CPU and memory for older stable workloads
- It has a small blast radius because Spark is the newest clearly broken stack

## Step 2: Stop Non-Essential Airflow Churn

If Airflow currently has no DAG files and `airflow-dag-processor` is only restarting on probe timeouts, scale it down first to reduce churn:

```bash
kubectl scale deployment airflow-dag-processor -n data-infra --replicas=0
kubectl get pods -n data-infra -w
```

Why:

- the user-provided logs showed `Found 0 files for bundle dags-folder`
- repeated liveness failures add noise without business value
- on a single-node cluster, removing non-essential churn is a valid stability move

## Step 3: Check Node Pressure Before Touching Anything Else

```bash
kubectl top node
kubectl top pods -A --sort-by=memory | head -n 25
kubectl top pods -A --sort-by=cpu | head -n 25
kubectl describe node | egrep -A5 'MemoryPressure|DiskPressure|PIDPressure|Ready'
kubectl get events -A --sort-by=.lastTimestamp | tail -n 120
free -h
df -hT
```

What to look for:

- `MemoryPressure=True`
- `DiskPressure=True`
- repeated `Unhealthy`, `BackOff`, `OOMKilled`, `Failed`, `Evicted`
- one or two new workloads suddenly sitting at the top of memory use

## Step 4: Diagnose Remaining Broken Pods One by One

Run this exact block:

```bash
for item in \
  "argocd argocd-repo-server-78d7495f6-glpd5" \
  "data-infra airflow-api-server-7fdc687679-kzmqs" \
  "data-infra airflow-dag-processor-54664fff5d-mh49d" \
  "data-infra airflow-statsd-58b96b6d57-8sh9r" \
  "kube-system metrics-server-c8774f4f4-nt45j"; do
  set -- $item
  ns=$1
  pod=$2
  echo
  echo "===== $ns / $pod ====="
  kubectl describe pod -n "$ns" "$pod" | egrep -A8 'State:|Last State:|Reason:|Exit Code:|Ready:|Warning|BackOff|Unhealthy|OOMKilled|Failed'
  echo "--- previous logs ---"
  kubectl logs -n "$ns" "$pod" --all-containers --previous --tail=80 || true
  echo "--- current logs ---"
  kubectl logs -n "$ns" "$pod" --all-containers --tail=80 || true
done
```

## Step 5: Argo CD Repository Path Stabilization

If `argocd-repo-server` logs show timeouts against:

- `http://gitlab.devops.local/...`
- `http://192.168.1.58:30080/...`
- `http://192.168.1.58:30082/...`

then the conservative fix is to move Argo CD Applications from external GitLab routes to the in-cluster GitLab Service DNS name:

```bash
REPO_POD=$(kubectl get pod -n argocd -l app.kubernetes.io/name=argocd-repo-server -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n argocd "$REPO_POD" -c argocd-repo-server -- \
  git ls-remote http://gitlab-service.ns-devops.svc.cluster.local/root/hello-app.git HEAD
```

If that works, patch one application first:

```bash
kubectl patch application hello-app -n argocd --type merge -p '{"spec":{"source":{"repoURL":"http://gitlab-service.ns-devops.svc.cluster.local/root/hello-app.git"}}}'
kubectl get application hello-app -n argocd -w
```

Only after the first app behaves normally should the remaining apps be patched one by one.

Why:

- it avoids hairpinning out through Traefik or NodePort and back into GitLab
- it removes DNS and ingress dependence from Argo CD's repo fetch path
- it is a smaller and safer change than restarting Argo CD controllers

If the `repoURL` has already been moved to `gitlab-service.ns-devops.svc.cluster.local` and `argocd-repo-server` still times out on:

- `/.git/info/refs?service=git-upload-pack`

then the remaining problem is no longer ingress. At that point, treat it as a GitLab smart HTTP / Gitaly path problem and inspect GitLab internals before restarting anything:

```bash
GITLAB_POD=$(kubectl get pod -n ns-devops | awk '/^gitlab-/{print $1; exit}')

kubectl exec -n ns-devops "$GITLAB_POD" -- gitlab-ctl status
kubectl exec -n ns-devops "$GITLAB_POD" -- gitlab-rake gitlab:check SANITIZE=true
kubectl exec -n ns-devops "$GITLAB_POD" -- sh -lc "tail -n 120 /var/log/gitlab/gitaly/current"
kubectl exec -n ns-devops "$GITLAB_POD" -- sh -lc "tail -n 120 /var/log/gitlab/gitlab-workhorse/current"
kubectl exec -n ns-devops "$GITLAB_POD" -- sh -lc "tail -n 120 /var/log/gitlab/puma/current"
```

Do **not** restart the whole GitLab pod first if the web UI is still serving pages.

## Step 6: Interpret Conservatively

### If you see `OOMKilled`

Do this:

- do **not** restart everything
- keep Spark scaled down
- identify the top memory consumers
- add modest `requests.memory`
- add only carefully chosen `limits.memory`

Do **not** do this:

- blanket `LimitRange`
- tiny memory limits everywhere

### If you see `connection refused`, `timeout`, or dependency errors

Do this:

- check the dependent `Service` and `Endpoints`
- verify DB / Redis / internal API reachability before restarting the app pod

### If you see probe failures

Do this:

- prefer `startupProbe` or gentler `readinessProbe` adjustments
- avoid making `livenessProbe` more aggressive first

## Step 7: Treat Auth Problems As Secondary

Until the degraded pods are understood:

- pause more credential changes
- do not change GitLab / Jenkins / Argo CD / Grafana passwords
- keep the focus on service health first

Current auth work that can still remain in scope later:

- Superset `admin` reset
- Airflow local admin creation
- MinIO root credential confirmation

## Best Next Message To Send Back

After you run Steps 1 to 5, send back only:

1. `kubectl top node`
2. the first 20 lines of `kubectl top pods -A --sort-by=memory`
3. the tail of `kubectl get events -A --sort-by=.lastTimestamp | tail -n 120`
4. the `describe/logs` output for the five pods in Step 3
5. `kubectl get applications -n argocd`

That is enough to choose the safest next patch without guessing.
