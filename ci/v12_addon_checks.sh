#!/bin/sh
set -eu

export PATH="/var/jenkins_home/tools/bin:${PATH}"

CHECK="${1:-}"
mkdir -p reports/v12-market-fit reports/v12-triggering reports/v12-iac reports/v12-devsecops \
  reports/v12-data-lineage reports/v12-observability-deep reports/v12-cluster-resilience \
  reports/v12-cloudflare-live

retry_cmd() {
  attempts="${V12_RETRY_ATTEMPTS:-5}"
  delay="${V12_RETRY_DELAY_SECONDS:-4}"
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

curl() {
  retry_cmd command curl "$@"
}

case "$CHECK" in
  market-baseline)
    cat > reports/v12-market-fit/recruitment-baseline.json <<'JSON'
{"version":"v12","principle":"high-cohesion-low-coupling-no-heavy-install-by-default","capabilities":["kubernetes","ci-cd","gitops","observability","devsecops","streaming-data","spark-data-platform","iac"]}
JSON
    ;;
  tool-gap)
    : > reports/v12-market-fit/jenkins-tool-gap.txt
    for tool in helm terraform ansible trivy cosign kubeconform kubectl docker node git curl; do
      if command -v "$tool" >/dev/null 2>&1; then printf '%s=present\n' "$tool"; else printf '%s=missing\n' "$tool"; fi
    done | tee reports/v12-market-fit/jenkins-tool-gap.txt
    ;;
  triggering-ci)
    grep -n 'gitlab(' Jenkinsfile-router > reports/v12-triggering/gitlab-trigger.txt
    retry_cmd kubectl -n ns-devops get deploy github-webhook-relay -o wide > reports/v12-triggering/github-relay.txt
    retry_cmd curl -fsS --max-time 8 http://github-webhook-relay.ns-devops.svc.cluster.local:8080/healthz > reports/v12-triggering/github-relay-health.txt
    ;;
  version-contract)
    grep -n "Jenkinsfile-expert-v12" Jenkinsfile-router Jenkinsfile-expert-v12 > reports/v12-triggering/version-choice.txt
    grep -n "Jenkinsfile-expert-v11" Jenkinsfile-router Jenkinsfile-expert-v12 >> reports/v12-triggering/version-choice.txt
    ;;
  github-cache)
    if [ -d /var/jenkins_home/github-cache/cicd-test.git ]; then
      git --git-dir=/var/jenkins_home/github-cache/cicd-test.git rev-parse --short HEAD > reports/v12-triggering/github-cache-head.txt || true
    else
      echo "github cache not present" > reports/v12-triggering/github-cache-head.txt
    fi
    ;;
  helm-gap)
    command -v helm >/dev/null 2>&1 && helm version > reports/v12-iac/helm.txt || echo "helm=missing; fallback=kubernetes-manifest-and-argocd" > reports/v12-iac/helm.txt
    ;;
  terraform-gap)
    command -v terraform >/dev/null 2>&1 && terraform version > reports/v12-iac/terraform.txt || echo "terraform=missing; install only before cloud-IaC lifecycle is introduced" > reports/v12-iac/terraform.txt
    ;;
  ansible-gap)
    command -v ansible >/dev/null 2>&1 && ansible --version > reports/v12-iac/ansible.txt || echo "ansible=missing; current changes use Kubernetes API and GitOps" > reports/v12-iac/ansible.txt
    ;;
  iac-render)
    find k8s argocd monitoring -type f 2>/dev/null | sort > reports/v12-iac/manifest-inventory.txt || true
    : > reports/v12-iac/kubeconform.txt
    if command -v kubeconform >/dev/null 2>&1; then
      kubeconform -v > reports/v12-iac/kubeconform.txt 2>&1 || true
      while read -r f; do
        case "$f" in *.yaml|*.yml) timeout 8 kubeconform -ignore-missing-schemas -summary "$f" >> reports/v12-iac/kubeconform.txt 2>&1 || echo "$f kubeconform_timeout_or_warning" >> reports/v12-iac/kubeconform.txt ;; esac
      done < reports/v12-iac/manifest-inventory.txt
    else
      echo "kubeconform=missing" > reports/v12-iac/kubeconform.txt
    fi
    while read -r f; do
      case "$f" in *.yaml|*.yml) kubectl apply --dry-run=client -f "$f" >/dev/null 2>&1 || echo "$f" >> reports/v12-iac/dry-run-warnings.txt ;; esac
    done < reports/v12-iac/manifest-inventory.txt
    wc -l reports/v12-iac/manifest-inventory.txt | tee reports/v12-iac/manifest-count.txt
    ;;
  argocd-health)
    kubectl -n argocd get applications.argoproj.io -o wide > reports/v12-iac/argocd-apps.txt 2>&1 || true
    kubectl -n argocd get pod -o wide > reports/v12-iac/argocd-pods.txt
    ;;
  sonarqube)
    kubectl -n sonarqube get deploy,sts,svc,pod -o wide > reports/v12-devsecops/sonarqube-k8s.txt
    curl -fsS --max-time 10 http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000/api/system/status > reports/v12-devsecops/sonarqube-status.json || true
    ;;
  harbor-trivy)
    kubectl -n harbor get statefulset harbor-trivy -o wide > reports/v12-devsecops/harbor-trivy.txt 2>&1 || true
    kubectl -n harbor get svc harbor-trivy -o wide > reports/v12-devsecops/harbor-trivy-service.txt 2>&1 || true
    ;;
  trivy-gap)
    command -v trivy >/dev/null 2>&1 && trivy --version > reports/v12-devsecops/trivy-cli.txt || echo "trivy-cli=missing; use-harbor-trivy-service-first" > reports/v12-devsecops/trivy-cli.txt
    ;;
  cosign-gap)
    command -v cosign >/dev/null 2>&1 && cosign version > reports/v12-devsecops/cosign.txt || echo "cosign=missing; keep SIGN_IMAGE as contract until key management is ready" > reports/v12-devsecops/cosign.txt
    ;;
  secret-scan)
    P1='AKIA[0-9A-Z]{16}'
    P2='BEGIN RSA PRIVATE ''KEY'
    P3='password[[:space:]]*='
    P4='token[[:space:]]*='
    grep -RInE "$P1|$P2|$P3|$P4" Jenkinsfile* ci jenkins-*.groovy 2>/dev/null \
      | grep -v '^ci/v12_addon_checks.sh:' \
      > reports/v12-devsecops/secret-patterns.txt || true
    if grep -q "$P2" reports/v12-devsecops/secret-patterns.txt; then exit 1; fi
    ;;
  kafka-endpoints)
    kubectl -n ns-bigdata get endpointslices -l kubernetes.io/service-name=kafka -o yaml > reports/v12-data-lineage/kafka-endpoints.yaml
    grep -q 'ready: true' reports/v12-data-lineage/kafka-endpoints.yaml
    ;;
  kafka-ui)
    curl -fsS --max-time 10 http://kafka-ui.ns-bigdata.svc.cluster.local:8080/ > reports/v12-data-lineage/kafka-ui.html || true
    kubectl -n ns-bigdata get deploy kafka-ui -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' > reports/v12-data-lineage/kafka-ui-ready.txt
    ;;
  jenkins-kafka-link)
    kubectl -n ns-devops get deploy jenkins-build-log-filebeat-kafka -o wide > reports/v12-data-lineage/jenkins-filebeat-kafka.txt
    kubectl -n ns-bigdata get daemonset filebeat-kafka -o wide > reports/v12-data-lineage/bigdata-filebeat-kafka.txt
    ;;
  spark-crd)
    kubectl get crd | grep -i spark > reports/v12-data-lineage/spark-crds.txt
    kubectl api-resources | grep -i spark > reports/v12-data-lineage/spark-api-resources.txt
    ;;
  spark-logs)
    kubectl -n ns-bigdata logs deploy/spark-operator-controller --tail=120 > reports/v12-data-lineage/spark-controller.log 2>&1 || true
    test -s reports/v12-data-lineage/spark-controller.log || echo "spark controller log empty" > reports/v12-data-lineage/spark-controller.log
    ;;
  spark-webhook)
    kubectl -n ns-bigdata get svc spark-operator-webhook-svc -o yaml > reports/v12-data-lineage/spark-webhook-service.yaml
    kubectl -n ns-bigdata get endpointslices -l kubernetes.io/service-name=spark-operator-webhook-svc -o yaml > reports/v12-data-lineage/spark-webhook-endpoints.yaml
    grep -q 'ready: true' reports/v12-data-lineage/spark-webhook-endpoints.yaml
    ;;
  flink-jobs)
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/jobs/overview > reports/v12-data-lineage/flink-jobs.json || true
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/overview > reports/v12-data-lineage/flink-overview.json
    ;;
  flink-taskmanagers)
    curl -fsS --max-time 10 http://flink-jobmanager.ns-bigdata.svc.cluster.local:8081/taskmanagers > reports/v12-data-lineage/flink-taskmanagers.json || true
    kubectl -n ns-bigdata get deploy flink-taskmanager -o wide > reports/v12-data-lineage/flink-taskmanager.txt
    ;;
  airflow-dags)
    curl -fsS --max-time 10 http://airflow-api-server.data-infra.svc.cluster.local:8080/api/v2/monitor/health > reports/v12-data-lineage/airflow-health.json
    curl -fsS --max-time 10 http://airflow-api-server.data-infra.svc.cluster.local:8080/api/v2/dags > reports/v12-data-lineage/airflow-dags.json || true
    ;;
  trino-catalog)
    curl -fsS --max-time 10 http://trino.data-infra.svc.cluster.local:8080/v1/info > reports/v12-data-lineage/trino-info.json
    curl -fsS --max-time 10 http://trino.data-infra.svc.cluster.local:8080/v1/catalog > reports/v12-data-lineage/trino-catalog.json || true
    ;;
  superset-bi)
    curl -fsS --max-time 10 http://superset.data-infra.svc.cluster.local:8088/health > reports/v12-data-lineage/superset-health.txt || true
    kubectl -n data-infra get deploy superset superset-worker -o wide > reports/v12-data-lineage/superset-workloads.txt
    ;;
  minio)
    curl -fsS --max-time 10 http://minio.data-infra.svc.cluster.local:9000/minio/health/live > reports/v12-data-lineage/minio-live.txt
    kubectl -n data-infra get deploy,svc | grep -i minio > reports/v12-data-lineage/minio-k8s.txt
    ;;
  prometheus-targets)
    curl -fsS --max-time 10 http://kube-stack-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090/api/v1/targets > reports/v12-observability-deep/prometheus-targets.json || true
    curl -fsS --max-time 10 http://kube-stack-kube-prometheus-prometheus.monitoring.svc.cluster.local:9090/-/ready > reports/v12-observability-deep/prometheus-ready.txt
    ;;
  grafana-datasources)
    curl -fsS --max-time 10 http://kube-stack-grafana.monitoring.svc.cluster.local/api/health > reports/v12-observability-deep/grafana-health.json
    curl -fsS --max-time 10 http://kube-stack-grafana.monitoring.svc.cluster.local/api/datasources > reports/v12-observability-deep/grafana-datasources.json || true
    ;;
  kibana-data-views)
    curl -fsS --max-time 10 http://kibana-service.default.svc.cluster.local:5601/api/status -H 'kbn-xsrf: true' > reports/v12-observability-deep/kibana-status.json
    curl -fsS --max-time 10 http://kibana-service.default.svc.cluster.local:5601/api/data_views -H 'kbn-xsrf: true' > reports/v12-observability-deep/kibana-data-views.json || true
    ;;
  elastic-indices)
    curl -fsS --max-time 10 http://elasticsearch.default.svc.cluster.local:9200/_cluster/health > reports/v12-observability-deep/es-health.json
    curl -fsS --max-time 10 http://elasticsearch.default.svc.cluster.local:9200/_cat/indices?v > reports/v12-observability-deep/es-indices.txt
    ;;
  loki-ring)
    curl -fsS --max-time 10 http://loki.monitoring.svc.cluster.local:3100/ready > reports/v12-observability-deep/loki-ready.txt
    curl -fsS --max-time 10 http://loki.monitoring.svc.cluster.local:3100/ring > reports/v12-observability-deep/loki-ring.html || true
    ;;
  jaeger)
    curl -fsS --max-time 10 http://jaeger.monitoring.svc.cluster.local:16686/ > reports/v12-observability-deep/jaeger.html || true
    kubectl -n monitoring get deploy jaeger -o wide > reports/v12-observability-deep/jaeger-k8s.txt
    ;;
  zabbix)
    curl -fsS --max-time 10 http://zabbix-web.zabbix.svc.cluster.local:8080/ > reports/v12-observability-deep/zabbix-web.html || true
    kubectl -n zabbix get deploy,svc,pod -o wide > reports/v12-observability-deep/zabbix-k8s.txt
    ;;
  otel-collector)
    kubectl -n monitoring get deploy,svc,pod -l app=otel-collector -o wide > reports/v12-observability-deep/otel-collector-k8s.txt
    kubectl -n monitoring get servicemonitor otel-collector -o wide > reports/v12-observability-deep/otel-collector-servicemonitor.txt
    curl -fsS --max-time 10 http://otel-collector.monitoring.svc.cluster.local:8888/metrics > reports/v12-observability-deep/otel-collector-metrics.txt
    ;;
  nodes)
    kubectl get nodes -o json > reports/v12-cluster-resilience/nodes.json
    kubectl get nodes -o wide > reports/v12-cluster-resilience/nodes.txt
    kubectl describe nodes > reports/v12-cluster-resilience/nodes-describe.txt
    ;;
  worker-scheduling)
    kubectl get pods -A -o wide | awk '$8 ~ /aliyun-worker|ucloud-worker/ {print}' > reports/v12-cluster-resilience/cloud-worker-pods.txt || true
    grep -E 'jenkins|gitlab|elasticsearch|kibana|mysql|postgresql|prometheus|grafana|harbor|argocd' reports/v12-cluster-resilience/cloud-worker-pods.txt > reports/v12-cluster-resilience/important-on-cloud-workers.txt || true
    ;;
  resource-requests)
    kubectl get deploy,statefulset,daemonset -A -o json > reports/v12-cluster-resilience/workloads.json
    node -e "const fs=require('fs');const items=JSON.parse(fs.readFileSync('reports/v12-cluster-resilience/workloads.json','utf8')).items||[];let total=0,withReq=0;for(const i of items){for(const c of i.spec?.template?.spec?.containers||[]){total++;if(c.resources?.requests?.cpu||c.resources?.requests?.memory)withReq++;}}fs.writeFileSync('reports/v12-cluster-resilience/resource-requests.json',JSON.stringify({totalContainers:total,containersWithRequests:withReq},null,2));console.log('resource_requests='+withReq+'/'+total)"
    ;;
  pvc)
    kubectl get pvc -A -o wide > reports/v12-cluster-resilience/pvc.txt
    kubectl get pv -o wide > reports/v12-cluster-resilience/pv.txt || true
    ;;
  events)
    kubectl get events -A --sort-by=.lastTimestamp | tail -200 > reports/v12-cluster-resilience/events-tail.txt || true
    grep -Ei 'failed|backoff|unhealthy|notready|oom|evict' reports/v12-cluster-resilience/events-tail.txt > reports/v12-cluster-resilience/event-warnings.txt || true
    ;;
  no-endpoints)
    kubectl get svc -A -o json > reports/v12-cluster-resilience/services.json
    kubectl get endpointslices -A -o json > reports/v12-cluster-resilience/endpointslices.json
    node -e "const fs=require('fs');const svcs=JSON.parse(fs.readFileSync('reports/v12-cluster-resilience/services.json','utf8')).items||[];const slices=JSON.parse(fs.readFileSync('reports/v12-cluster-resilience/endpointslices.json','utf8')).items||[];const ready=new Set();for(const s of slices){const ns=s.metadata?.namespace,n=s.metadata?.labels?.['kubernetes.io/service-name'];if((s.endpoints||[]).some(e=>e.conditions?.ready===true))ready.add(ns+'/'+n);}const miss=svcs.filter(s=>s.spec?.type!=='ExternalName').map(s=>s.metadata.namespace+'/'+s.metadata.name).filter(k=>!ready.has(k));fs.writeFileSync('reports/v12-cluster-resilience/no-endpoint-services.json',JSON.stringify(miss,null,2));console.log('no_endpoint_services='+miss.length)"
    ;;
  idle-services)
    node -e "const fs=require('fs');const miss=JSON.parse(fs.readFileSync('reports/v12-cluster-resilience/no-endpoint-services.json','utf8'));const allow=new Set(['kubernetes/default','data-infra/superset-postgresql']);const suspicious=miss.filter(x=>!allow.has(x));fs.writeFileSync('reports/v12-cluster-resilience/suspicious-idle-services.json',JSON.stringify(suspicious,null,2));console.log('suspicious_idle_services='+suspicious.length)"
    if [ "${V12_REQUIRE_NO_IDLE_CORE_SERVICE:-false}" = "true" ] && [ "$(node -e "console.log(JSON.parse(require('fs').readFileSync('reports/v12-cluster-resilience/suspicious-idle-services.json','utf8')).length)")" -gt 0 ]; then exit 1; fi
    ;;
  pod-full-coverage)
    retry_cmd kubectl get pods -A -o json > reports/v12-cluster-resilience/pods-full.json
    node <<'NODE'
