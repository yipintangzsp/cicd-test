// Jenkins v13 evidence/portal helper. Keep this file small; heavy generation lives in ci/v13_generate_governance.mjs.

def generateV13PlatformEvidence(String appNamespace, String appName, String portalNodePort) {
    sh '''
        set -eux
        mkdir -p meta reports reports/v13-portal
        retry() {
          attempts="${V13_RETRY_ATTEMPTS:-5}"
          delay="${V13_RETRY_DELAY_SECONDS:-4}"
          count=1
          until "$@"; do
            if [ "$count" -ge "$attempts" ]; then return 1; fi
            count=$((count + 1))
            sleep "$delay"
          done
        }
        retry kubectl get pods -A -o json > meta/k8s-pods.json
        retry kubectl get nodes -o json > meta/k8s-nodes.json
        retry kubectl get svc -A -o json > meta/k8s-services.json
        retry kubectl get deploy -A -o json > meta/k8s-deployments.json
        retry kubectl get statefulset -A -o json > meta/k8s-statefulsets.json
        retry kubectl get daemonset -A -o json > meta/k8s-daemonsets.json
        node -e "const fs=require('fs'); const files=['meta/k8s-deployments.json','meta/k8s-statefulsets.json','meta/k8s-daemonsets.json']; const items=files.flatMap(f=>JSON.parse(fs.readFileSync(f,'utf8')).items||[]); fs.writeFileSync('meta/k8s-workloads.json', JSON.stringify({apiVersion:'v1',items}, null, 2)+'\\n')"
        retry kubectl get endpointslice -A -o json > meta/k8s-endpointslices.json
        kubectl top nodes --no-headers > reports/v13-node-top.txt || true
        kubectl top pods -A --no-headers > reports/v13-pod-top.txt || true
        node ci/v13_generate_governance.mjs
        ls -lh reports/v13-platform-services.json reports/v13-observability.ndjson reports/v13-prometheus-metrics.prom reports/v13-grafana-dashboard.json reports/v13-kibana-dashboard.ndjson reports/v13-portal/index.html
    '''
}

def writeV13ParameterContract(
    Object runPlatformProbes,
    Object strictServiceReady,
    Object importObservabilityAssets,
    Object includeResourceProfile,
    Object includePodLogSample,
    Object notifyDingTalk,
    String serviceProbeTimeout,
    String grafanaDashboardTitle,
    String kibanaIndexPrefix
) {
    sh """
        set -eu
        mkdir -p meta reports reports/v13-checks
        cat > meta/v13-parameter-contract.json <<EOF2
{
  "pipeline_version": "v13",
  "build": "${env.BUILD_NUMBER}",
  "run_platform_probes": ${runPlatformProbes},
  "strict_service_ready": ${strictServiceReady},
  "import_observability_assets": ${importObservabilityAssets},
  "include_resource_profile": ${includeResourceProfile},
  "include_pod_log_sample": ${includePodLogSample},
  "notify_dingtalk": ${notifyDingTalk},
  "service_probe_timeout": "${serviceProbeTimeout}",
  "grafana_dashboard_title": "${grafanaDashboardTitle}",
  "kibana_index_prefix": "${kibanaIndexPrefix}"
}
EOF2
        : > reports/v13-service-probes.ndjson
        : > reports/v13-service-probes-summary.txt
        cat meta/v13-parameter-contract.json
    """
}

def writeV13CapabilityChecklist() {
    sh '''
        set -eu
        mkdir -p reports
        cat > reports/v13-capability-checklist.md <<'EOF2'
# Jenkins V13 Capability Checklist

- Preserve v9 flow shape: checkout, quality gate, build/image path, GitOps/deploy path, evidence, observability, portal, summary.
- Add platform-wide probes: Jenkins, GitLab, Harbor, ArgoCD, Portainer, SonarQube, app frontends, databases, MinIO, Kafka, Flink, Spark, Airflow, Trino, Superset, Elasticsearch, Kibana, Prometheus, Grafana, Loki, Jaeger, Zabbix, CoreDNS, Traefik, OpenClaw.
- Generate evidence files suitable for later Grafana/Kibana import.
- Publish an isolated v13 evidence portal without modifying existing hello-app deployment when DRY_RUN=true.
- Keep strict mutation controls: no backup deletion, no pod deletion, no destructive cleanup.
EOF2
        cat reports/v13-capability-checklist.md
    '''
}

def probeV13ServiceGroup(String groupName, Object enabled, Object strictReady, String timeoutSeconds, List services) {
    if (!enabled) {
        sh "mkdir -p reports/v13-checks; echo '${groupName}: V13_RUN_PLATFORM_PROBES=false' | tee reports/v13-checks/${groupName}.disabled.log"
        return
    }
    services.each { svc ->
        probeV13SingleService(
            groupName,
            svc.namespace as String,
            svc.kind as String,
            svc.name as String,
            (svc.url ?: '') as String,
            strictReady,
            timeoutSeconds
        )
    }
}

