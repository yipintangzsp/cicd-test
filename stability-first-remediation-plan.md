# Stability-First Remediation Plan

## Goal

This plan is intentionally conservative.

Your bottom line is clear:

1. Server stability comes before feature work.
2. Services must keep running on a resource-limited single server.
3. Recovery after reboot must depend on system services and Kubernetes controllers, not on manual Pod babysitting.
4. Any change that can amplify blast radius should be delayed until we have evidence.

## Current Cluster Reading

Based on the outputs you shared on `2026-04-03`:

- `ssh.service` is now `active` and has been changed to `enabled`, which is correct for boot recovery.
- `Traefik`, `Ingress`, `Service`, and `Endpoints` are working for `gitlab.devops.local`, `airflow.devops.local`, and `superset.devops.local`.
- `GitLab` route is healthy and redirects to `/users/sign_in`.
- `Airflow` route is healthy and returns `200`.
- `Superset` route is healthy, but `admin / zsp359742` has not been confirmed in the app database yet.
- `spark-history-server` is the only clearly unhealthy public-facing workload right now because it is in `CrashLoopBackOff`.
- Several pods have non-zero restart counts, but most are currently `Running`, so they are watch items, not blanket rebuild candidates.

## Non-Negotiable Guardrails

These are the rules I recommend we do **not** break:

1. Do not run `k3s-uninstall.sh`, `k3s-killall.sh`, or any cluster-wide reinstall while the current platform is serving traffic.
2. Do not bulk-reset passwords for older services just because their pods restarted recently.
3. Do not introduce cluster-wide `LimitRange` or `ResourceQuota` before we inventory real usage.
4. Do not tighten liveness probes first on slow starters.
5. Do not add TLS everywhere in one pass while HTTP routing is still the known-good path.
6. Do not reboot the server as a "test" until `ssh`, `k3s`, and the critical workload controllers are confirmed healthy.

## Important Inference About "开机启动 Pod"

For Kubernetes-managed applications, there is usually no separate "boot start this Pod" switch.

The stable path is:

1. Ensure the host services come up after reboot, especially `ssh` and `k3s`.
2. Ensure the workloads are managed by `Deployment` or `StatefulSet`.
3. Let Kubernetes reconcile the desired replicas after the node is back.

This is an inference from the K3s install/service model and the way `Deployment` / `StatefulSet` controllers maintain desired state.

## Phased Plan

### Phase 0: Freeze the Blast Radius

Do now:

- Keep the platform on HTTP until all routes and app logins are stable.
- Avoid node reboot, K3s upgrade, chart upgrade, or storage migration.
- Stop treating pod age as install age.
- Make all decisions from `Service`, `Ingress`, controller type, restart trend, and logs.

Do not do now:

- Reinstall K3s
- Recreate namespaces
- Mass-delete pods to "refresh"
- Apply cluster-wide password resets

### Phase 1: Boot Recovery First

Target:

- `ssh` must be `enabled` and `active`
- `k3s` or `k3s-agent` must be `enabled` and `active`

Reason:

- If the host cannot recover cleanly after reboot, no higher-level fix is trustworthy.

Safe checks:

```bash
systemctl is-enabled ssh
systemctl is-active ssh
systemctl is-enabled k3s || systemctl is-enabled k3s-agent
systemctl is-active k3s || systemctl is-active k3s-agent
kubectl get nodes -o wide
```

### Phase 2: Fix Only the Actually Broken Service

Right now, the confirmed broken app is `spark-history-server`.

Priority order:

1. `spark-history-server` CrashLoop root cause
2. `Superset` admin credential reset
3. `Airflow` local admin creation if needed
4. `MinIO` credential reset only if access is actually required

Reason:

- Routing for GitLab, Airflow, and Superset is already working.
- Changing auth for healthy older services adds risk without improving platform availability.

### Phase 3: Resource Stability on a Single Limited Node

This is the most important long-term part.

#### 3.1 What to do first

- Inventory which critical workloads are missing `requests.cpu`, `requests.memory`, and `limits.memory`.
- Measure current top CPU and memory consumers before changing any manifest.
- Patch one workload at a time, not one namespace at a time.