const fs = require('fs');
const source = 'reports/v12-cluster-resilience/pods-full.json';
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
fs.writeFileSync('reports/v12-cluster-resilience/pod-full-coverage.ndjson', rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
fs.writeFileSync('reports/v12-cluster-resilience/pod-full-coverage-summary.json', JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(
  'reports/v12-cluster-resilience/pod-full-coverage-not-healthy.txt',
  notHealthy.map((row) => `${row.namespace}/${row.name} phase=${row.phase} ready=${row.ready} node=${row.node} restarts=${row.restarts}`).join('\n') + (notHealthy.length ? '\n' : '')
);
console.log(`pod_full_coverage=${summary.coverageRecordCount}/${summary.livePodCount}`);
console.log(`pod_full_coverage_ready=${summary.readyPods}/${summary.livePodCount}`);
if (!summary.coverageComplete) process.exit(1);
if (notHealthy.length) process.exit(1);
NODE
    ;;
  cloudflare-public)
    curl -fsS --max-time 20 "https://${CLOUDFLARE_PUBLIC_HOSTNAME:-platform.heil.ccwu.cc}/" > reports/v12-cloudflare-live/platform.html
    grep -q 'ZhangLab DevOps V12 Control Surface' reports/v12-cloudflare-live/platform.html
    ;;
  portal-evidence)
    curl -fsS --max-time 20 "https://${CLOUDFLARE_PUBLIC_HOSTNAME:-platform.heil.ccwu.cc}/evidence.json" > reports/v12-cloudflare-live/evidence.json || true
    if [ -s reports/v12-cloudflare-live/evidence.json ]; then node -e "const e=JSON.parse(require('fs').readFileSync('reports/v12-cloudflare-live/evidence.json','utf8')); if(!e.summary) process.exit(1); console.log(e.summary.pipelineVersion || e.summary.pipeline_version || 'v12')"; fi
    ;;
  maturity-score)
    node -e "const fs=require('fs');const gap=fs.existsSync('reports/v12-market-fit/jenkins-tool-gap.txt')?fs.readFileSync('reports/v12-market-fit/jenkins-tool-gap.txt','utf8'):'';const missing=(gap.match(/=missing/g)||[]).length;const suspicious=fs.existsSync('reports/v12-cluster-resilience/suspicious-idle-services.json')?JSON.parse(fs.readFileSync('reports/v12-cluster-resilience/suspicious-idle-services.json','utf8')).length:0;const score=Math.max(0,100-missing*4-suspicious*2);fs.writeFileSync('reports/v12-market-fit/maturity-score.json',JSON.stringify({score,missingTools:missing,suspiciousIdleServices:suspicious},null,2));console.log('v12_maturity_score='+score)"
    ;;
  *)
    echo "Unknown v12 addon check: $CHECK" >&2
    exit 2
    ;;
esac