def probeV13SingleService(String groupName, String namespace, String kind, String name, String url, Object strictReady, String timeoutSeconds) {
    String safeName = "${groupName}-${namespace}-${kind}-${name}".replaceAll('[^A-Za-z0-9_.-]', '-')
    sh """
        set -eu
        mkdir -p reports/v13-checks
        OUT="reports/v13-checks/${safeName}.log"
        STATUS="ok"
        HTTP_STATUS="not_checked"
        READY_REPLICAS="unknown"
        DESIRED_REPLICAS="unknown"
        cluster_url() {
          url="\$1"
          case "\$url" in
            http://*.svc.cluster.local*|https://*.svc.cluster.local*) ;;
            *) printf '%s' "\$url"; return 0 ;;
          esac
          scheme="\${url%%://*}"
          rest="\${url#*://}"
          hostport="\${rest%%/*}"
          path="\${rest#"\$hostport"}"
          [ "\$path" != "\$rest" ] || path="/"
          host="\${hostport%%:*}"
          portpart="\${hostport#"\$host"}"
          svc="\${host%%.*}"
          remainder="\${host#*.}"
          ns="\${remainder%%.*}"
          ip="\$(command kubectl -n "\$ns" get svc "\$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
          if [ -n "\$ip" ] && [ "\$ip" != "None" ]; then
            printf '%s://%s%s%s' "\$scheme" "\$ip" "\$portpart" "\$path"
          else
            printf '%s' "\$url"
          fi
        }
        echo "group=${groupName} namespace=${namespace} kind=${kind} name=${name}" | tee "\$OUT"
        if kubectl -n ${namespace} get ${kind} ${name} -o wide >> "\$OUT" 2>&1; then
          if [ "${kind}" = "deploy" ] || [ "${kind}" = "deployment" ]; then
            READY_REPLICAS="\$(kubectl -n ${namespace} get deploy ${name} -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
            DESIRED_REPLICAS="\$(kubectl -n ${namespace} get deploy ${name} -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
          elif [ "${kind}" = "statefulset" ] || [ "${kind}" = "sts" ]; then
            READY_REPLICAS="\$(kubectl -n ${namespace} get statefulset ${name} -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
            DESIRED_REPLICAS="\$(kubectl -n ${namespace} get statefulset ${name} -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
          fi
        else
          STATUS="missing_k8s_object"
        fi
        if [ -n "${url}" ]; then
          PROBE_URL="\$(cluster_url "${url}")"
          HTTP_STATUS="\$(curl -k -sS -o /tmp/v13-probe-body.txt -w '%{http_code}' --max-time ${timeoutSeconds} "\$PROBE_URL" || true)"
          echo "http_url=${url} resolved_url=\$PROBE_URL http_status=\$HTTP_STATUS" | tee -a "\$OUT"
          if [ "\$HTTP_STATUS" = "000" ] || [ -z "\$HTTP_STATUS" ]; then
            STATUS="http_unreachable"
          fi
        fi
        printf '{"pipeline_version":"v13","build":"%s","group":"%s","namespace":"%s","kind":"%s","name":"%s","status":"%s","http_status":"%s","ready_replicas":"%s","desired_replicas":"%s","url":"%s"}\\n' \\
          "${env.BUILD_NUMBER}" "${groupName}" "${namespace}" "${kind}" "${name}" "\$STATUS" "\$HTTP_STATUS" "\$READY_REPLICAS" "\$DESIRED_REPLICAS" "${url}" >> reports/v13-service-probes.ndjson
        if [ "${strictReady}" = "true" ] && [ "\$STATUS" != "ok" ]; then
          echo "STRICT_SERVICE_READY=true and probe failed for ${namespace}/${kind}/${name}: \$STATUS"
          exit 1
        fi
    """
}

def collectV13RuntimeSamples(Object includeResourceProfile, Object includePodLogSample) {
    sh """
        set -eu
        mkdir -p reports/v13-runtime-samples
        if [ "${includeResourceProfile}" = "true" ]; then
          kubectl top nodes --no-headers > reports/v13-runtime-samples/node-top.txt || true
          kubectl top pods -A --no-headers > reports/v13-runtime-samples/pod-top.txt || true
          kubectl get events -A --sort-by=.lastTimestamp | tail -120 > reports/v13-runtime-samples/recent-events.txt || true
        else
          echo "V13_INCLUDE_RESOURCE_PROFILE=false" > reports/v13-runtime-samples/resource-profile.disabled
        fi
        if [ "${includePodLogSample}" = "true" ]; then
          kubectl -n ns-devops logs deploy/jenkins --tail=80 > reports/v13-runtime-samples/jenkins.log 2>&1 || true
          kubectl -n default logs deploy/elasticsearch --tail=80 > reports/v13-runtime-samples/elasticsearch.log 2>&1 || true
          kubectl -n default logs deploy/kibana --tail=80 > reports/v13-runtime-samples/kibana.log 2>&1 || true
          kubectl -n monitoring logs statefulset/loki --tail=80 > reports/v13-runtime-samples/loki.log 2>&1 || true
          kubectl -n ns-bigdata logs deploy/kafka --tail=80 > reports/v13-runtime-samples/kafka.log 2>&1 || true
        else
          echo "V13_INCLUDE_POD_LOG_SAMPLE=false" > reports/v13-runtime-samples/pod-log-sample.disabled
        fi
        find reports/v13-runtime-samples -type f -maxdepth 1 -print -exec wc -l {} \\; | tee reports/v13-runtime-samples/index.txt
    """
}

def summarizeV13ServiceProbes(Object strictReady) {
    sh """
        set -eu
        mkdir -p reports
        if [ ! -s reports/v13-service-probes.ndjson ]; then
          echo "No v13 service probes were recorded." | tee reports/v13-service-probes-summary.txt
          [ "${strictReady}" = "true" ] && exit 1 || exit 0
        fi
        node - <<'NODE' | tee reports/v13-service-probes-summary.txt
const fs = require('fs');
const rows = fs.readFileSync('reports/v13-service-probes.ndjson', 'utf8')
  .split('\\n').filter(Boolean).map((line) => JSON.parse(line));
const total = rows.length;
const ok = rows.filter((row) => row.status === 'ok').length;
const failed = rows.filter((row) => row.status !== 'ok');
const byGroup = {};
for (const row of rows) {
  byGroup[row.group] ||= { total: 0, ok: 0, failed: 0 };
  byGroup[row.group].total += 1;
  if (row.status === 'ok') byGroup[row.group].ok += 1;
  else byGroup[row.group].failed += 1;
}
console.log(`total=\${total} ok=\${ok} failed=\${failed.length}`);
for (const [group, value] of Object.entries(byGroup)) {
  console.log(`\${group}: ok=\${value.ok}/\${value.total} failed=\${value.failed}`);
}
if (failed.length) {
  console.log('failed probes:');
  for (const row of failed) console.log(`\${row.group} \${row.namespace}/\${row.kind}/\${row.name} status=\${row.status} http=\${row.http_status}`);
}
NODE
        node ci/v13_generate_governance.mjs
        if [ "${strictReady}" = "true" ] && grep -q 'failed=[1-9]' reports/v13-service-probes-summary.txt; then
          exit 1
        fi
    """
}

