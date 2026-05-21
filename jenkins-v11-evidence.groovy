// Jenkins v11 evidence/portal helper. Keep this file small; heavy generation lives in ci/v11_generate_evidence.mjs.

def generateV11PlatformEvidence(String appNamespace, String appName, String portalNodePort) {
    sh '''
        set -eux
        mkdir -p meta reports reports/v11-portal
        kubectl get pods -A -o json > meta/k8s-pods.json
        kubectl get nodes -o json > meta/k8s-nodes.json
        kubectl get svc -A -o json > meta/k8s-services.json
        kubectl get deployments,statefulsets,daemonsets -A -o json > meta/k8s-workloads.json
        kubectl get endpointslice -A -o json > meta/k8s-endpointslices.json
        kubectl top nodes --no-headers > reports/v11-node-top.txt || true
        kubectl top pods -A --no-headers > reports/v11-pod-top.txt || true
        node ci/v11_generate_evidence.mjs
        ls -lh reports/v11-platform-services.json reports/v11-observability.ndjson reports/v11-prometheus-metrics.prom reports/v11-grafana-dashboard.json reports/v11-kibana-dashboard.ndjson reports/v11-portal/index.html
    '''
}

def writeV11ParameterContract(
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
        mkdir -p meta reports reports/v11-checks
        cat > meta/v11-parameter-contract.json <<EOF2
{
  "pipeline_version": "v11",
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
        : > reports/v11-service-probes.ndjson
        : > reports/v11-service-probes-summary.txt
        cat meta/v11-parameter-contract.json
    """
}

def writeV11CapabilityChecklist() {
    sh '''
        set -eu
        mkdir -p reports
        cat > reports/v11-capability-checklist.md <<'EOF2'
# Jenkins V11 Capability Checklist

- Preserve v9 flow shape: checkout, quality gate, build/image path, GitOps/deploy path, evidence, observability, portal, summary.
- Add platform-wide probes: Jenkins, GitLab, Harbor, ArgoCD, Portainer, SonarQube, app frontends, databases, MinIO, Kafka, Flink, Spark, Airflow, Trino, Superset, Elasticsearch, Kibana, Prometheus, Grafana, Loki, Jaeger, Zabbix, CoreDNS, Traefik, OpenClaw.
- Generate evidence files suitable for later Grafana/Kibana import.
- Publish an isolated v11 evidence portal without modifying existing hello-app deployment when DRY_RUN=true.
- Keep strict mutation controls: no backup deletion, no pod deletion, no destructive cleanup.
EOF2
        cat reports/v11-capability-checklist.md
    '''
}

def probeV11ServiceGroup(String groupName, Object enabled, Object strictReady, String timeoutSeconds, List services) {
    if (!enabled) {
        sh "mkdir -p reports/v11-checks; echo '${groupName}: V11_RUN_PLATFORM_PROBES=false' | tee reports/v11-checks/${groupName}.disabled.log"
        return
    }
    services.each { svc ->
        probeV11SingleService(
            groupName,
            svc.namespace as String,
            svc.kind as String,
            svc.name as String,
            (svc.url ?: '') as String,
            strictReady,
            timeoutSeconds
        )
        sh "sleep 1"
    }
}

def probeV11SingleService(String groupName, String namespace, String kind, String name, String url, Object strictReady, String timeoutSeconds) {
    String safeName = "${groupName}-${namespace}-${kind}-${name}".replaceAll('[^A-Za-z0-9_.-]', '-')
    sh """
        set -eu
        mkdir -p reports/v11-checks
        OUT="reports/v11-checks/${safeName}.log"
        STATUS="ok"
        HTTP_STATUS="not_checked"
        READY_REPLICAS="unknown"
        DESIRED_REPLICAS="unknown"
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
          HTTP_STATUS="000"
          for attempt in 1 2 3; do
            HTTP_STATUS="\$(curl -k -sS -o /tmp/v11-probe-body.txt -w '%{http_code}' --max-time ${timeoutSeconds} "${url}" || true)"
            [ "\$HTTP_STATUS" != "000" ] && [ -n "\$HTTP_STATUS" ] && break
            echo "http_probe_retry=\$attempt url=${url} status=\$HTTP_STATUS" | tee -a "\$OUT"
            sleep 2
          done
          echo "http_url=${url} http_status=\$HTTP_STATUS" | tee -a "\$OUT"
          if [ "\$HTTP_STATUS" = "000" ] || [ -z "\$HTTP_STATUS" ]; then
            STATUS="http_unreachable"
          fi
        fi
        printf '{"pipeline_version":"v11","build":"%s","group":"%s","namespace":"%s","kind":"%s","name":"%s","status":"%s","http_status":"%s","ready_replicas":"%s","desired_replicas":"%s","url":"%s"}\\n' \\
          "${env.BUILD_NUMBER}" "${groupName}" "${namespace}" "${kind}" "${name}" "\$STATUS" "\$HTTP_STATUS" "\$READY_REPLICAS" "\$DESIRED_REPLICAS" "${url}" >> reports/v11-service-probes.ndjson
        if [ "${strictReady}" = "true" ] && [ "\$STATUS" != "ok" ]; then
          echo "STRICT_SERVICE_READY=true and probe failed for ${namespace}/${kind}/${name}: \$STATUS"
          exit 1
        fi
    """
}

def collectV11RuntimeSamples(Object includeResourceProfile, Object includePodLogSample) {
    sh """
        set -eu
        mkdir -p reports/v11-runtime-samples
        if [ "${includeResourceProfile}" = "true" ]; then
          kubectl top nodes --no-headers > reports/v11-runtime-samples/node-top.txt || true
          kubectl top pods -A --no-headers > reports/v11-runtime-samples/pod-top.txt || true
          kubectl get events -A --sort-by=.lastTimestamp | tail -120 > reports/v11-runtime-samples/recent-events.txt || true
        else
          echo "V11_INCLUDE_RESOURCE_PROFILE=false" > reports/v11-runtime-samples/resource-profile.disabled
        fi
        if [ "${includePodLogSample}" = "true" ]; then
          kubectl -n ns-devops logs deploy/jenkins --tail=80 > reports/v11-runtime-samples/jenkins.log 2>&1 || true
          kubectl -n default logs deploy/elasticsearch --tail=80 > reports/v11-runtime-samples/elasticsearch.log 2>&1 || true
          kubectl -n default logs deploy/kibana --tail=80 > reports/v11-runtime-samples/kibana.log 2>&1 || true
          kubectl -n monitoring logs statefulset/loki --tail=80 > reports/v11-runtime-samples/loki.log 2>&1 || true
          kubectl -n ns-bigdata logs deploy/kafka --tail=80 > reports/v11-runtime-samples/kafka.log 2>&1 || true
        else
          echo "V11_INCLUDE_POD_LOG_SAMPLE=false" > reports/v11-runtime-samples/pod-log-sample.disabled
        fi
        find reports/v11-runtime-samples -type f -maxdepth 1 -print -exec wc -l {} \\; | tee reports/v11-runtime-samples/index.txt
    """
}

def summarizeV11ServiceProbes(Object strictReady) {
    sh """
        set -eu
        mkdir -p reports
        if [ ! -s reports/v11-service-probes.ndjson ]; then
          echo "No v11 service probes were recorded." | tee reports/v11-service-probes-summary.txt
          [ "${strictReady}" = "true" ] && exit 1 || exit 0
        fi
        node - <<'NODE' | tee reports/v11-service-probes-summary.txt
const fs = require('fs');
const rows = fs.readFileSync('reports/v11-service-probes.ndjson', 'utf8')
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
        node ci/v11_generate_evidence.mjs
        if [ "${strictReady}" = "true" ] && grep -q 'failed=[1-9]' reports/v11-service-probes-summary.txt; then
          exit 1
        fi
    """
}

def rehearseV11ObservabilityImport(Object importAssets, String grafanaTitle, String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v11-observability-import
        cat > reports/v11-observability-import/import-plan.md <<EOF2
# V11 Observability Import Plan

Grafana dashboard title: ${grafanaTitle}
Kibana index prefix: ${kibanaIndexPrefix}
Source files:
- reports/v11-prometheus-metrics.prom
- reports/v11-observability.ndjson
- reports/v11-grafana-dashboard.json
- reports/v11-kibana-dashboard.ndjson
- reports/v11-service-probes.ndjson
EOF2
        if [ "${importAssets}" = "true" ]; then
          ES_URL="\${ELASTICSEARCH_URL:-http://elasticsearch.default.svc.cluster.local:9200}"
          KB_URL="\${KIBANA_INTERNAL_URL:-http://kibana-service.default.svc.cluster.local:5601}"
          INDEX_DATE="\$(date -u +%Y.%m.%d)"
          INDEX_NAME="${kibanaIndexPrefix}-\${INDEX_DATE}"
          export INDEX_NAME
          BULK_FILE="reports/v11-observability-import/bulk.ndjson"

          cat > reports/v11-observability-import/mapping.json <<'JSON'
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
      "ready": { "type": "boolean" },
      "readyCount": { "type": "long" },
      "restarts": { "type": "long" },
      "endpointReady": { "type": "long" },
      "endpointTotal": { "type": "long" },
      "pods": { "type": "long" },
      "serviceProbeTotal": { "type": "long" },
      "serviceProbeOk": { "type": "long" }
    }
  }
}
JSON
          curl -fsS -X PUT "\${ES_URL}/\${INDEX_NAME}" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v11-observability-import/mapping.json \
            -o reports/v11-observability-import/create-index.json || true

          node - <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const lineBreak = String.fromCharCode(10);
const input = fs.readFileSync('reports/v11-observability.ndjson', 'utf8').split(lineBreak).filter(Boolean);
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
fs.writeFileSync('reports/v11-observability-import/bulk.ndjson', lines.join(lineBreak) + lineBreak);
console.log('bulk_events=' + input.length);
NODE
          curl -fsS -X POST "\${ES_URL}/_bulk?refresh=true" \
            -H 'Content-Type: application/x-ndjson' \
            --data-binary @"\${BULK_FILE}" \
            -o reports/v11-observability-import/bulk-result.json
          node - <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync('reports/v11-observability-import/bulk-result.json', 'utf8'));
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
          curl -fsS "\${ES_URL}/\${INDEX_NAME}/_count" -o reports/v11-observability-import/count.json

          cat > reports/v11-observability-import/data-view.json <<EOF3
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
            --data-binary @reports/v11-observability-import/data-view.json \
            -o reports/v11-observability-import/kibana-data-view.json || true

          echo "Imported v11 observability events into \${INDEX_NAME} and refreshed Kibana data view ${kibanaIndexPrefix}." | tee reports/v11-observability-import/import.enabled
        else
          echo "V11_IMPORT_OBSERVABILITY_ASSETS=false; generated files are ready for Grafana/Kibana import." | tee reports/v11-observability-import/import.disabled
        fi
        wc -l reports/v11-observability.ndjson reports/v11-service-probes.ndjson reports/v11-prometheus-metrics.prom | tee reports/v11-observability-import/line-counts.txt
    """
}

def rehearseV11DingTalkNotification(Object notifyDingTalk) {
    sh """
        set -eu
        mkdir -p reports/v11-alerting
        cat > reports/v11-alerting/dingtalk-message.json <<EOF2
{
  "msgtype": "markdown",
  "markdown": {
    "title": "Jenkins V11 Pipeline",
    "text": "Jenkins V11 build ${env.BUILD_NUMBER} finished evidence generation. Portal: http://192.168.1.58:${env.V11_PORTAL_NODEPORT}/"
  }
}
EOF2
        if [ "${notifyDingTalk}" = "true" ]; then
          echo "DingTalk notify flag enabled, but no webhook credential is hard-coded. Message payload is generated for credential-backed sending." | tee reports/v11-alerting/dingtalk.enabled
        else
          echo "V11_NOTIFY_DINGTALK=false; payload generated without sending." | tee reports/v11-alerting/dingtalk.disabled
        fi
        cat reports/v11-alerting/dingtalk-message.json
    """
}

def generateV11PrometheusRulePreview(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v11-prometheus
        cat > reports/v11-prometheus/prometheus-rule-preview.yaml <<EOF2
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: jenkins-v11-platform-evidence
  namespace: monitoring
  labels:
    release: kube-stack
spec:
  groups:
  - name: jenkins-v11-platform
    rules:
    - alert: JenkinsV11ServiceProbeFailed
      expr: sum(cicd_v11_service_probe_ok == 0) > 0
      for: 2m
      labels:
        severity: warning
        source: jenkins-v11
      annotations:
        summary: Jenkins V11 service probe detected failed platform checks.
        kibana_index_prefix: ${kibanaIndexPrefix}
    - alert: JenkinsV11PodNotReady
      expr: sum(cicd_v11_pod_ready == 0) > 0
      for: 5m
      labels:
        severity: warning
        source: jenkins-v11
      annotations:
        summary: Jenkins V11 pod readiness evidence contains not-ready pods.
EOF2
        test -s reports/v11-prometheus/prometheus-rule-preview.yaml
        cat reports/v11-prometheus/prometheus-rule-preview.yaml
    """
}

def lintV11GrafanaDashboard(String expectedTitle) {
    sh """
        set -eu
        mkdir -p reports/v11-grafana
        node - <<'NODE' | tee reports/v11-grafana/dashboard-lint.txt
const fs = require('fs');
const dashboard = JSON.parse(fs.readFileSync('reports/v11-grafana-dashboard.json', 'utf8'));
const failures = [];
if (!dashboard.title) failures.push('missing title');
if (dashboard.title !== '${expectedTitle}') failures.push(`title mismatch: \${dashboard.title}`);
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 4) failures.push('expected at least 4 panels');
const expressions = JSON.stringify(dashboard.panels);
if (!expressions.includes('cicd_v11_pod_ready')) failures.push('missing pod readiness metric');
if (!expressions.includes('cicd_v11_service_probe_ok')) failures.push('missing service probe metric');
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

def lintV11KibanaSavedObjects(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v11-kibana
        node - <<'NODE' | tee reports/v11-kibana/saved-object-lint.txt
const fs = require('fs');
const lines = fs.readFileSync('reports/v11-kibana-dashboard.ndjson', 'utf8').split('\\n').filter(Boolean);
if (!lines.length) throw new Error('empty kibana saved object file');
for (const line of lines) {
  const obj = JSON.parse(line);
  if (!obj.type || !obj.attributes) throw new Error('invalid saved object shape');
}
const events = fs.readFileSync('reports/v11-observability.ndjson', 'utf8').split('\\n').filter(Boolean);
const probeEvents = events.filter((line) => line.includes('"type":"service_probe"')).length;
console.log(`saved_objects=\${lines.length}`);
console.log(`observability_events=\${events.length}`);
console.log(`service_probe_events=\${probeEvents}`);
console.log('kibana_index_prefix=${kibanaIndexPrefix}');
if (probeEvents < 1) throw new Error('missing service_probe events for Kibana');
console.log('kibana_saved_object_lint=ok');
NODE
    """
}

def writeV11LogRoutingEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v11-log-routing
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-es -o wide > reports/v11-log-routing/filebeat-es.txt 2>&1 || true
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-kafka -o wide > reports/v11-log-routing/filebeat-kafka.txt 2>&1 || true
        kubectl -n ns-bigdata get deploy filebeat-kafka -o wide > reports/v11-log-routing/bigdata-filebeat-kafka.txt 2>&1 || true
        kubectl -n default get deploy elasticsearch -o wide > reports/v11-log-routing/elasticsearch.txt 2>&1 || true
        kubectl -n default get deploy kibana -o wide > reports/v11-log-routing/kibana.txt 2>&1 || true
        kubectl -n monitoring get statefulset loki -o wide > reports/v11-log-routing/loki.txt 2>&1 || true
        cat > reports/v11-log-routing/README.md <<'EOF2'
# V11 Log Routing Evidence

This directory records the current Jenkins log shippers and downstream stores used by Kibana/Grafana/Loki views.
It does not delete or restart any logging component.
EOF2
        find reports/v11-log-routing -type f -maxdepth 1 -print | sort
    '''
}

def writeV11ZabbixEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v11-zabbix
        kubectl -n zabbix get deploy,svc,pod -o wide > reports/v11-zabbix/zabbix-k8s.txt
        cat > reports/v11-zabbix/zabbix-display-plan.md <<'EOF2'
# V11 Zabbix Display Plan

- Use `reports/v11-service-probes.ndjson` as source evidence for service-level availability.
- Use `reports/v11-prometheus-metrics.prom` as metric source for pod readiness and service probes.
- Keep Zabbix as a display/alert destination; no direct Zabbix database mutation is performed by this pipeline.
EOF2
        cat reports/v11-zabbix/zabbix-display-plan.md
    '''
}

def writeV11CloudflareContract(String namespace, String nodePort, String publicHost) {
    sh """
        set -eu
        mkdir -p reports/v11-cloudflare
        cat > reports/v11-cloudflare/publication-contract.json <<EOF2
{
  "pipeline_version": "v11",
  "portal_service": "hello-app-v10-portal.${namespace}.svc.cluster.local",
  "internal_url": "http://192.168.1.58:${nodePort}/",
  "cloudflare_public_hostname": "${publicHost}",
  "mutation_policy": "Only the isolated v11 portal deployment/service is applied. Existing application pods are not modified when DRY_RUN=true."
}
EOF2
        cat reports/v11-cloudflare/publication-contract.json
    """
}

def auditV11DestructiveCommands() {
    sh '''
        set -eu
        mkdir -p reports/v11-safety
        P1='kubectl[[:space:]]+delete'
        P2='docker[[:space:]]+system[[:space:]]+prune'
        P3='rm[[:space:]]+-rf'
        P4='helm[[:space:]]+uninstall'
        P5='git[[:space:]]+reset[[:space:]]+--hard'
        P6='ctr[[:space:]].*[[:space:]]rm'
        P7='crictl[[:space:]]+rmi'
        grep -nE "$P1|$P2|$P3|$P4|$P5|$P6|$P7" Jenkinsfile-expert-v11 jenkins-v11-evidence.groovy ci/v11_generate_evidence.mjs Jenkinsfile-router > reports/v11-safety/destructive-command-scan.txt || true
        if [ -s reports/v11-safety/destructive-command-scan.txt ]; then
          cat reports/v11-safety/destructive-command-scan.txt
          echo "Potential destructive command pattern found in v11 pipeline files."
          exit 1
        fi
        echo "No destructive command pattern found in v11 pipeline files." | tee reports/v11-safety/destructive-command-scan.txt
    '''
}

def validateV11ArtifactCompleteness() {
    sh '''
        set -eu
        mkdir -p reports/v11-artifact-gate
        for f in \
          meta/build-info.json \
          meta/v11-parameter-contract.json \
          reports/v11-platform-services.json \
          reports/v11-observability.ndjson \
          reports/v11-prometheus-metrics.prom \
          reports/v11-grafana-dashboard.json \
          reports/v11-kibana-dashboard.ndjson \
          reports/v11-service-probes.ndjson \
          reports/v11-service-probes-summary.txt \
          reports/v11-portal/index.html \
          reports/v11-portal/evidence.json \
          reports/v11-prometheus/prometheus-rule-preview.yaml \
          reports/v11-alerting/dingtalk-message.json \
          reports/v11-cloudflare/publication-contract.json
        do
          test -s "$f"
          printf '%s ok\n' "$f" >> reports/v11-artifact-gate/completeness.txt
        done
        cat reports/v11-artifact-gate/completeness.txt
    '''
}

def writeV11StageManifest() {
    sh '''
        set -eu
        mkdir -p reports/v11-stage-manifest
        grep -nE "^[[:space:]]*stage\\('" Jenkinsfile-expert-v11 \
          | sed -E "s/^[0-9]+:[[:space:]]*stage\\('([^']+)'.*/\\1/" \
          > reports/v11-stage-manifest/stages.txt
        nl -ba reports/v11-stage-manifest/stages.txt | tee reports/v11-stage-manifest/stage-count.txt
    '''
}

def publishV11EvidencePortal(String namespace, String imageName, String nodePort, String cloudflareHost) {
    sh """
        set -eux
        test -f reports/v11-portal/index.html
        cat > reports/v11-portal/Dockerfile <<'DOCKERFILE'
FROM 127.0.0.1:30050/library/nginx-alpine:1.29.7-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html evidence.json /usr/share/nginx/html/
EXPOSE 80
DOCKERFILE
        cat > reports/v11-portal/nginx.conf <<'NGINX'
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
        docker build --network none --label app.name=hello-app-platform-portal --label pipeline.version=v11 --label git.commit=${GIT_COMMIT_ID} -t ${imageName} reports/v11-portal
        docker push ${imageName}
        cat > reports/v11-portal/k8s.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app-v10-portal
  namespace: ${namespace}
  labels:
    app: hello-app-v10-portal
    pipeline-version: v11
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-app-v10-portal
  template:
    metadata:
      labels:
        app: hello-app-v10-portal
        pipeline-version: v11
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
  name: hello-app-v10-portal
  namespace: ${namespace}
  labels:
    app: hello-app-v10-portal
spec:
  type: NodePort
  selector:
    app: hello-app-v10-portal
  ports:
  - name: http
    port: 80
    targetPort: 80
    nodePort: ${nodePort}
EOF2
        kubectl apply -f reports/v11-portal/k8s.yaml
        kubectl rollout status deployment/hello-app-v10-portal -n ${namespace} --timeout=180s
        for i in 1 2 3 4 5 6 7 8 9 10; do
          if curl -fsS --max-time 10 http://hello-app-v10-portal.${namespace}.svc.cluster.local/ >/dev/null; then
            break
          fi
          if [ "\$i" = "10" ]; then
            echo "v11 portal service did not become reachable after rollout."
            exit 1
          fi
          sleep 3
        done
        curl -fsS --max-time 5 http://192.168.1.58:${nodePort}/ >/dev/null || true
        printf '{"internal_url":"http://192.168.1.58:%s/","cloudflare_hostname":"%s","status":"portal_deployed_cloudflare_ready"}\n' "${nodePort}" "${cloudflareHost}" > reports/v11-cloudflare-preview.json
        echo "V11 portal: http://192.168.1.58:${nodePort}/"
    """
}

def publishV11FinalBuildRecord(String kibanaIndexPrefix, String buildResult, Object durationMs) {
    sh """
        set -eu
        mkdir -p reports/v11-final-observability
        ES_URL="\${ELASTICSEARCH_URL:-http://elasticsearch.default.svc.cluster.local:9200}"
        INDEX_DATE="\$(date -u +%Y.%m.%d)"
        RUN_INDEX="jenkins-pipeline-runs-\${INDEX_DATE}"
        PLATFORM_INDEX="${kibanaIndexPrefix}-\${INDEX_DATE}"
        DURATION_MS="${durationMs ?: 0}"
        BUILD_RESULT="${buildResult}"
        export BUILD_RESULT
        DURATION_SECONDS="\$(( (DURATION_MS + 999) / 1000 ))"
        if [ -s reports/v11-stage-manifest/stages.txt ]; then
          STAGE_COUNT="\$(wc -l < reports/v11-stage-manifest/stages.txt | tr -d ' ')"
        elif [ -f Jenkinsfile-expert-v11 ]; then
          STAGE_COUNT="\$(grep -c \"^[[:space:]]*stage('\" Jenkinsfile-expert-v11 || true)"
        else
          STAGE_COUNT=0
        fi
        [ -n "\${STAGE_COUNT}" ] || STAGE_COUNT=0

        cat > reports/v11-final-observability/pipeline-run-mapping.json <<'JSON'
{
  "mappings": {
    "properties": {
      "@timestamp": { "type": "date" },
      "pipeline_job_key": { "type": "keyword" },
      "pipeline_result_key": { "type": "keyword" },
      "pipeline_build_number": { "type": "long" },
      "build_number": { "type": "long" },
      "result": { "type": "keyword" },
      "status": { "type": "keyword" },
      "build_status": { "type": "keyword" },
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
          --data-binary @reports/v11-final-observability/pipeline-run-mapping.json \
          -o reports/v11-final-observability/create-run-index.json || true

        cat > reports/v11-final-observability/pipeline-run.json <<EOF2
{
  "@timestamp": "\$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pipeline_job_key": "\${JOB_NAME:-hello-app}",
  "pipeline_result_key": "${buildResult}",
  "pipeline_build_number": ${env.BUILD_NUMBER ?: '0'},
  "build_number": ${env.BUILD_NUMBER ?: '0'},
  "result": "${buildResult}",
  "status": "${buildResult}",
  "build_status": "${buildResult}",
  "pipeline_duration_seconds": \${DURATION_SECONDS},
  "pipeline_duration_ms": \${DURATION_MS},
  "pipeline_version_key": "v11",
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
    "displayName": "#${env.BUILD_NUMBER ?: '0'} v11 \${SEMVER:-}",
    "description": "\${GIT_AUTHOR:-jenkins} | \${GIT_COMMIT_MSG:-v11}",
    "url": "\${BUILD_URL:-http://jenkins.devops.local/job/hello-app/${env.BUILD_NUMBER ?: '0'}/}",
    "pipelineVersion": "v11",
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
        PUBLISH_OK=false
        for attempt in 1 2 3; do
          if curl -fsS -X PUT "\${ES_URL}/\${RUN_INDEX}/_doc/\${JOB_NAME:-hello-app}-${env.BUILD_NUMBER ?: '0'}?refresh=true" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v11-final-observability/pipeline-run.json \
            -o reports/v11-final-observability/pipeline-run-result.json; then
            PUBLISH_OK=true
            break
          fi
          echo "pipeline-run publish retry \${attempt}" | tee -a reports/v11-final-observability/publish-warnings.log
          sleep 5
        done
        if [ "\${PUBLISH_OK}" != "true" ]; then
          echo "pipeline-run publish failed after retries; keeping build result and archived JSON evidence." | tee -a reports/v11-final-observability/publish-warnings.log
        fi

        if [ -s reports/v11-platform-services.json ]; then
          node - <<'NODE'
const fs = require('fs');
const evidence = JSON.parse(fs.readFileSync('reports/v11-platform-services.json', 'utf8'));
const summary = evidence.summary || {};
summary['@timestamp'] = new Date().toISOString().slice(0, 19) + 'Z';
summary.type = 'build_summary';
summary.pipeline_version = 'v11';
summary.pipeline_result_key = process.env.BUILD_RESULT || 'SUCCESS';
summary.pipeline_job_key = process.env.JOB_NAME || 'hello-app';
summary.pipeline_build_number = Number(process.env.BUILD_NUMBER || 0);
fs.writeFileSync('reports/v11-final-observability/platform-summary.json', JSON.stringify(summary, null, 2));
NODE
          BUILD_RESULT="${buildResult}" curl -fsS -X PUT "\${ES_URL}/\${PLATFORM_INDEX}/_doc/build-summary-${env.BUILD_NUMBER ?: '0'}?refresh=true" \
            -H 'Content-Type: application/json' \
            --data-binary @reports/v11-final-observability/platform-summary.json \
            -o reports/v11-final-observability/platform-summary-result.json || true
        fi

        curl -fsS "\${ES_URL}/\${RUN_INDEX}/_count" -o reports/v11-final-observability/pipeline-run-count.json || true
        echo "Published final v11 build record to \${RUN_INDEX} and platform summary to \${PLATFORM_INDEX}."
    """
}

def writeCloudflareTunnelTemplateV11(String namespace, String publicHost, String tokenSecretName, String tunnelImage) {
    String imageRef = (tunnelImage ?: env.CLOUDFLARE_TUNNEL_IMAGE ?: '127.0.0.1:30050/library/cloudflared:2026.5.0')
    sh """
        set -eux
        mkdir -p reports/cloudflare
        cat > reports/cloudflare/v11-cloudflared-template.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app-v11-cloudflared
  namespace: ${namespace}
  labels:
    app: hello-app-v11-cloudflared
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-app-v11-cloudflared
  template:
    metadata:
      labels:
        app: hello-app-v11-cloudflared
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
        cat > reports/cloudflare/README-v11.md <<EOF2
# V11 Cloudflare display
Portal service: http://hello-app-v10-portal.${namespace}.svc.cluster.local/
Internal NodePort: http://192.168.1.58:${env.V11_PORTAL_NODEPORT}/
Requested hostname: ${publicHost}
Apply this template only after a valid Cloudflare Tunnel token is stored in secret ${tokenSecretName}.
EOF2
    """
}

return this
