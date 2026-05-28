# Recent Services Account Plan

## Scope

This checklist uses `Service` and `Ingress` ages to decide what counts as "created in the last 7 days".
It does **not** use pod age, because many older services recently restarted and got new pods.
Use this checklist **after** the stability guardrail audit in [stability-first-remediation-plan.md](/Users/zhangsir/code/gitLab/stability-first-remediation-plan.md).
If a service is unhealthy, fix health first and only then touch its credentials.

## Summary

| Service | URL | Why It Counts As Recent | Auth Model | Target Credential | Status | Action |
| --- | --- | --- | --- | --- | --- | --- |
| Airflow | `http://airflow.devops.local` | `airflow-api-server` service age about 3 days, ingress age about 4 hours | Local Airflow user | `admin / zsp359742` | Not confirmed yet | Create or reset local admin user |
| Superset | `http://superset.devops.local` | `superset` service age about 3 days, ingress age about 4 hours | Local Superset FAB user | `admin / zsp359742` | Login failed | Reset or create `admin`, then run `superset init` |
| MinIO | `http://minio.devops.local` | `minio` service age about 4 days, ingress age about 4 hours | Root user from env or secret | `admin / zsp359742` | Not confirmed yet | Set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`, then restart deployment |
| Trino | `http://trino.devops.local` | `trino` service age about 3 days, ingress age about 4 hours | Usually no local web admin account | N/A | No account should be forced | Leave as-is unless external auth is added |
| Jaeger | `http://jaeger.devops.local` | ingress age about 4 hours | Usually no login by default | N/A | No account should be forced | Leave as-is |
| Spark History | `http://spark.devops.local` | ingress age about 4 hours | Usually no login by default | N/A | Service unhealthy | Fix `CrashLoopBackOff` before any access work |
| Traefik Dashboard | `http://traefik.devops.local` | ingress age about 3 hours | Should use BasicAuth or IP restriction, not a shared local app user | Separate dashboard auth | Not reviewed | Protect with middleware if public access is needed |

## Not Recent Even If Pod Age Looks New

| Service | Why It Is Not In The Recent-Week Password Scope |
| --- | --- |
| GitLab | `gitlab-service` is about 36 days old; current pod is young because it restarted |
| Jenkins | `jenkins-service` is about 36 days old; current pod is young because it restarted |
| Argo CD | `argocd-server` service and ingress are about 36 days old |
| Grafana | service and ingress are about 34 to 36 days old |
| Kibana | `kibana-service` is about 35 days old; current pod is young because it restarted |
| Kafka UI | service and ingress are about 26 days old |
| SonarQube | ingress and service are older than 7 days |
| Registry | `registry-service` is about 36 days old |
| Flink UI | ingress and service are older than 7 days |

## Recommended Actions

1. Set or reset `admin / zsp359742` only for `Airflow`, `Superset`, and `MinIO`.
2. Do not force the same pattern onto `Trino`, `Jaeger`, or `Spark History`, because they do not use that kind of local admin model.
3. Treat `Traefik Dashboard` separately and protect it with BasicAuth instead of leaving it open.
4. Keep `GitLab`, `Jenkins`, `Argo CD`, `Grafana`, `Kibana`, `Kafka UI`, `Registry`, and `SonarQube` out of this "recent-week" credential reset batch.

## Commands

### Airflow

```bash
PW='zsp359742'
MAIL='admin@devops.local'
AIRFLOW_POD=$(kubectl get pod -n data-infra | awk '/^airflow-scheduler-/{print $1; exit}')
kubectl exec -n data-infra "$AIRFLOW_POD" -c scheduler -- airflow users delete -u admin || true
kubectl exec -n data-infra "$AIRFLOW_POD" -c scheduler -- airflow users create \
  --username admin \
  --firstname admin \
  --lastname admin \
  --role Admin \
  --email "$MAIL" \
  --password "$PW"
```

### Superset

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

### MinIO

```bash
kubectl set env deployment/minio -n data-infra \
  MINIO_ROOT_USER=admin \
  MINIO_ROOT_PASSWORD='zsp359742'
kubectl rollout status deployment/minio -n data-infra --timeout=180s
```

## Verification

Use these URLs after the commands above:

- `http://airflow.devops.local`
- `http://superset.devops.local`
- `http://minio.devops.local`

Expected credential for these three only:

- Username: `admin`
- Password: `zsp359742`