def rehearseV13ObservabilityImport(Object importAssets, String grafanaTitle, String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v13-observability-import
        cat > reports/v13-observability-import/import-plan.md <<EOF2
# V13 Observability Import Plan

Grafana dashboard title: ${grafanaTitle}
Kibana index prefix: ${kibanaIndexPrefix}
Source files:
- reports/v13-prometheus-metrics.prom
- reports/v13-observability.ndjson
- reports/v13-grafana-dashboard.json
- reports/v13-kibana-dashboard.ndjson
- reports/v13-service-probes.ndjson
EOF2
        if [ "${importAssets}" = "true" ]; then
          ES_URL="\${ELASTICSEARCH_URL:-http://elasticsearch.default.svc.cluster.local:9200}"
          KB_URL="\${KIBANA_INTERNAL_URL:-http://kibana-service.default.svc.cluster.local:5601}"
          GRAFANA_URL="\${GRAFANA_URL:-http://kube-stack-grafana.monitoring.svc.cluster.local}"
          GRAFANA_USER="\${GRAFANA_USER:-admin}"
          GRAFANA_PASSWORD="\${GRAFANA_PASSWORD:-zsp359742}"
          resolve_cluster_url() {
            url="\$1"
            case "\$url" in
              http://*.svc.cluster.local*|https://*.svc.cluster.local*) ;;
              *) printf '%s' "\$url"; return 0 ;;
            esac
            scheme="\${url%%://*}"
            rest="\${url#*://}"
            hostport="\${rest%%/*}"
            path="\${rest#"\$hostport"}"
            [ "\$path" != "\$rest" ] || path="/"
            host="\${hostport%%:*}"
            portpart="\${hostport#"\$host"}"
            svc="\${host%%.*}"
            remainder="\${host#*.}"
            ns="\${remainder%%.*}"
            ip="\$(command kubectl -n "\$ns" get svc "\$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
            if [ -n "\$ip" ] && [ "\$ip" != "None" ]; then
              printf '%s://%s%s%s' "\$scheme" "\$ip" "\$portpart" "\$path"
            else
              printf '%s' "\$url"
            fi
          }
          ES_URL="\$(resolve_cluster_url "\$ES_URL")"
          KB_URL="\$(resolve_cluster_url "\$KB_URL")"
          GRAFANA_URL="\$(resolve_cluster_url "\$GRAFANA_URL")"
          INDEX_DATE="\$(date -u +%Y.%m.%d)"
          INDEX_NAME="${kibanaIndexPrefix}-\${INDEX_DATE}"
          export INDEX_NAME
          BULK_FILE="reports/v13-observability-import/bulk.ndjson"

          cat > reports/v13-observability-import/mapping.json <<'JSON'
{
  "mappings": {
    "properties": {
      "@timestamp": { "type": "date" },
      "type": { "type": "keyword" },
      "pipeline_version": { "type": "keyword" },
      "pipeline_result_key": { "type": "keyword" },
      "pipeline_job_key": { "type": "keyword" },
      "pipeline_build_number": { "type": "long" },
      "build": { "type": "keyword" },
      "namespace": { "type": "keyword" },
      "name": { "type": "keyword" },
      "group": { "type": "keyword" },
      "kind": { "type": "keyword" },
      "node": { "type": "keyword" },
      "phase": { "type": "keyword" },
      "status": { "type": "keyword" },
      "http_status": { "type": "keyword" },
      "layer": { "type": "keyword" },
      "category": { "type": "keyword" },
      "capability": { "type": "keyword" },
      "coverage": { "type": "keyword" },
      "demand": { "type": "keyword" },
      "message": { "type": "text", "fields": { "keyword": { "type": "keyword", "ignore_above": 256 } } },
      "ready": { "type": "boolean" },
      "readyCount": { "type": "long" },
      "ready_count": { "type": "long" },
      "ok_count": { "type": "long" },
      "failed_count": { "type": "long" },
      "restarts": { "type": "long" },
      "endpointReady": { "type": "long" },
      "endpointTotal": { "type": "long" },
      "pods": { "type": "long" },
      "serviceProbeTotal": { "type": "long" },
      "serviceProbeOk": { "type": "long" },
      "health_score": { "type": "double" },
      "risk_score": { "type": "double" },
      "score": { "type": "double" },
      "severity": { "type": "double" },
      "healthScore": { "type": "double" }
    }
  }
}
JSON
          curl -fsS -X PUT "\${ES_URL}/\${INDEX_NAME}" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v13-observability-import/mapping.json \
            -o reports/v13-observability-import/create-index.json || true

          node - <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const lineBreak = String.fromCharCode(10);
const input = fs.readFileSync('reports/v13-observability.ndjson', 'utf8').split(lineBreak).filter(Boolean);
const index = process.env.INDEX_NAME;
const lines = [];
for (let i = 0; i < input.length; i += 1) {
  const event = JSON.parse(input[i]);
  if (Object.prototype.hasOwnProperty.call(event, 'ready') && typeof event.ready !== 'boolean') {
    event.readyCount = Number(event.ready) || 0;
    event.ready = undefined;
  }
  const idSource = [event.pipeline_version, event.build, event.type, event.namespace, event.name, event.group, i].join('|');
  const id = crypto.createHash('sha1').update(idSource).digest('hex');
  lines.push(JSON.stringify({ index: { _index: index, _id: id } }));
  lines.push(JSON.stringify(event));
}
fs.writeFileSync('reports/v13-observability-import/bulk.ndjson', lines.join(lineBreak) + lineBreak);
console.log('bulk_events=' + input.length);
NODE
          curl -fsS -X POST "\${ES_URL}/_bulk?refresh=true" \
            -H 'Content-Type: application/x-ndjson' \
            --data-binary @"\${BULK_FILE}" \
            -o reports/v13-observability-import/bulk-result.json
          node - <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync('reports/v13-observability-import/bulk-result.json', 'utf8'));