#### 3.2 What not to do first

- Do **not** force CPU limits onto everything.
- Do **not** set very low memory limits just to make the YAML look "complete".
- Do **not** apply a namespace-wide `LimitRange` before confirming every chart and workload can tolerate it.

#### 3.3 Conservative resource policy

For a single-node server with limited resources:

- `requests.cpu`: yes, use modest values
- `requests.memory`: yes, use realistic floor values
- `limits.memory`: yes, but only after checking real peak usage and restart history
- `limits.cpu`: optional, and often better deferred for critical services to avoid throttling surprises

This is intentionally conservative: the priority is stable scheduling and fewer surprise restarts, not theoretical YAML perfection.

### Phase 4: Probe Policy

Use probe changes only where there is evidence.

Recommended order:

1. `startupProbe` for slow-starters
2. `readinessProbe` so unready pods leave service endpoints
3. `livenessProbe` only after startup behavior is understood

Current implication:

- Services like `GitLab`, `Superset`, and `Spark History` should not get harsher liveness settings first.
- If `spark-history-server` is slow or missing backend dependencies, aggressive liveness can make the crash loop worse.

### Phase 5: Exposed Surfaces

Current ingress is working, but some surfaces should still be handled more safely.

#### GitLab / Airflow / Superset

- Keep serving over HTTP for now if that is the current known-good path.
- After auth is stable, then decide whether to add TLS.

#### Traefik Dashboard

- Treat this separately from app accounts.
- Protect it with BasicAuth or IP restriction.
- Do not leave it exposed without an access control decision.

## Immediate Action Queue

### A. Run the new read-only guardrail audit

```bash
cd ~/code/gitLab/devops-scripts
bash stage0_k3s_stability_audit.sh
```

### B. Fix Superset login only

```bash
SUPERSET_POD=$(kubectl get pod -n data-infra -o name | sed 's#pod/##' | grep '^superset-' | head -n1)
kubectl exec -it -n data-infra "$SUPERSET_POD" -- sh -lc "
superset fab reset-password --username admin --password 'zsp359742' \
|| superset fab create-admin \
  --username admin \
  --firstname admin \
  --lastname admin \
  --email admin@devops.local \
  --password 'zsp359742'
superset init
"
kubectl exec -it -n data-infra "$SUPERSET_POD" -- superset fab list-users
```

### C. Investigate Spark History before any auth work there

```bash
kubectl describe pod -n spark-operator spark-history-server-5bbb65b6c8-dpvtl
kubectl logs -n spark-operator spark-history-server-5bbb65b6c8-dpvtl --previous --tail=200
```

## What "The Most Beautiful Fix" Looks Like Here

The most beautiful fix is not the one that changes the most.

It is the one that:

- keeps the current healthy routes online,
- repairs only the failing login or failing workload,
- improves reboot recovery through `systemd` and K3s service state,
- adds resource guardrails one workload at a time,
- and leaves a readable audit trail for every future change.

That is why I recommend:

1. Read-only audit first
2. Repair only the confirmed breakage
3. Add conservative resource requests gradually
4. Delay wide-scope auth, TLS, and cluster policy changes until the node is boringly stable

## Source Links

Official references used to shape this plan:

- [K3s Quick-Start Guide](https://docs.k3s.io/quick-start)
- [K3s Private Registry Configuration](https://docs.k3s.io/installation/private-registry)
- [Kubernetes Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [Apache Airflow CLI Reference](https://airflow.apache.org/docs/apache-airflow/stable/cli-and-env-variables-ref.html)
- [Apache Superset Installation / create-admin flow](https://superset.apache.org/docs/installation/pypi)
- [Traefik Dashboard Documentation](https://doc.traefik.io/traefik/operations/dashboard/)

## Notes

- Some choices above are informed in part by current cluster evidence, not only by docs.
- The recommendation to prefer `requests` first and defer blanket CPU limits is a stability-focused engineering judgment for your current single-node environment.
- The recommendation to delay cluster-wide `LimitRange` is also a risk-control judgment, because it can affect future pod creation in ways that are easy to underestimate.
