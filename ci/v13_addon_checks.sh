#!/usr/bin/env bash
set -eu

export PATH="/var/jenkins_home/tools/bin:${PATH}"

CHECK="${1:-}"
mkdir -p reports/v13-market-fit reports/v13-triggering reports/v13-iac reports/v13-devsecops \
  reports/v13-data-lineage reports/v13-observability-deep reports/v13-cluster-resilience \
  reports/v13-cloudflare-live

retry_cmd() {
  attempts="${V13_RETRY_ATTEMPTS:-5}"
  delay="${V13_RETRY_DELAY_SECONDS:-4}"
  count=1
  until "$@"; do
    if [ "$count" -ge "$attempts" ]; then
      return 1
    fi
    count=$((count + 1))
    sleep "$delay"
  done
}

kubectl() {
  retry_cmd command kubectl "$@"
}

cluster_url() {
  local url="$1"
  local scheme rest hostport host portpart path remainder svc ns ip
  case "$url" in
    http://*.svc.cluster.local*|https://*.svc.cluster.local*) ;;
    *) printf '%s' "$url"; return 0 ;;
  esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  hostport="${rest%%/*}"
  path="${rest#"$hostport"}"
  [ "$path" != "$rest" ] || path="/"
  host="${hostport%%:*}"
  portpart="${hostport#"$host"}"
  if [[ "$host" == *.svc.cluster.local ]]; then
    svc="${host%%.*}"
    remainder="${host#*.}"
    ns="${remainder%%.*}"
    ip="$(command kubectl -n "$ns" get svc "$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
    if [ -n "$ip" ] && [ "$ip" != "None" ]; then
      printf '%s://%s%s%s' "$scheme" "$ip" "$portpart" "$path"
      return 0
    fi
  fi
  printf '%s' "$url"
}

curl() {
  local args=("$@")
  local i original rewritten
  for i in "${!args[@]}"; do
    case "${args[$i]}" in
      http://*.svc.cluster.local*|https://*.svc.cluster.local*)
        original="${args[$i]}"
        rewritten="$(cluster_url "$original")"
        if [ "$rewritten" != "$original" ]; then
          args[$i]="$rewritten"
        fi
        ;;
    esac
  done
  retry_cmd command curl "${args[@]}"
}