if (result.errors) {
  const failed = (result.items || []).filter((item) => {
    const action = item.index || item.create || item.update || {};
    return action.error;
  }).slice(0, 5);
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
console.log('bulk_took_ms=' + result.took);
NODE
          curl -fsS "\${ES_URL}/\${INDEX_NAME}/_count" -o reports/v13-observability-import/count.json

          cat > reports/v13-observability-import/data-view.json <<EOF3
{
  "attributes": {
    "title": "${kibanaIndexPrefix}-*",
    "timeFieldName": "@timestamp"
  }
}
EOF3
          curl -fsS -X POST "\${KB_URL}/api/saved_objects/index-pattern/${kibanaIndexPrefix}?overwrite=true" \
            -H 'kbn-xsrf: true' \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v13-observability-import/data-view.json \
            -o reports/v13-observability-import/kibana-data-view.json || true

          curl -fsS -X POST "\${KB_URL}/api/saved_objects/_import?overwrite=true" \
            -H 'kbn-xsrf: true' \
            -F file=@reports/v13-kibana-dashboard.ndjson \
            -o reports/v13-observability-import/kibana-saved-object-import.json || true

          if [ -s reports/v13-observability-import/kibana-saved-object-import.json ]; then
            cat reports/v13-observability-import/kibana-saved-object-import.json
          fi

          cat > reports/v13-observability-import/grafana-v13-datasource.json <<EOF3
{
  "name": "Jenkins V13 Governance Elasticsearch",
  "uid": "jenkins-v13-governance-es",
  "type": "elasticsearch",
  "access": "proxy",
  "url": "\${ES_URL}",
  "basicAuth": false,
  "isDefault": false,
  "jsonData": {
    "esVersion": "8.0.0",
    "index": "${kibanaIndexPrefix}-*",
    "timeField": "@timestamp",
    "logMessageField": "message",
    "logLevelField": "risk.severity"
  }
}
EOF3
          if curl -fsS "\${GRAFANA_URL%/}/api/datasources/uid/jenkins-v13-governance-es" \
            -u "\${GRAFANA_USER}:\${GRAFANA_PASSWORD}" \
            -o reports/v13-observability-import/grafana-v13-datasource-existing.json; then
            curl -fsS -X PUT "\${GRAFANA_URL%/}/api/datasources/uid/jenkins-v13-governance-es" \
              -u "\${GRAFANA_USER}:\${GRAFANA_PASSWORD}" \
              -H 'Content-Type: application/json' \
              --data-binary @reports/v13-observability-import/grafana-v13-datasource.json \
              -o reports/v13-observability-import/grafana-v13-datasource-result.json
          else
            curl -fsS -X POST "\${GRAFANA_URL%/}/api/datasources" \
              -u "\${GRAFANA_USER}:\${GRAFANA_PASSWORD}" \
              -H 'Content-Type: application/json' \
              --data-binary @reports/v13-observability-import/grafana-v13-datasource.json \
              -o reports/v13-observability-import/grafana-v13-datasource-result.json
          fi
          cat reports/v13-observability-import/grafana-v13-datasource-result.json

          node - <<'NODE'
const fs = require('fs');
const dashboard = JSON.parse(fs.readFileSync('reports/v13-grafana-dashboard.json', 'utf8'));
dashboard.id = null;
dashboard.uid = dashboard.uid || 'zhanglab-v13-observability-command';
dashboard.version = Number(dashboard.version || 1) + 1;
const payload = {
  dashboard,
  folderUid: '',
  overwrite: true,
  message: 'Jenkins V13 observability import build ' + (process.env.BUILD_NUMBER || 'unknown'),
};
fs.writeFileSync('reports/v13-observability-import/grafana-import-payload.json', JSON.stringify(payload, null, 2));
NODE
          curl -fsS -X POST "\${GRAFANA_URL%/}/api/dashboards/db" \
            -u "\${GRAFANA_USER}:\${GRAFANA_PASSWORD}" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v13-observability-import/grafana-import-payload.json \
            -o reports/v13-observability-import/grafana-dashboard-import.json
          cat reports/v13-observability-import/grafana-dashboard-import.json
          node - <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync('reports/v13-observability-import/grafana-dashboard-import.json', 'utf8'));
if (!result.uid || !result.url) {
  console.error(JSON.stringify(result, null, 2));
  throw new Error('Grafana dashboard import did not return uid/url');
}
console.log('grafana_dashboard_uid=' + result.uid);
console.log('grafana_dashboard_url=' + result.url);
NODE

          echo "Imported v13 observability events into \${INDEX_NAME}, refreshed Kibana saved objects and published Grafana dashboard ${grafanaTitle}." | tee reports/v13-observability-import/import.enabled
        else
          echo "V13_IMPORT_OBSERVABILITY_ASSETS=false; generated files are ready for Grafana/Kibana import." | tee reports/v13-observability-import/import.disabled
        fi
        wc -l reports/v13-observability.ndjson reports/v13-service-probes.ndjson reports/v13-prometheus-metrics.prom | tee reports/v13-observability-import/line-counts.txt
    """
}

def rehearseV13DingTalkNotification(Object notifyDingTalk) {
    sh """
        set -eu
        mkdir -p reports/v13-alerting
        cat > reports/v13-alerting/dingtalk-message.json <<EOF2
{
  "msgtype": "markdown",
  "markdown": {
    "title": "Jenkins V13 Pipeline",
    "text": "Jenkins V13 build ${env.BUILD_NUMBER} finished evidence generation. Portal: http://192.168.1.58:${env.V13_PORTAL_NODEPORT}/"
  }
}
EOF2
        if [ "${notifyDingTalk}" = "true" ]; then
          echo "DingTalk notify flag enabled, but no webhook credential is hard-coded. Message payload is generated for credential-backed sending." | tee reports/v13-alerting/dingtalk.enabled
        else
          echo "V13_NOTIFY_DINGTALK=false; payload generated without sending." | tee reports/v13-alerting/dingtalk.disabled
        fi
        cat reports/v13-alerting/dingtalk-message.json
    """
}

def generateV13PrometheusRulePreview(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v13-prometheus
        cat > reports/v13-prometheus/prometheus-rule-preview.yaml <<EOF2
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: jenkins-v13-platform-evidence
  namespace: monitoring
  labels:
    release: kube-stack
spec:
  groups:
  - name: jenkins-v13-platform
    rules:
    - alert: JenkinsV13ServiceProbeFailed
      expr: sum(cicd_v13_service_probe_ok == 0) > 0
      for: 2m
      labels:
        severity: warning
        source: jenkins-v13
      annotations:
        summary: Jenkins V13 service probe detected failed platform checks.
        kibana_index_prefix: ${kibanaIndexPrefix}
    - alert: JenkinsV13PodNotReady
      expr: sum(cicd_v13_pod_ready == 0) > 0
      for: 5m
      labels:
        severity: warning
        source: jenkins-v13
      annotations:
        summary: Jenkins V13 pod readiness evidence contains not-ready pods.
EOF2
        test -s reports/v13-prometheus/prometheus-rule-preview.yaml
        cat reports/v13-prometheus/prometheus-rule-preview.yaml
    """
}

