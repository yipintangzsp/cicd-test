# Portainer, FlareSolverr, Harbor Trivy Recovery - 2026-05-25

## Changes Applied

- Removed the duplicate Docker container `portainer`.
- Kept Kubernetes `ns-devops/portainer` running with the existing `portainer-ingress`.
- Restored `ns-devops/flaresolverr` from `0` to `1` replica.
- Restored `harbor/harbor-trivy` from `0` to `1` replica.
- Stabilized `ns-bigdata/spark-operator-webhook` after repeated health probe timeouts.

## Backup

Pre-change backup path on `192.168.1.58`:

```text
/home/zhang/platform-backups/pre-change-20260525-024523-portainer-scale
```

The backup includes Docker Portainer inspect metadata and the related Kubernetes manifests.

Additional Spark webhook pre-change backup:

```text
/home/zhang/platform-backups/pre-change-20260525-105333-spark-webhook-probe
```

## Runtime Decisions

- Docker Portainer was removed because Kubernetes already runs `ns-devops/portainer`.
- Docker Portainer data directory was preserved:

```text
/home/zhang/devops-stack/portainer/data
```

- `flaresolverr` failed on arm64 with Chromium segmentation faults, so it now runs as a stateless workload on an amd64 cloud worker.
- `harbor-trivy` uses `goharbor/trivy-adapter-photon:v2.14.3`, which is amd64-only in the current environment. Its PVC is bound to `devops`, so `qemu-user-static=1:8.2.2+ds-0ubuntu1.16` and `binfmt-support=2.2.2-7` were installed on `devops` to run it without moving or deleting the PVC.
- `spark-operator-webhook` was not moved. Its startup probe was added, liveness/readiness timeouts were relaxed, and CPU limit was raised from `200m` to `500m` to avoid false CrashLoopBackOff during leader election on a busy node.

## Image Backup

Additional Harbor backup tags created:

```text
harbor.devops.local/library/goharbor-trivy-adapter-photon:2.14.3-amd64
harbor.devops.local/library/flaresolverr-flaresolverr:v3.3.2-amd64
```

## Verified Final State

```text
ns-devops/portainer      1/1 Running
ns-devops/flaresolverr   1/1 Running on ucloud-worker
harbor/harbor-trivy      1/1 Running on devops
ns-bigdata/spark-operator-webhook 1/1 Running on devops
replicas=0 workloads     none
non-running pods         none
```

## Recovery Notes

If Docker Portainer is needed for emergency rollback, use the backup inspect file first and only recreate it temporarily. The preferred steady state is Kubernetes Portainer only.

Do not delete `data-harbor-trivy-0`; it is the Harbor Trivy local-path PVC bound to `devops`.