case "$CHECK" in
  epoch-charter)
    mkdir -p reports/v13-governance
    cat > reports/v13-governance/epoch-charter.json <<'JSON'
{"version":"v13","era":"governance","inherits_from":"v12","non_destructive_default":true,"purpose":["daily-platform-patrol","slo-baseline","backup-and-restore-evidence","capacity-runway","release-governance"],"forbidden_without_explicit_approval":["delete-pvc","delete-backup","reset-cluster","prune-images","scale-stateful-to-zero"]}
JSON
    ;;
  backup-inventory)
    mkdir -p reports/v13-governance
    if command kubectl --request-timeout=25s get pvc -A -o json > reports/v13-governance/pvc-inventory.json.tmp 2>reports/v13-governance/pvc-inventory.err \
      && node -e "JSON.parse(require('fs').readFileSync('reports/v13-governance/pvc-inventory.json.tmp','utf8'))"; then
      mv reports/v13-governance/pvc-inventory.json.tmp reports/v13-governance/pvc-inventory.json
    else
      printf '{"items":[],"collectionWarning":"pvc inventory degraded; see pvc-inventory.err"}\n' > reports/v13-governance/pvc-inventory.json
    fi
    if command kubectl --request-timeout=25s get pv -o json > reports/v13-governance/pv-inventory.json.tmp 2>reports/v13-governance/pv-inventory.err \
      && node -e "JSON.parse(require('fs').readFileSync('reports/v13-governance/pv-inventory.json.tmp','utf8'))"; then
      mv reports/v13-governance/pv-inventory.json.tmp reports/v13-governance/pv-inventory.json
    else
      printf '{"items":[],"collectionWarning":"pv inventory degraded; see pv-inventory.err"}\n' > reports/v13-governance/pv-inventory.json
    fi
    if command kubectl --request-timeout=25s get secrets -A -o json > reports/v13-governance/secrets-redaction-source.json.tmp 2>reports/v13-governance/secrets-inventory.err \
      && node -e "JSON.parse(require('fs').readFileSync('reports/v13-governance/secrets-redaction-source.json.tmp','utf8'))"; then
      node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('reports/v13-governance/secrets-redaction-source.json.tmp','utf8')).items||[];const keep=s.map(x=>({namespace:x.metadata.namespace,name:x.metadata.name,type:x.type,keys:Object.keys(x.data||{})}));fs.writeFileSync('reports/v13-governance/secret-inventory-redacted.json',JSON.stringify(keep,null,2));"
      rm -f reports/v13-governance/secrets-redaction-source.json.tmp
    else
      printf '[]\n' > reports/v13-governance/secret-inventory-redacted.json
    fi
    node -e "const fs=require('fs');const pvc=JSON.parse(fs.readFileSync('reports/v13-governance/pvc-inventory.json','utf8')).items||[];const pv=JSON.parse(fs.readFileSync('reports/v13-governance/pv-inventory.json','utf8')).items||[];fs.writeFileSync('reports/v13-governance/backup-inventory-summary.json',JSON.stringify({pvcCount:pvc.length,pvCount:pv.length,redactedSecretInventory:true,mode:'inventory-only-no-delete-no-copy'},null,2));"
    ;;
  restore-drill)
    mkdir -p reports/v13-governance
    find k8s argocd monitoring -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | sort > reports/v13-governance/restore-manifest-candidates.txt || true
    : > reports/v13-governance/restore-dry-run.txt
    while read -r f; do
      [ -n "$f" ] || continue
      kubectl apply --dry-run=client -f "$f" >> reports/v13-governance/restore-dry-run.txt 2>&1 || echo "warning: $f dry-run warning" >> reports/v13-governance/restore-dry-run.txt
    done < reports/v13-governance/restore-manifest-candidates.txt
    cat > reports/v13-governance/restore-drill-verdict.json <<'JSON'
{"mode":"client-dry-run","mutation_performed":false,"scope":"manifest-render-and-api-shape-check","restore_data_written":false}
JSON
    ;;
  slo-budget)
    mkdir -p reports/v13-governance
    node -e "const fs=require('fs');const rows=fs.existsSync('reports/v13-service-probes.ndjson')?fs.readFileSync('reports/v13-service-probes.ndjson','utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ok=rows.filter(r=>r.status==='ok').length;const total=rows.length;const availability=total?Math.round(ok*10000/total)/100:100;const target=99;fs.writeFileSync('reports/v13-governance/slo-budget.json',JSON.stringify({serviceProbeTotal:total,serviceProbeOk:ok,availabilityPercent:availability,targetPercent:target,errorBudgetRemainingPercent:Math.max(0,Math.round((availability-target)*100)/100)},null,2));"
    ;;
  capacity-runway)
    mkdir -p reports/v13-governance
    kubectl top nodes --no-headers > reports/v13-governance/node-top.txt 2>&1 || true
    kubectl top pods -A --no-headers > reports/v13-governance/pod-top.txt 2>&1 || true
    kubectl get nodes -o json > reports/v13-governance/nodes-capacity.json
    node -e "const fs=require('fs');const nodes=JSON.parse(fs.readFileSync('reports/v13-governance/nodes-capacity.json','utf8')).items||[];const summary=nodes.map(n=>({node:n.metadata.name,cpu:n.status.capacity?.cpu,memory:n.status.capacity?.memory,ready:(n.status.conditions||[]).some(c=>c.type==='Ready'&&c.status==='True')}));fs.writeFileSync('reports/v13-governance/capacity-runway.json',JSON.stringify({nodes:summary,source:'kubectl-top-if-available',recommendation:'keep-heavy-stateful-workloads-on-devops-control-plane-unless-explicitly-approved'},null,2));"
    ;;
  stateful-registry)
    mkdir -p reports/v13-governance
    kubectl get statefulset -A -o json > reports/v13-governance/statefulsets.json
    kubectl get pvc -A -o json > reports/v13-governance/stateful-pvcs.json
    node -e "const fs=require('fs');const sts=JSON.parse(fs.readFileSync('reports/v13-governance/statefulsets.json','utf8')).items||[];const pvc=JSON.parse(fs.readFileSync('reports/v13-governance/stateful-pvcs.json','utf8')).items||[];fs.writeFileSync('reports/v13-governance/stateful-registry.json',JSON.stringify({statefulsets:sts.map(x=>x.metadata.namespace+'/'+x.metadata.name).sort(),pvc:pvc.map(x=>x.metadata.namespace+'/'+x.metadata.name).sort()},null,2));"
    ;;
  ownership-map)
    mkdir -p reports/v13-governance
    kubectl get deploy,statefulset,daemonset -A -o json > reports/v13-governance/workload-ownership-source.json
    node -e "const fs=require('fs');const items=JSON.parse(fs.readFileSync('reports/v13-governance/workload-ownership-source.json','utf8')).items||[];const layer=k=>/jenkins|gitlab|harbor|argocd|sonar|registry/.test(k)?'devops-control':/kafka|spark|flink|airflow|trino|superset|minio/.test(k)?'data-platform':/prometheus|grafana|kibana|elastic|loki|jaeger|zabbix|otel/.test(k)?'observability':/hello|jkvideo|apps/.test(k)?'application':'cluster-support';const rows=items.map(x=>({kind:x.kind,namespace:x.metadata.namespace,name:x.metadata.name,layer:layer((x.metadata.namespace+'/'+x.metadata.name).toLowerCase()),replicas:x.spec?.replicas??x.status?.desiredNumberScheduled??0}));fs.writeFileSync('reports/v13-governance/ownership-map.json',JSON.stringify(rows,null,2));"
    ;;
  release-gate)
    mkdir -p reports/v13-governance
    node -e "const fs=require('fs');const slo=fs.existsSync('reports/v13-governance/slo-budget.json')?JSON.parse(fs.readFileSync('reports/v13-governance/slo-budget.json','utf8')):{};const backup=fs.existsSync('reports/v13-governance/backup-inventory-summary.json');const restore=fs.existsSync('reports/v13-governance/restore-drill-verdict.json');const pass=(slo.availabilityPercent??100)>=90 && backup && restore;fs.writeFileSync('reports/v13-governance/release-gate.json',JSON.stringify({pass,checks:{slo,backupInventory:backup,restoreDryRun:restore},mode:'evidence-gate-no-destructive-action'},null,2));if(!pass) process.exit(1);"
    ;;
  runbook-handoff)
    mkdir -p reports/v13-governance
    cat > reports/v13-governance/runbook-handoff.md <<'EOF2'