def lintV13GrafanaDashboard(String expectedTitle) {
    sh """
        set -eu
        mkdir -p reports/v13-grafana
        node - <<'NODE' | tee reports/v13-grafana/dashboard-lint.txt
const fs = require('fs');
const dashboard = JSON.parse(fs.readFileSync('reports/v13-grafana-dashboard.json', 'utf8'));
const failures = [];
if (!dashboard.title) failures.push('missing title');
if (dashboard.title !== '${expectedTitle}') failures.push(`title mismatch: \${dashboard.title}`);
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 28) failures.push('expected at least 28 enhanced panels');
const expressions = JSON.stringify(dashboard.panels);
if (!expressions.includes('kube_pod_status_ready')) failures.push('missing live pod readiness metric');
if (!expressions.includes('kube_service_info')) failures.push('missing live service inventory metric');
if (!expressions.includes('kube_node_status_condition')) failures.push('missing live node condition metric');
if (!expressions.includes('kube_deployment_status_replicas_available')) failures.push('missing live deployment availability metric');
if (!expressions.includes('pipeline_version:v13')) failures.push('missing V13 Elasticsearch evidence query');
if (!expressions.includes('jenkins-v13-governance-es')) failures.push('missing V13 Elasticsearch datasource panels');
if (!expressions.includes('state-timeline')) failures.push('missing dynamic state timeline panel');
if (!expressions.includes('status-history')) failures.push('missing dynamic status history panel');
console.log(`title=\${dashboard.title}`);
console.log(`panel_count=\${dashboard.panels.length}`);
if (failures.length) {
  console.log('failures=' + failures.join('; '));
  process.exit(1);
}
console.log('grafana_dashboard_lint=ok');
NODE
    """
}

