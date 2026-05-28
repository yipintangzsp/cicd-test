# Platform Recruitment Fit 2026

## Scope

This note maps current DevOps, SRE, platform engineering, and DevSecOps hiring signals to the ZhangLab platform. It is intentionally conservative: add tightly scoped capabilities that strengthen the existing Jenkins, GitLab, ArgoCD, Kubernetes, Prometheus, Grafana, ELK, Harbor, Spark, Flink, Kafka, and Airflow platform without adding heavy, duplicated services.

## External Signals Checked

- CNCF Annual Survey 2024 highlights continued cloud native adoption and major CNCF project usage, including Kubernetes, Helm, etcd, CoreDNS, Cert Manager, and Argo.
- Public DevOps role descriptions repeatedly mention Kubernetes, CI/CD with Jenkins or GitLab, Terraform, Ansible, Helm, Prometheus, Grafana, ELK, Docker, and cloud automation.
- Grafana Observability Survey 2024 and OpenTelemetry survey material show strong OpenTelemetry momentum alongside Prometheus and Grafana.
- Recent DevSecOps and DevOps role descriptions commonly include Trivy, SonarQube, secrets scanning, SBOM, and image vulnerability scanning.

## Current Platform Coverage

Already covered:

- Kubernetes and k3s runtime.
- Jenkins parameterized pipelines.
- GitLab source control and GitHub variant pipeline.
- ArgoCD GitOps workflow.
- Harbor/local registry image storage.
- Prometheus, Grafana, Elasticsearch, Kibana, Filebeat.
- Kafka, Flink, Spark, Airflow, Trino, Superset.
- SonarQube and Trivy references in older pipeline versions.
- Cloudflare public portal for platform evidence.

## High-Frequency Gaps

Recommended additions, ordered by value per resource cost:

1. Helm/Kustomize standardization.
   - Reason: high-frequency hiring requirement and low runtime cost.
   - Platform fit: repo-only structure, ArgoCD-friendly, no new always-on Pod required.
   - Action: keep generated Kubernetes manifests, Helm values, and Kustomize overlays in Git.

2. Terraform/OpenTofu inventory layer.
   - Reason: IaC is one of the most repeated job requirements.
   - Platform fit: track node, tunnel, DNS, and service inventory as code without running a heavy controller.
   - Action: add plan-only pipeline stage first; do not auto-apply infrastructure changes.

3. Ansible operational runbooks.
   - Reason: common for VM and hybrid operations.
   - Platform fit: lightweight, agentless, useful for cloud-worker repair and repeatable k3s-agent checks.
   - Action: add playbooks for node health, WireGuard, k3s-agent config validation, and non-destructive repair.

4. OpenTelemetry collector edge profile.
   - Reason: high observability demand and strong ecosystem growth.
   - Platform fit: deploy only one small collector profile first, feeding existing Prometheus/ELK/Grafana paths.
   - Action: start with pipeline telemetry and app traces; avoid replacing Prometheus/Filebeat.

5. DevSecOps evidence: SBOM plus policy gates.
   - Reason: security scanning appears often in DevSecOps and platform roles.
   - Platform fit: use existing Trivy/SonarQube pipeline integration; no new platform database needed.
   - Action: generate CycloneDX SBOM and attach it to Jenkins/Grafana/Kibana evidence.

Deferred unless explicitly needed:

- Vault: valuable but adds operational risk and secret migration work.
- Service mesh: useful but heavy for the current resource-limited cluster.
- Thanos/Loki/Tempo full stack: useful at scale, but heavier than the current cluster needs. Prefer OpenTelemetry collector plus existing Prometheus/ELK first.
- Backstage: strong platform-engineering signal, but too heavy until the platform has stable APIs and catalog metadata.

## Scheduling Policy For Expiring Cloud Workers

Cloud nodes:

- aliyun-worker
- ucloud-worker

Policy:

- Keep `cloud=true:NoSchedule` on both cloud nodes.
- Add explicit labels:
  - `node.zhanglab.io/scheduling=limited-cloud`
  - `node.zhanglab.io/expiry-risk=true`
  - `node.zhanglab.io/important-workloads=avoid`
- Only stateless, rebuildable workloads may tolerate `cloud=true`.
- Stateful workloads, databases, registries, CI masters, GitLab, Harbor, Jenkins, Elasticsearch, Kafka, Spark masters, and storage-backed services must stay off these nodes unless explicitly overridden.

Good candidates:

- Static portal/frontend deployments.
- Stateless preview apps.
- Short-lived CI smoke-test workloads.
- DaemonSets that are intended to run on every node, such as node-exporter and filebeat.

Bad candidates:

- Jenkins, GitLab, Harbor, ArgoCD controller, Elasticsearch, Prometheus server, Grafana with local state, Kafka, Zookeeper, databases, MinIO, Spark master, Flink JobManager, Airflow metadata database, any Pod with PVC.

## Implementation Principle

High cohesion:

- IaC files live under `infra/`.
- Operational runbooks live under `ansible/`.
- GitOps overlays live under `argocd/` or `k8s/overlays/`.
- Jenkins evidence remains in `ci/` and `jenkins-v*-evidence.groovy`.

Low coupling:

- New tools should produce files, metrics, or events consumed by existing Jenkins/Grafana/Kibana paths.
- Avoid adding always-on services unless they replace manual work or provide platform-wide value.
- Default all infrastructure mutation to dry-run until the platform is reachable and verified.