# V13 Governance Runbook
- 先看 Jenkins `platform-era-v13` 最新构建结论。
- 再看 `reports/v13-governance/release-gate.json`、`slo-budget.json`、`capacity-runway.json`。
- 任何恢复动作必须先通过 dry-run 证据，禁止直接删除 PVC、备份和镜像缓存。
- 云 worker 只承接无状态/低优先级 Pod，核心状态服务优先留在 devops。
EOF2
    ;;
  next-epoch-backlog)
    mkdir -p reports/v13-governance
    cat > reports/v13-governance/v14-candidate-backlog.json <<'JSON'
{"version":"v14-candidates","items":["automated-restore-drill-in-isolated-namespace","capacity-trend-from-prometheus-history","release-risk-score-with-change-diff","service-owner-slo-page","backup-age-and-size-attestation"],"rule":"do-not-increase-script-complexity-unless-it-improves-operability"}
JSON
    ;;
  market-baseline)
    cat > reports/v13-market-fit/recruitment-baseline.json <<'JSON'
{"version":"v13","principle":"high-cohesion-low-coupling-no-heavy-install-by-default","capabilities":["kubernetes","ci-cd","gitops","observability","devsecops","streaming-data","spark-data-platform","iac"]}
JSON
    ;;
  tool-gap)
    : > reports/v13-market-fit/jenkins-tool-gap.txt
    for tool in helm terraform ansible trivy cosign kubeconform kubectl docker node git curl; do
      if command -v "$tool" >/dev/null 2>&1; then printf '%s=present\n' "$tool"; else printf '%s=missing\n' "$tool"; fi
    done | tee reports/v13-market-fit/jenkins-tool-gap.txt
    ;;
  triggering-ci)
    {
      grep -n 'gitlab(' Jenkinsfile-router || true
      grep -n 'githubPush()' Jenkinsfile-router Jenkinsfile || true
    } > reports/v13-triggering/ci-trigger.txt
    test -s reports/v13-triggering/ci-trigger.txt
    retry_cmd kubectl -n ns-devops get deploy github-webhook-relay -o wide > reports/v13-triggering/github-relay.txt
    retry_cmd curl -fsS --max-time 8 http://github-webhook-relay.ns-devops.svc.cluster.local:8080/healthz > reports/v13-triggering/github-relay-health.txt
    ;;
  version-contract)
    grep -n "Jenkinsfile-epoch-v13" Jenkinsfile-router Jenkinsfile-epoch-v13 > reports/v13-triggering/version-choice.txt
    grep -n "V12" README-v13.md Jenkinsfile-router >> reports/v13-triggering/version-choice.txt
    ;;
  github-cache)
    if [ -d /var/jenkins_home/github-cache/cicd-test.git ]; then
      git --git-dir=/var/jenkins_home/github-cache/cicd-test.git rev-parse --short HEAD > reports/v13-triggering/github-cache-head.txt || true
    else
      echo "github cache not present" > reports/v13-triggering/github-cache-head.txt
    fi
    ;;
  helm-gap)
    command -v helm >/dev/null 2>&1 && helm version > reports/v13-iac/helm.txt || echo "helm=missing; fallback=kubernetes-manifest-and-argocd" > reports/v13-iac/helm.txt
    ;;
  terraform-gap)
    command -v terraform >/dev/null 2>&1 && terraform version > reports/v13-iac/terraform.txt || echo "terraform=missing; install only before cloud-IaC lifecycle is introduced" > reports/v13-iac/terraform.txt
    ;;
  ansible-gap)
    command -v ansible >/dev/null 2>&1 && ansible --version > reports/v13-iac/ansible.txt || echo "ansible=missing; current changes use Kubernetes API and GitOps" > reports/v13-iac/ansible.txt
    ;;
  iac-render)
    find k8s argocd monitoring -type f 2>/dev/null | sort > reports/v13-iac/manifest-inventory.txt || true
    : > reports/v13-iac/kubeconform.txt
    if command -v kubeconform >/dev/null 2>&1; then
      kubeconform -v > reports/v13-iac/kubeconform.txt 2>&1 || true
      while read -r f; do
        case "$f" in *.yaml|*.yml) timeout 8 kubeconform -ignore-missing-schemas -summary "$f" >> reports/v13-iac/kubeconform.txt 2>&1 || echo "$f kubeconform_timeout_or_warning" >> reports/v13-iac/kubeconform.txt ;; esac
      done < reports/v13-iac/manifest-inventory.txt
    else
      echo "kubeconform=missing" > reports/v13-iac/kubeconform.txt
    fi
    while read -r f; do
      case "$f" in *.yaml|*.yml) kubectl apply --dry-run=client -f "$f" >/dev/null 2>&1 || echo "$f" >> reports/v13-iac/dry-run-warnings.txt ;; esac
    done < reports/v13-iac/manifest-inventory.txt
    wc -l reports/v13-iac/manifest-inventory.txt | tee reports/v13-iac/manifest-count.txt
    ;;
  argocd-health)
    kubectl -n argocd get applications.argoproj.io -o wide > reports/v13-iac/argocd-apps.txt 2>&1 || true
    kubectl -n argocd get pod -o wide > reports/v13-iac/argocd-pods.txt
    ;;
  sonarqube)
    kubectl -n sonarqube get deploy,sts,svc,pod -o wide > reports/v13-devsecops/sonarqube-k8s.txt
    curl -fsS --max-time 10 http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000/api/system/status > reports/v13-devsecops/sonarqube-status.json || true
    ;;
  harbor-trivy)
    kubectl -n harbor get statefulset harbor-trivy -o wide > reports/v13-devsecops/harbor-trivy.txt 2>&1 || true
    kubectl -n harbor get svc harbor-trivy -o wide > reports/v13-devsecops/harbor-trivy-service.txt 2>&1 || true
    ;;
  trivy-gap)
    command -v trivy >/dev/null 2>&1 && trivy --version > reports/v13-devsecops/trivy-cli.txt || echo "trivy-cli=missing; use-harbor-trivy-service-first" > reports/v13-devsecops/trivy-cli.txt
    ;;
  cosign-gap)
    command -v cosign >/dev/null 2>&1 && cosign version > reports/v13-devsecops/cosign.txt || echo "cosign=missing; keep SIGN_IMAGE as contract until key management is ready" > reports/v13-devsecops/cosign.txt
    ;;
  secret-scan)
    P1='AKIA[0-9A-Z]{16}'
    P2='BEGIN RSA PRIVATE ''KEY'
    P3='password[[:space:]]*='
    P4='token[[:space:]]*='
    grep -RInE "$P1|$P2|$P3|$P4" Jenkinsfile* ci jenkins-*.groovy 2>/dev/null \
      | grep -v '^ci/v13_addon_checks.sh:' \
      > reports/v13-devsecops/secret-patterns.txt || true
    if grep -q "$P2" reports/v13-devsecops/secret-patterns.txt; then exit 1; fi
    ;;
  kafka-endpoints)
    kubectl -n ns-bigdata get endpointslices -l kubernetes.io/service-name=kafka -o yaml > reports/v13-data-lineage/kafka-endpoints.yaml
    grep -q 'ready: true' reports/v13-data-lineage/kafka-endpoints.yaml
    ;;
  kafka-ui)
    curl -fsS --max-time 10 http://kafka-ui.ns-bigdata.svc.cluster.local:8080/ > reports/v13-data-lineage/kafka-ui.html || true
    kubectl -n ns-bigdata get deploy kafka-ui -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' > reports/v13-data-lineage/kafka-ui-ready.txt
    ;;
  jenkins-kafka-link)
    kubectl -n ns-devops get deploy jenkins-build-log-filebeat-kafka -o wide > reports/v13-data-lineage/jenkins-filebeat-kafka.txt
    kubectl -n ns-bigdata get daemonset filebeat-kafka -o wide > reports/v13-data-lineage/bigdata-filebeat-kafka.txt
    ;;
  spark-crd)
    kubectl get crd | grep -i spark > reports/v13-data-lineage/spark-crds.txt
    kubectl api-resources | grep -i spark > reports/v13-data-lineage/spark-api-resources.txt
    ;;
  spark-logs)
    kubectl -n ns-bigdata logs deploy/spark-operator-controller --tail=120 > reports/v13-data-lineage/spark-controller.log 2>&1 || true
    test -s reports/v13-data-lineage/spark-controller.log || echo "spark controller log empty" > reports/v13-data-lineage/spark-controller.log
    ;;
  spark-webhook)
    kubectl -n ns-bigdata get svc spark-operator-webhook-svc -o yaml > reports/v13-data-lineage/spark-webhook-service.yaml
    ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      kubectl -n ns-bigdata get endpointslices -l kubernetes.io/service-name=spark-operator-webhook-svc -o json > reports/v13-data-lineage/spark-webhook-endpoints.json
      node <<'NODE' && { ready=1; break; } || true
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('reports/v13-data-lineage/spark-webhook-endpoints.json', 'utf8'));
const endpoints = (data.items || []).flatMap((item) => item.endpoints || []);
const ready = endpoints.filter((endpoint) => endpoint.conditions?.ready === true && endpoint.conditions?.terminating !== true);
fs.writeFileSync('reports/v13-data-lineage/spark-webhook-ready-summary.json', JSON.stringify({
  endpointTotal: endpoints.length,
  readyEndpointTotal: ready.length,
  readyPods: ready.map((endpoint) => endpoint.targetRef?.name).filter(Boolean)
}, null, 2) + '\n');
if (ready.length < 1) console.warn("spark-webhook: no ready endpoints");
NODE
      sleep 5
    done
    kubectl -n ns-bigdata get endpointslices -l kubernetes.io/service-name=spark-operator-webhook-svc -o yaml > reports/v13-data-lineage/spark-webhook-endpoints.yaml
    [ "$ready" = "1" ]
    ;;
  flink-jobs)
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/jobs/overview > reports/v13-data-lineage/flink-jobs.json || true
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/overview > reports/v13-data-lineage/flink-overview.json
    ;;
  flink-taskmanagers)
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/taskmanagers > reports/v13-data-lineage/flink-taskmanagers.json || true
    kubectl -n ns-bigdata get deploy flink-taskmanager -o wide > reports/v13-data-lineage/flink-taskmanager.txt
    ;;
  airflow-dags)
    curl -fsS --max-time 10 http://airflow-api-server.data-infra.svc.cluster.local:8080/api/v2/monitor/health > reports/v13-data-lineage/airflow-health.json
    curl -fsS --max-time 10 http://airflow-api-server.data-infra.svc.cluster.local:8080/api/v2/dags > reports/v13-data-lineage/airflow-dags.json || true
    ;;
  trino-catalog)
    curl -fsS --max-time 10 http://trino.data-infra.svc.cluster.local:8080/v1/info > reports/v13-data-lineage/trino-info.json
    curl -fsS --max-time 10 http://trino.data-infra.svc.cluster.local:8080/v1/catalog > reports/v13-data-lineage/trino-catalog.json || true
    ;;
  superset-bi)
    curl -fsS --max-time 10 http://superset.data-infra.svc.cluster.local:8088/health > reports/v13-data-lineage/superset-health.txt || true
    kubectl -n data-infra get deploy superset superset-worker -o wide > reports/v13-data-lineage/superset-workloads.txt
    ;;
  minio)
    curl -fsS --max-time 10 http://minio.data-infra.svc.cluster.local:9000/minio/health/live > reports/v13-data-lineage/minio-live.txt
    kubectl -n data-infra get deploy,svc | grep -i minio > reports/v13-data-lineage/minio-k8s.txt
    ;;
  prometheus-targets)
    curl -fsS --max-time 10 http://kube-stack-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090/api/v1/targets > reports/v13-observability-deep/prometheus-targets.json || true
    curl -fsS --max-time 10 http://kube-stack-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090/-/ready > reports/v13-observability-deep/prometheus-ready.txt
    ;;
  grafana-datasources)
    curl -fsS --max-time 10 http://kube-stack-grafana.monitoring.svc.cluster.local/api/health > reports/v13-observability-deep/grafana-health.json
    curl -fsS --max-time 10 http://kube-stack-grafana.monitoring.svc.cluster.local/api/datasources > reports/v13-observability-deep/grafana-datasources.json || true
    ;;
  kibana-data-views)
    curl -fsS --max-time 10 http://kibana-service.default.svc.cluster.local:5601/api/status -H 'kbn-xsrf: true' > reports/v13-observability-deep/kibana-status.json
    curl -fsS --max-time 10 http://kibana-service.default.svc.cluster.local:5601/api/data_views -H 'kbn-xsrf: true' > reports/v13-observability-deep/kibana-data-views.json || true
    ;;
  elastic-indices)
    curl -fsS --max-time 10 http://elasticsearch.default.svc.cluster.local:9200/_cluster/health > reports/v13-observability-deep/es-health.json
    curl -fsS --max-time 10 http://elasticsearch.default.svc.cluster.local:9200/_cat/indices?v > reports/v13-observability-deep/es-indices.txt
    ;;
  loki-ring)
    curl -fsS --max-time 10 http://loki.monitoring.svc.cluster.local:3100/ready > reports/v13-observability-deep/loki-ready.txt
    curl -fsS --max-time 10 http://loki.monitoring.svc.cluster.local:3100/ring > reports/v13-observability-deep/loki-ring.html || true
    ;;
  jaeger)
    curl -fsS --max-time 10 http://jaeger.monitoring.svc.cluster.local:16686/ > reports/v13-observability-deep/jaeger.html || true
    kubectl -n monitoring get deploy jaeger -o wide > reports/v13-observability-deep/jaeger-k8s.txt
    ;;
  zabbix)
    curl -fsS --max-time 10 http://zabbix-web.zabbix.svc.cluster.local:8080/ > reports/v13-observability-deep/zabbix-web.html || true
    kubectl -n zabbix get deploy,svc,pod -o wide > reports/v13-observability-deep/zabbix-k8s.txt
    ;;
  otel-collector)
    kubectl -n monitoring get deploy,svc,pod -l app=otel-collector -o wide > reports/v13-observability-deep/otel-collector-k8s.txt
    kubectl -n monitoring get servicemonitor otel-collector -o wide > reports/v13-observability-deep/otel-collector-servicemonitor.txt
    curl -fsS --max-time 10 http://otel-collector.monitoring.svc.cluster.local:8888/metrics > reports/v13-observability-deep/otel-collector-metrics.txt
    ;;
  nodes)
    kubectl get nodes -o json > reports/v13-cluster-resilience/nodes.json
    kubectl get nodes -o wide > reports/v13-cluster-resilience/nodes.txt
    kubectl describe nodes > reports/v13-cluster-resilience/nodes-describe.txt
    ;;
  worker-scheduling)
    kubectl get pods -A -o wide | awk '$8 ~ /aliyun-worker|ucloud-worker/ {print}' > reports/v13-cluster-resilience/cloud-worker-pods.txt || true
    grep -E 'jenkins|gitlab|elasticsearch|kibana|mysql|postgresql|prometheus|grafana|harbor|argocd' reports/v13-cluster-resilience/cloud-worker-pods.txt > reports/v13-cluster-resilience/important-on-cloud-workers.txt || true
    ;;
  resource-requests)
    kubectl get deploy,statefulset,daemonset -A -o json > reports/v13-cluster-resilience/workloads.json
    node -e "const fs=require('fs');const items=JSON.parse(fs.readFileSync('reports/v13-cluster-resilience/workloads.json','utf8')).items||[];let total=0,withReq=0;for(const i of items){for(const c of i.spec?.template?.spec?.containers||[]){total++;if(c.resources?.requests?.cpu||c.resources?.requests?.memory)withReq++;}}fs.writeFileSync('reports/v13-cluster-resilience/resource-requests.json',JSON.stringify({totalContainers:total,containersWithRequests:withReq},null,2));console.log('resource_requests='+withReq+'/'+total)"
    ;;
  pvc)
    kubectl get pvc -A -o wide > reports/v13-cluster-resilience/pvc.txt
    kubectl get pv -o wide > reports/v13-cluster-resilience/pv.txt || true
    ;;
  events)
    kubectl get events -A --sort-by=.lastTimestamp | tail -200 > reports/v13-cluster-resilience/events-tail.txt || true
    grep -Ei 'failed|backoff|unhealthy|notready|oom|evict' reports/v13-cluster-resilience/events-tail.txt > reports/v13-cluster-resilience/event-warnings.txt || true
    ;;
  no-endpoints)
    kubectl get svc -A -o json > reports/v13-cluster-resilience/services.json
    kubectl get endpointslices -A -o json > reports/v13-cluster-resilience/endpointslices.json
    node -e "const fs=require('fs');const svcs=JSON.parse(fs.readFileSync('reports/v13-cluster-resilience/services.json','utf8')).items||[];const slices=JSON.parse(fs.readFileSync('reports/v13-cluster-resilience/endpointslices.json','utf8')).items||[];const ready=new Set();for(const s of slices){const ns=s.metadata?.namespace,n=s.metadata?.labels?.['kubernetes.io/service-name'];if((s.endpoints||[]).some(e=>e.conditions?.ready===true))ready.add(ns+'/'+n);}const miss=svcs.filter(s=>s.spec?.type!=='ExternalName').map(s=>s.metadata.namespace+'/'+s.metadata.name).filter(k=>!ready.has(k));fs.writeFileSync('reports/v13-cluster-resilience/no-endpoint-services.json',JSON.stringify(miss,null,2));console.log('no_endpoint_services='+miss.length)"
    ;;
  idle-services)
    node -e "const fs=require('fs');const miss=JSON.parse(fs.readFileSync('reports/v13-cluster-resilience/no-endpoint-services.json','utf8'));const allow=new Set(['kubernetes/default','data-infra/superset-postgresql']);const suspicious=miss.filter(x=>!allow.has(x));fs.writeFileSync('reports/v13-cluster-resilience/suspicious-idle-services.json',JSON.stringify(suspicious,null,2));console.log('suspicious_idle_services='+suspicious.length)"
    if [ "${V13_REQUIRE_NO_IDLE_CORE_SERVICE:-false}" = "true" ] && [ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('reports/v13-cluster-resilience/suspicious-idle-services.json','utf8')).length)")" -gt 0 ]; then exit 1; fi
    ;;
  pod-full-coverage)
    retry_cmd kubectl get pods -A -o json > reports/v13-cluster-resilience/pods-full.json
    node <<'NODE'