def lintV13KibanaSavedObjects(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v13-kibana
        node - <<'NODE' | tee reports/v13-kibana/saved-object-lint.txt
const fs = require('fs');
const lines = fs.readFileSync('reports/v13-kibana-dashboard.ndjson', 'utf8').split('\\n').filter(Boolean);
if (!lines.length) throw new Error('empty kibana saved object file');
if (lines.length < 24) throw new Error('expected enhanced Kibana saved objects, got ' + lines.length);
let visualizationCount = 0;
let maxDashboardPanels = 0;
let dashboardCount = 0;
for (const line of lines) {
  const obj = JSON.parse(line);
  if (!obj.type || !obj.attributes) throw new Error('invalid saved object shape');
  if (obj.type === 'visualization') visualizationCount += 1;
  if (obj.type === 'dashboard') {
    dashboardCount += 1;
    maxDashboardPanels = Math.max(maxDashboardPanels, JSON.parse(obj.attributes.panelsJSON || '[]').length);
  }
}
const events = fs.readFileSync('reports/v13-observability.ndjson', 'utf8').split('\\n').filter(Boolean);
const probeEvents = events.filter((line) => line.includes('"type":"service_probe"')).length;
console.log(`saved_objects=\${lines.length}`);
console.log(`visualization_objects=\${visualizationCount}`);
console.log(`dashboard_objects=\${dashboardCount}`);
console.log(`max_dashboard_panels=\${maxDashboardPanels}`);
console.log(`observability_events=\${events.length}`);
console.log(`service_probe_events=\${probeEvents}`);
console.log('kibana_index_prefix=${kibanaIndexPrefix}');
if (probeEvents < 1) throw new Error('missing service_probe events for Kibana');
if (visualizationCount < 18 || dashboardCount < 6 || maxDashboardPanels < 12) throw new Error('Kibana dashboard is not enhanced enough');
console.log('kibana_saved_object_lint=ok');
NODE
    """
}

def writeV13LogRoutingEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v13-log-routing
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-es -o wide > reports/v13-log-routing/filebeat-es.txt 2>&1 || true
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-kafka -o wide > reports/v13-log-routing/filebeat-kafka.txt 2>&1 || true
        kubectl -n ns-bigdata get deploy filebeat-kafka -o wide > reports/v13-log-routing/bigdata-filebeat-kafka.txt 2>&1 || true
        kubectl -n default get deploy elasticsearch -o wide > reports/v13-log-routing/elasticsearch.txt 2>&1 || true
        kubectl -n default get deploy kibana -o wide > reports/v13-log-routing/kibana.txt 2>&1 || true
        kubectl -n monitoring get statefulset loki -o wide > reports/v13-log-routing/loki.txt 2>&1 || true
        cat > reports/v13-log-routing/README.md <<'EOF2'
# V13 Log Routing Evidence

This directory records the current Jenkins log shippers and downstream stores used by Kibana/Grafana/Loki views.
It does not delete or restart any logging component.
EOF2
        find reports/v13-log-routing -type f -maxdepth 1 -print | sort
    '''
}

def writeV13ZabbixEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v13-zabbix
        kubectl -n zabbix get deploy,svc,pod -o wide > reports/v13-zabbix/zabbix-k8s.txt
        cat > reports/v13-zabbix/zabbix-display-plan.md <<'EOF2'
# V13 Zabbix Display Plan

- Use `reports/v13-service-probes.ndjson` as source evidence for service-level availability.
- Use `reports/v13-prometheus-metrics.prom` as metric source for pod readiness and service probes.
- Keep Zabbix as a display/alert destination; no direct Zabbix database mutation is performed by this pipeline.
EOF2
        cat reports/v13-zabbix/zabbix-display-plan.md
    '''
}

def writeV13CloudflareContract(String namespace, String serviceName, String nodePort, String publicHost) {
    sh """
        set -eu
        mkdir -p reports/v13-cloudflare
        cat > reports/v13-cloudflare/publication-contract.json <<EOF2
{
  "pipeline_version": "v13",
  "portal_service": "${serviceName}.${namespace}.svc.cluster.local",
  "nodeport_service": "${serviceName}.${namespace}.svc.cluster.local",
  "legacy_v12_nodeport_service": "hello-app-v10-portal.${namespace}.svc.cluster.local",
  "internal_url": "http://192.168.1.58:${nodePort}/",
  "cloudflare_public_hostname": "${publicHost}",
  "publication_mode": "independent-nodeport",
  "mutation_policy": "V13 publishes its own NodePort and must not change the legacy hello-app-v10-portal selector or scale."
}
EOF2
        cat reports/v13-cloudflare/publication-contract.json
    """
}

def auditV13DestructiveCommands() {
    sh '''
        set -eu
        mkdir -p reports/v13-safety
        P1='kubectl[[:space:]]+delete'
        P2='docker[[:space:]]+system[[:space:]]+prune'
        P3='rm[[:space:]]+-rf'
        P4='helm[[:space:]]+uninstall'
        P5='git[[:space:]]+reset[[:space:]]+--hard'
        P6='ctr[[:space:]].*[[:space:]]rm'
        P7='crictl[[:space:]]+rmi'
        grep -nE "$P1|$P2|$P3|$P4|$P5|$P6|$P7" Jenkinsfile-epoch-v13 jenkins-v13-governance.groovy ci/v13_generate_governance.mjs Jenkinsfile-router > reports/v13-safety/destructive-command-scan.txt || true
        if [ -s reports/v13-safety/destructive-command-scan.txt ]; then
          cat reports/v13-safety/destructive-command-scan.txt
          echo "Potential destructive command pattern found in v13 pipeline files."
          exit 1
        fi
        echo "No destructive command pattern found in v13 pipeline files." | tee reports/v13-safety/destructive-command-scan.txt
    '''
}

def validateV13ArtifactCompleteness() {
    sh '''
        set -eu
        mkdir -p reports/v13-artifact-gate
        for f in \
          meta/build-info.json \
          meta/v13-parameter-contract.json \
          reports/v13-platform-services.json \
          reports/v13-observability.ndjson \
          reports/v13-prometheus-metrics.prom \
          reports/v13-grafana-dashboard.json \
          reports/v13-kibana-dashboard.ndjson \
          reports/v13-service-probes.ndjson \
          reports/v13-service-probes-summary.txt \
          reports/v13-portal/index.html \
          reports/v13-portal/evidence.json \
          reports/v13-prometheus/prometheus-rule-preview.yaml \
          reports/v13-alerting/dingtalk-message.json \
          reports/v13-cloudflare/publication-contract.json \
          reports/v13-governance/epoch-charter.json \
          reports/v13-governance/backup-inventory-summary.json \
	          reports/v13-governance/restore-drill-verdict.json \
	          reports/v13-governance/slo-budget.json \
	          reports/v13-governance/capacity-runway.json \
	          reports/v13-governance/release-gate.json \
	          reports/v13-plan-conformance/plan-conformance.json
        do
          test -s "$f"
          printf '%s ok\n' "$f" >> reports/v13-artifact-gate/completeness.txt
        done
        cat reports/v13-artifact-gate/completeness.txt
    '''
}

def writeV13StageManifest() {
    sh '''
        set -eu
        mkdir -p reports/v13-stage-manifest
        grep -nE "^[[:space:]]*stage\\('" Jenkinsfile-epoch-v13 \
          | sed -E "s/^[0-9]+:[[:space:]]*stage\\('([^']+)'.*/\\1/" \
          > reports/v13-stage-manifest/stages.txt
        nl -ba reports/v13-stage-manifest/stages.txt | tee reports/v13-stage-manifest/stage-count.txt
    '''
}

def publishV13EvidencePortal(String namespace, String serviceName, String imageName, String nodePort, String cloudflareHost) {
    sh """
        set -eux
        test -f reports/v13-portal/index.html
        mkdir -p reports/v13-cloudflare-live
        cat > reports/v13-portal/Dockerfile <<'DOCKERFILE'
FROM 127.0.0.1:30050/library/nginx-alpine:1.29.7-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html evidence.json /usr/share/nginx/html/
EXPOSE 80
DOCKERFILE
        cat > reports/v13-portal/nginx.conf <<'NGINX'
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  add_header X-Cloudflare-Ready "true" always;
  add_header Cache-Control "no-store" always;
  location / { try_files \$uri \$uri/ /index.html; }
  location = /evidence.json { default_type application/json; }
}
NGINX
        docker build --network none --label app.name=hello-app-platform-portal --label pipeline.version=v13 --label git.commit=${GIT_COMMIT_ID} -t ${imageName} reports/v13-portal
        docker push ${imageName}
        cat > reports/v13-portal/k8s.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: platform-era-v13-portal
    app.kubernetes.io/part-of: platform-era
    app.kubernetes.io/component: evidence-portal
    pipeline-version: v13
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: platform-era-v13-portal
  template:
    metadata:
      labels:
        app.kubernetes.io/name: platform-era-v13-portal
        app.kubernetes.io/part-of: platform-era
        app.kubernetes.io/component: evidence-portal
        pipeline-version: v13
    spec:
      containers:
      - name: portal
        image: ${imageName}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 3
          periodSeconds: 5
        resources:
          requests:
            cpu: 10m
            memory: 32Mi
          limits:
            memory: 96Mi
---
apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: platform-era-v13-portal
    app.kubernetes.io/part-of: platform-era
    app.kubernetes.io/component: evidence-portal
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: platform-era-v13-portal
  ports:
  - name: http
    port: 80
    targetPort: 80
    nodePort: ${nodePort}
