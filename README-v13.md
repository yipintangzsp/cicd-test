# ZhangLab Platform Era V13

V13 starts a new governance era while inheriting the V12 full-platform evidence model.

## Purpose

- Keep V12 full service and pod coverage.
- Add non-destructive platform patrol evidence.
- Add SLO/error-budget, capacity runway, backup inventory, restore dry-run, ownership map and release gate.
- Publish the same Cloudflare-ready portal at `https://platform.heil.ccwu.cc/`.
- Use `platform-era-v13-portal` as the primary Kubernetes portal service; keep `hello-app-v10-portal` only as the NodePort compatibility alias for the existing Cloudflare route.
- Fail the plan-conformance gate if observability import, Kibana saved object import, Cloudflare evidence, V13 portal naming, or cloud-worker low-priority scheduling checks drift from the plan.

## Safety Contract

- Default behavior does not delete PVCs, backups, images, namespaces or workloads.
- Restore validation is dry-run only.
- Backup checks are inventory/redacted evidence only.
- Cloud worker nodes remain low-priority capacity; governance evidence reports important workloads scheduled there.

## Jenkins Entry

- Job: `platform-era-v13`
- Script path: `Jenkinsfile-router`
- Pipeline file: `Jenkinsfile-epoch-v13`
- GitLab project: `root/platform-era-v13`
