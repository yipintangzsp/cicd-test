# V12 Harbor Image Backup - 2026-05-25

This record keeps the v12 recovery images in Harbor with explicit versions. It avoids tar backups because the server storage is limited; Harbor plus a tested restore script is the recovery source.

## Verified Harbor Images

| Purpose | Harbor image | Verified command |
| --- | --- | --- |
| Ansible runtime | `harbor.devops.local/library/ansible-core:2.20.0-r0-arm64` | `ansible --version` |
| OpenTelemetry Collector | `harbor.devops.local/library/opentelemetry-collector:0.152.1` | `--version` |
| Cosign | `harbor.devops.local/library/cosign:3.0.6-arm64` | `version` |
| Kubeconform | `harbor.devops.local/library/kubeconform:0.7.0-arm64` | `-v` |
| Trivy | `harbor.devops.local/library/trivy:0.68.2-arm64` | `--version` |
| V12 portal | `harbor.devops.local/library/hello-app-v12-portal:d3a1104` | temporary container page smoke test |

## Verified Digests

```text
harbor.devops.local/library/ansible-core@sha256:e1de1f169ff427f14ba6c972b220233d937600dc1ce722ee20090a906c2cfd56
harbor.devops.local/library/opentelemetry-collector@sha256:e2aa205d0b09e6c7580a431bf1a7abf336fd5b878764aaacc3edb679e95683ad
harbor.devops.local/library/cosign@sha256:b707619e3f7f67641aa6d2b32b5a0b06c93b184f7b013f45ea4de26049e266b7
harbor.devops.local/library/kubeconform@sha256:cb8ca5a6e9bfb60b1858d65cba57c27f8080befcd5282b21518b860192b91e31
harbor.devops.local/library/trivy@sha256:27a80e736604e6d0c475540c85a36342bdc18f9f348d0a6993e42d929b173159
harbor.devops.local/library/hello-app-v12-portal@sha256:c35cd3909a45d416ff92e5d5057f0d87ec34f29b66582adc44c4faa598b51ee2
```

## Commands

```bash
# Re-run the upload and validation flow.
devops-scripts/v12-harbor-image-backup.sh all

# Validate that Harbor still has restorable images.
devops-scripts/v12-harbor-image-backup.sh verify

# Recreate local tags from Harbor after local image loss.
devops-scripts/v12-harbor-image-backup.sh restore-local-tags
```

## Cleanup Policy

Only delete data that is both unused and restorable:

- Temporary build folders under `/tmp`.
- The failed `ansible-community-ee-minimal:2.18.7-1` amd64 images, because Jenkins wrappers now use `ansible-core:2.20.0-r0-arm64`.
- Do not delete GitLab, Harbor, Jenkins, k3s, Elasticsearch, Prometheus, Grafana, Kibana, MinIO, Kafka, or backup volumes from cleanup scripts.