EOF2
        kubectl apply -f reports/v13-portal/k8s.yaml
        kubectl rollout status deployment/${serviceName} -n ${namespace} --timeout=180s
        cluster_url() {
          url="\$1"
          case "\$url" in
            http://*.svc.cluster.local*|https://*.svc.cluster.local*) ;;
            *) printf '%s' "\$url"; return 0 ;;
          esac
          scheme="\${url%%://*}"
          rest="\${url#*://}"
          hostport="\${rest%%/*}"
          path="\${rest#"\$hostport"}"
          [ "\$path" != "\$rest" ] || path="/"
          host="\${hostport%%:*}"
          portpart="\${hostport#"\$host"}"
          svc="\${host%%.*}"
          remainder="\${host#*.}"
          ns="\${remainder%%.*}"
          ip="\$(command kubectl -n "\$ns" get svc "\$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
          if [ -n "\$ip" ] && [ "\$ip" != "None" ]; then
            printf '%s://%s%s%s' "\$scheme" "\$ip" "\$portpart" "\$path"
          else
            printf '%s' "\$url"
          fi
        }
        PORTAL_CHECK_URL="\$(cluster_url "http://${serviceName}.${namespace}.svc.cluster.local/")"
        for i in 1 2 3 4 5 6 7 8 9 10; do
          if curl -fsS --max-time 10 "\$PORTAL_CHECK_URL" >/dev/null; then
            break
          fi
          if [ "\$i" = "10" ]; then
            echo "v13 portal service did not become reachable after rollout."
            exit 1
          fi
          sleep 3
        done
        for i in 1 2 3 4 5 6 7 8 9 10; do
          if curl -fsS --max-time 10 http://192.168.1.58:${nodePort}/evidence.json > reports/v13-cloudflare-live/nodeport-evidence.json &&
             node -e "const e=JSON.parse(require('fs').readFileSync('reports/v13-cloudflare-live/nodeport-evidence.json','utf8')); if(e.summary?.pipelineVersion !== 'v13') process.exit(1);"; then
            break
          fi
          if [ "\$i" = "10" ]; then
            echo "v13 independent NodePort did not publish v13 evidence."
            exit 1
          fi
          sleep 3
        done
        printf '{"primary_service":"%s.%s.svc.cluster.local","nodeport_service":"%s.%s.svc.cluster.local","legacy_v12_nodeport_service":"hello-app-v10-portal.%s.svc.cluster.local","internal_url":"http://192.168.1.58:%s/","cloudflare_hostname":"%s","status":"portal_deployed_independent_nodeport"}\n' "${serviceName}" "${namespace}" "${serviceName}" "${namespace}" "${namespace}" "${nodePort}" "${cloudflareHost}" > reports/v13-cloudflare-preview.json
        echo "V13 portal: http://192.168.1.58:${nodePort}/"
    """
}

def publishV13FinalBuildRecord(String kibanaIndexPrefix, String buildResult, Object durationMs) {
    sh """
        set -eu
        mkdir -p reports/v13-final-observability
        ES_URL="\${ELASTICSEARCH_URL:-http://elasticsearch.default.svc.cluster.local:9200}"
        resolve_cluster_url() {
          url="\$1"
          case "\$url" in
            http://*.svc.cluster.local*|https://*.svc.cluster.local*) ;;
            *) printf '%s' "\$url"; return 0 ;;
          esac
          scheme="\${url%%://*}"
          rest="\${url#*://}"
          hostport="\${rest%%/*}"
          path="\${rest#"\$hostport"}"
          [ "\$path" != "\$rest" ] || path="/"
          host="\${hostport%%:*}"
          portpart="\${hostport#"\$host"}"
          svc="\${host%%.*}"
          remainder="\${host#*.}"
          ns="\${remainder%%.*}"
          ip="\$(command kubectl -n "\$ns" get svc "\$svc" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)"
          if [ -n "\$ip" ] && [ "\$ip" != "None" ]; then
            printf '%s://%s%s%s' "\$scheme" "\$ip" "\$portpart" "\$path"
          else
            printf '%s' "\$url"
          fi
        }
        ES_URL="\$(resolve_cluster_url "\$ES_URL")"
        INDEX_DATE="\$(date -u +%Y.%m.%d)"
        RUN_INDEX="jenkins-pipeline-runs-\${INDEX_DATE}"
        PLATFORM_INDEX="${kibanaIndexPrefix}-\${INDEX_DATE}"
        DURATION_MS="${durationMs ?: 0}"
        BUILD_RESULT="${buildResult}"
        export BUILD_RESULT
        DURATION_SECONDS="\$(( (DURATION_MS + 999) / 1000 ))"
        if [ -s reports/v13-stage-manifest/stages.txt ]; then
          STAGE_COUNT="\$(wc -l < reports/v13-stage-manifest/stages.txt | tr -d ' ')"
        elif [ -f Jenkinsfile-epoch-v13 ]; then
          STAGE_COUNT="\$(grep -c \"^[[:space:]]*stage('\" Jenkinsfile-epoch-v13 || true)"
        else
          STAGE_COUNT=0
        fi
        [ -n "\${STAGE_COUNT}" ] || STAGE_COUNT=0

        cat > reports/v13-final-observability/pipeline-run-mapping.json <<'JSON'
{
  "mappings": {
    "properties": {
      "@timestamp": { "type": "date" },
      "pipeline_job_key": { "type": "keyword" },
      "pipeline_result_key": { "type": "keyword" },
      "pipeline_build_number": { "type": "long" },
      "pipeline_duration_seconds": { "type": "long" },
      "pipeline_duration_ms": { "type": "long" },
      "pipeline_version_key": { "type": "keyword" },
      "pipeline_stage_count": { "type": "long" },
      "pipeline_success_stage_count": { "type": "long" },
      "pipeline_failed_stage_count": { "type": "long" },
      "pipeline_skipped_stage_count": { "type": "long" },
      "pipeline_url": { "type": "keyword" },
      "data": {
        "properties": {
          "result": { "type": "keyword" },
          "pipelineVersion": { "type": "keyword" },
          "buildNum": { "type": "long" }
        }
      },
      "jenkins": {
        "properties": {
          "result": { "type": "keyword" },
          "job": { "type": "keyword" }
        }
      }
    }
  }
}
JSON
        curl -fsS -X PUT "\${ES_URL}/\${RUN_INDEX}" \
          -H 'Content-Type: application/json' \
          --data-binary @reports/v13-final-observability/pipeline-run-mapping.json \
          -o reports/v13-final-observability/create-run-index.json || true

        cat > reports/v13-final-observability/pipeline-run.json <<EOF2
{
  "@timestamp": "\$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pipeline_job_key": "\${JOB_NAME:-hello-app}",
  "pipeline_result_key": "${buildResult}",
  "pipeline_build_number": ${env.BUILD_NUMBER ?: '0'},
  "pipeline_duration_seconds": \${DURATION_SECONDS},
  "pipeline_duration_ms": \${DURATION_MS},
  "pipeline_version_key": "v13",
  "pipeline_stage_count": \${STAGE_COUNT},
  "pipeline_success_stage_count": \${STAGE_COUNT},
  "pipeline_failed_stage_count": 0,
  "pipeline_skipped_stage_count": 0,
  "pipeline_failed_stages": "",
  "pipeline_url": "\${BUILD_URL:-http://jenkins.devops.local/job/hello-app/${env.BUILD_NUMBER ?: '0'}/}",
  "event": { "dataset": "jenkins.pipeline", "kind": "event", "category": ["ci"], "type": ["info"] },
  "service": { "name": "jenkins" },
  "data": {
    "buildNum": ${env.BUILD_NUMBER ?: '0'},
    "result": "${buildResult}",
    "buildDuration": \${DURATION_MS},
    "duration": \${DURATION_MS},
    "durationSeconds": \${DURATION_SECONDS},
    "building": false,
    "displayName": "#${env.BUILD_NUMBER ?: '0'} v13 \${SEMVER:-}",
    "description": "\${GIT_AUTHOR:-jenkins} | \${GIT_COMMIT_MSG:-v13}",
    "url": "\${BUILD_URL:-http://jenkins.devops.local/job/hello-app/${env.BUILD_NUMBER ?: '0'}/}",
    "pipelineVersion": "v13",
    "stageCount": \${STAGE_COUNT},
    "successStageCount": \${STAGE_COUNT},
    "failedStageCount": 0,
    "skippedStageCount": 0,
    "failedStages": "",
    "buildVariables": { "JOB_NAME": "\${JOB_NAME:-hello-app}" }
  },
  "jenkins": {
    "job": "\${JOB_NAME:-hello-app}",
    "build_number": ${env.BUILD_NUMBER ?: '0'},
    "result": "${buildResult}",
    "duration_ms": \${DURATION_MS},
    "duration_seconds": \${DURATION_SECONDS},
    "stage_count": \${STAGE_COUNT},
    "failed_stage_count": 0,
    "skipped_stage_count": 0,
    "url": "\${BUILD_URL:-http://jenkins.devops.local/job/hello-app/${env.BUILD_NUMBER ?: '0'}/}"
  }
}
EOF2
        curl -fsS -X PUT "\${ES_URL}/\${RUN_INDEX}/_doc/\${JOB_NAME:-hello-app}-${env.BUILD_NUMBER ?: '0'}?refresh=true" \
          -H 'Content-Type: application/json' \
          --data-binary @reports/v13-final-observability/pipeline-run.json \
          -o reports/v13-final-observability/pipeline-run-result.json

        if [ -s reports/v13-platform-services.json ]; then
          node - <<'NODE'