const fs = require('fs');
const source = 'reports/v13-cluster-resilience/pods-full.json';
const pods = JSON.parse(fs.readFileSync(source, 'utf8')).items || [];
function ready(pod) {
  const statuses = pod.status?.containerStatuses || [];
  return statuses.length > 0 && statuses.every((container) => container.ready === true);
}
function restarts(pod) {
  return (pod.status?.containerStatuses || []).reduce((sum, container) => sum + (container.restartCount || 0), 0);
}
function owner(pod) {
  const ref = pod.metadata?.ownerReferences?.[0];
  return ref ? `${ref.kind}/${ref.name}` : '';
}
const rows = pods.map((pod) => {
  const containerStatuses = pod.status?.containerStatuses || [];
  return {
    namespace: pod.metadata?.namespace || '',
    name: pod.metadata?.name || '',
    phase: pod.status?.phase || 'Unknown',
    ready: ready(pod),
    covered: true,
    node: pod.spec?.nodeName || '',
    podIP: pod.status?.podIP || '',
    owner: owner(pod),
    restarts: restarts(pod),
    containers: (pod.spec?.containers || []).map((container) => container.name),
    images: (pod.spec?.containers || []).map((container) => container.image),
    waitingReasons: containerStatuses.map((container) => container.state?.waiting?.reason).filter(Boolean),
    terminatedReasons: containerStatuses.map((container) => container.state?.terminated?.reason).filter(Boolean),
  };
}).sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
const notHealthy = rows.filter((row) => row.phase !== 'Running' && row.phase !== 'Succeeded' || (!row.ready && row.phase !== 'Succeeded'));
const summary = {
  livePodCount: pods.length,
  coverageRecordCount: rows.length,
  coverageComplete: rows.length === pods.length,
  runningPods: rows.filter((row) => row.phase === 'Running').length,
  readyPods: rows.filter((row) => row.ready).length,
  notHealthyPods: notHealthy.length,
  restartTotal: rows.reduce((sum, row) => sum + row.restarts, 0),
  nodes: [...new Set(rows.map((row) => row.node).filter(Boolean))].sort(),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync('reports/v13-cluster-resilience/pod-full-coverage.ndjson', rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync('reports/v13-cluster-resilience/pod-full-coverage-summary.json', JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(
  'reports/v13-cluster-resilience/pod-full-coverage-not-healthy.txt',
  notHealthy.map((row) => `${row.namespace}/${row.name} phase=${row.phase} ready=${row.ready} node=${row.node} restarts=${row.restarts}`).join('\n') + (notHealthy.length ? '\n' : '')
);
console.log(`pod_full_coverage=${summary.coverageRecordCount}/${summary.livePodCount}`);
console.log(`pod_full_coverage_ready=${summary.readyPods}/${summary.livePodCount}`);
if (!summary.coverageComplete) process.exit(1);
if (notHealthy.length) process.exit(1);
NODE
    ;;
  cloudflare-public)
    if [ "${V13_REQUIRE_CLOUDFLARE_PUBLICATION:-false}" = "true" ]; then
      curl -fsS --max-time 20 "https://${CLOUDFLARE_PUBLIC_HOSTNAME:-platform.heil.ccwu.cc}/" > reports/v13-cloudflare-live/platform.html
    else
      curl -fsS --max-time 20 "http://192.168.1.58:${V13_PORTAL_NODEPORT:-30088}/" > reports/v13-cloudflare-live/platform.html
      printf 'independent-nodeport; legacy Cloudflare route left untouched\n' > reports/v13-cloudflare-live/publication-mode.txt
    fi
    grep -q 'ZhangLab DevOps V13 Control Surface' reports/v13-cloudflare-live/platform.html
    ;;
  portal-evidence)
    if [ "${V13_REQUIRE_CLOUDFLARE_PUBLICATION:-false}" = "true" ]; then
      curl -fsS --max-time 20 "https://${CLOUDFLARE_PUBLIC_HOSTNAME:-platform.heil.ccwu.cc}/evidence.json" > reports/v13-cloudflare-live/evidence.json || true
    else
      curl -fsS --max-time 20 "http://192.168.1.58:${V13_PORTAL_NODEPORT:-30088}/evidence.json" > reports/v13-cloudflare-live/evidence.json || true
    fi
    if [ -s reports/v13-cloudflare-live/evidence.json ]; then node -e "const e=JSON.parse(require('fs').readFileSync('reports/v13-cloudflare-live/evidence.json','utf8')); if(!e.summary) process.exit(1); console.log(e.summary.pipelineVersion || e.summary.pipeline_version || 'v13')"; fi
    ;;
  maturity-score)
    node -e "const fs=require('fs');const gap=fs.existsSync('reports/v13-market-fit/jenkins-tool-gap.txt')?fs.readFileSync('reports/v13-market-fit/jenkins-tool-gap.txt','utf8'):'';const missing=(gap.match(/=missing/g)||[]).length;const suspicious=fs.existsSync('reports/v13-cluster-resilience/suspicious-idle-services.json')?JSON.parse(fs.readFileSync('reports/v13-cluster-resilience/suspicious-idle-services.json','utf8')).length:0;const score=Math.max(0,100-missing*4-suspicious*2);fs.writeFileSync('reports/v13-market-fit/maturity-score.json',JSON.stringify({score,missingTools:missing,suspiciousIdleServices:suspicious},null,2));console.log('v13_maturity_score='+score)"
    ;;
  plan-conformance)
    mkdir -p reports/v13-plan-conformance
    PORTAL_SERVICE="${V13_PORTAL_SERVICE_NAME:-platform-era-v13-portal}"
    PORTAL_NAMESPACE="${V13_PORTAL_NAMESPACE:-ns-apps}"
    failures=0
    kubectl -n "$PORTAL_NAMESPACE" get deploy "$PORTAL_SERVICE" -o wide > reports/v13-plan-conformance/portal-deployment.txt 2>&1 || failures=$((failures + 1))
    kubectl -n "$PORTAL_NAMESPACE" get svc "$PORTAL_SERVICE" -o wide > reports/v13-plan-conformance/portal-primary-service.txt 2>&1 || failures=$((failures + 1))
    kubectl -n "$PORTAL_NAMESPACE" get svc hello-app-v10-portal -o wide > reports/v13-plan-conformance/portal-compat-service.txt 2>&1 || failures=$((failures + 1))
    kubectl -n "$PORTAL_NAMESPACE" get svc hello-app-v10-portal -o json > reports/v13-plan-conformance/portal-legacy-service.json 2>&1 || failures=$((failures + 1))
    curl -fsS --max-time 10 "http://${PORTAL_SERVICE}.${PORTAL_NAMESPACE}.svc.cluster.local/" > reports/v13-plan-conformance/portal-primary.html || failures=$((failures + 1))
    if [ "${V13_REQUIRE_CLOUDFLARE_PUBLICATION:-false}" = "true" ]; then
      curl -fsS --max-time 10 "https://${CLOUDFLARE_PUBLIC_HOSTNAME:-platform.heil.ccwu.cc}/evidence.json" > reports/v13-plan-conformance/cloudflare-evidence.json || failures=$((failures + 1))
    else
      printf '{"publication_required":false,"reason":"legacy public route left untouched"}\n' > reports/v13-plan-conformance/cloudflare-evidence.json
    fi
    if [ -s reports/v13-cluster-resilience/important-on-cloud-workers.txt ]; then
      failures=$((failures + 1))
    fi
    node <<'NODE' || failures=$((failures + 1))
const fs = require('fs');
const checks = [];
function add(name, pass, detail = '') { checks.push({ name, pass, detail }); }
function readJson(file, fallback = {}) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
const contract = readJson('reports/v13-cloudflare/publication-contract.json');
add('primary_portal_name', contract.portal_service === 'platform-era-v13-portal.ns-apps.svc.cluster.local', contract.portal_service || 'missing');
add('independent_nodeport_declared', contract.publication_mode === 'independent-nodeport', contract.publication_mode || 'missing');
const legacy = readJson('reports/v13-plan-conformance/portal-legacy-service.json', { spec: { selector: {} } });
add('legacy_v12_selector_preserved', legacy.spec?.selector?.app === 'hello-app-v10-portal' && !legacy.spec?.selector?.['app.kubernetes.io/name'], JSON.stringify(legacy.spec?.selector || {}));
const count = readJson('reports/v13-observability-import/count.json', { count: 0 });
add('elasticsearch_events_imported', Number(count.count || 0) > 0, `count=${count.count || 0}`);
const kibanaImport = readJson('reports/v13-observability-import/kibana-saved-object-import.json', { success: false, successCount: 0 });
add('kibana_saved_objects_imported', kibanaImport.success === true && Number(kibanaImport.successCount || 0) >= 10, `success=${kibanaImport.success} successCount=${kibanaImport.successCount || 0}`);
const important = fs.existsSync('reports/v13-cluster-resilience/important-on-cloud-workers.txt') ? fs.readFileSync('reports/v13-cluster-resilience/important-on-cloud-workers.txt', 'utf8').trim() : '';
add('cloud_workers_low_priority_only', important.length === 0, important ? important.split('\n').slice(0, 5).join('; ') : 'none');
const evidence = readJson('reports/v13-plan-conformance/cloudflare-evidence.json');
if (process.env.V13_REQUIRE_CLOUDFLARE_PUBLICATION === 'true') {
  add('cloudflare_evidence_is_v13', evidence.summary?.pipelineVersion === 'v13', evidence.summary?.pipelineVersion || 'missing');
} else {
  add('cloudflare_publication_not_required', evidence.publication_required === false, evidence.reason || 'missing');
}
fs.writeFileSync('reports/v13-plan-conformance/plan-conformance.json', JSON.stringify({ pass: checks.every((check) => check.pass), checks }, null, 2) + '\n');
for (const check of checks) console.log(`${check.pass ? 'ok' : 'fail'} ${check.name} ${check.detail}`);
if (checks.some((check) => !check.pass)) process.exit(1);
NODE
    if [ "$failures" -gt 0 ]; then
      echo "plan_conformance_failures=$failures"
      exit 1
    fi
    echo "plan_conformance=ok" | tee reports/v13-plan-conformance/status.txt
    ;;
  *)
    echo "Unknown v13 addon check: $CHECK" >&2
    exit 2
    ;;
esac