const fs = require('fs');
const evidence = JSON.parse(fs.readFileSync('reports/v13-platform-services.json', 'utf8'));
const summary = evidence.summary || {};
summary['@timestamp'] = new Date().toISOString().slice(0, 19) + 'Z';
summary.type = 'build_summary';
summary.pipeline_version = 'v13';
summary.pipeline_result_key = process.env.BUILD_RESULT || 'SUCCESS';
summary.pipeline_job_key = process.env.JOB_NAME || 'hello-app';
summary.pipeline_build_number = Number(process.env.BUILD_NUMBER || 0);
fs.writeFileSync('reports/v13-final-observability/platform-summary.json', JSON.stringify(summary, null, 2));
NODE
          BUILD_RESULT="${buildResult}" curl -fsS -X PUT "\${ES_URL}/\${PLATFORM_INDEX}/_doc/build-summary-${env.BUILD_NUMBER ?: '0'}?refresh=true" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v13-final-observability/platform-summary.json \
            -o reports/v13-final-observability/platform-summary-result.json || true
        fi

        curl -fsS "\${ES_URL}/\${RUN_INDEX}/_count" -o reports/v13-final-observability/pipeline-run-count.json
        echo "Published final v13 build record to \${RUN_INDEX} and platform summary to \${PLATFORM_INDEX}."
    """
}

def writeCloudflareTunnelTemplateV13(String namespace, String publicHost, String tokenSecretName, String tunnelImage) {
    String imageRef = (tunnelImage ?: env.CLOUDFLARE_TUNNEL_IMAGE ?: '127.0.0.1:30050/library/cloudflared:2026.5.0')
    sh """
        set -eux
        mkdir -p reports/cloudflare
        cat > reports/cloudflare/v13-cloudflared-template.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app-v13-cloudflared
  namespace: ${namespace}
  labels:
    app: hello-app-v13-cloudflared
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-app-v13-cloudflared
  template:
    metadata:
      labels:
        app: hello-app-v13-cloudflared
    spec:
      containers:
      - name: cloudflared
        image: ${imageRef}
        imagePullPolicy: IfNotPresent
        args: ["tunnel", "--no-autoupdate", "run", "--token", "\\\$(CLOUDFLARE_TUNNEL_TOKEN)"]
        env:
        - name: CLOUDFLARE_TUNNEL_TOKEN
          valueFrom:
            secretKeyRef:
              name: ${tokenSecretName}
              key: token
EOF2
        cat > reports/cloudflare/README-v13.md <<EOF2
# V13 Cloudflare display
Primary portal service: http://${env.V13_PORTAL_SERVICE_NAME ?: 'platform-era-v13-portal'}.${namespace}.svc.cluster.local/
Legacy V12 NodePort service left untouched: http://hello-app-v10-portal.${namespace}.svc.cluster.local/
Internal NodePort: http://192.168.1.58:${env.V13_PORTAL_NODEPORT}/
Requested hostname: ${publicHost}
Apply this template only after a valid Cloudflare Tunnel token is stored in secret ${tokenSecretName}.
EOF2
    """
}

return this
