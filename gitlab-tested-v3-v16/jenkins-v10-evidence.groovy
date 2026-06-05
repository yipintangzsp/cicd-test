// Jenkins v10 evidence/portal helper. Keep this file small; heavy generation lives in ci/v10_generate_evidence.mjs.

def generateV10PlatformEvidence(String appNamespace, String appName, String portalNodePort) {
    sh '''
        set -eux
        mkdir -p meta reports reports/v10-portal
        kubectl get pods -A -o json > meta/k8s-pods.json
        kubectl get svc -A -o json > meta/k8s-services.json
        kubectl get deployments,statefulsets,daemonsets -A -o json > meta/k8s-workloads.json
        kubectl get endpointslice -A -o json > meta/k8s-endpointslices.json
        kubectl top nodes --no-headers > reports/v10-node-top.txt || true
        kubectl top pods -A --no-headers > reports/v10-pod-top.txt || true
        node ci/v10_generate_evidence.mjs
        ls -lh reports/v10-platform-services.json reports/v10-observability.ndjson reports/v10-prometheus-metrics.prom reports/v10-grafana-dashboard.json reports/v10-kibana-dashboard.ndjson reports/v10-portal/index.html
    '''
}

def writeV10ParameterContract(
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
        mkdir -p meta reports reports/v10-checks
        cat > meta/v10-parameter-contract.json <<EOF2
{
  "pipeline_version": "v10",
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
        : > reports/v10-service-probes.ndjson
        : > reports/v10-service-probes-summary.txt
        cat meta/v10-parameter-contract.json
    """
}

def writeV10CapabilityChecklist() {
    sh '''
        set -eu
        mkdir -p reports
        cat > reports/v10-capability-checklist.md <<'EOF2'
# Jenkins V10 Capability Checklist

- Preserve v9 flow shape: checkout, quality gate, build/image path, GitOps/deploy path, evidence, observability, portal, summary.
- Add platform-wide probes: Jenkins, GitLab, Harbor, ArgoCD, Portainer, SonarQube, app frontends, databases, MinIO, Kafka, Flink, Spark, Airflow, Trino, Superset, Elasticsearch, Kibana, Prometheus, Grafana, Loki, Jaeger, Zabbix, CoreDNS, Traefik, OpenClaw.
- Generate evidence files suitable for later Grafana/Kibana import.
- Publish an isolated v10 evidence portal without modifying existing hello-app deployment when DRY_RUN=true.
- Keep strict mutation controls: no backup deletion, no pod deletion, no destructive cleanup.
EOF2
        cat reports/v10-capability-checklist.md
    '''
}

def probeV10ServiceGroup(String groupName, Object enabled, Object strictReady, String timeoutSeconds, List services) {
    if (!enabled) {
        sh "mkdir -p reports/v10-checks; echo '${groupName}: V10_RUN_PLATFORM_PROBES=false' | tee reports/v10-checks/${groupName}.disabled.log"
        return
    }
    services.each { svc ->
        probeV10SingleService(
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

def probeV10SingleService(String groupName, String namespace, String kind, String name, String url, Object strictReady, String timeoutSeconds) {
    String safeName = "${groupName}-${namespace}-${kind}-${name}".replaceAll('[^A-Za-z0-9_.-]', '-')
    sh """
        set -eu
        mkdir -p reports/v10-checks
        OUT="reports/v10-checks/${safeName}.log"
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
          HTTP_STATUS="\$(curl -k -sS -o /tmp/v10-probe-body.txt -w '%{http_code}' --max-time ${timeoutSeconds} "${url}" || true)"
          echo "http_url=${url} http_status=\$HTTP_STATUS" | tee -a "\$OUT"
          if [ "\$HTTP_STATUS" = "000" ] || [ -z "\$HTTP_STATUS" ]; then
            STATUS="http_unreachable"
          fi
        fi
        printf '{"pipeline_version":"v10","build":"%s","group":"%s","namespace":"%s","kind":"%s","name":"%s","status":"%s","http_status":"%s","ready_replicas":"%s","desired_replicas":"%s","url":"%s"}\\n' \\
          "${env.BUILD_NUMBER}" "${groupName}" "${namespace}" "${kind}" "${name}" "\$STATUS" "\$HTTP_STATUS" "\$READY_REPLICAS" "\$DESIRED_REPLICAS" "${url}" >> reports/v10-service-probes.ndjson
        if [ "${strictReady}" = "true" ] && [ "\$STATUS" != "ok" ]; then
          echo "STRICT_SERVICE_READY=true and probe failed for ${namespace}/${kind}/${name}: \$STATUS"
          exit 1
        fi
    """
}

def collectV10RuntimeSamples(Object includeResourceProfile, Object includePodLogSample) {
    sh """
        set -eu
        mkdir -p reports/v10-runtime-samples
        if [ "${includeResourceProfile}" = "true" ]; then
          kubectl top nodes --no-headers > reports/v10-runtime-samples/node-top.txt || true
          kubectl top pods -A --no-headers > reports/v10-runtime-samples/pod-top.txt || true
          kubectl get events -A --sort-by=.lastTimestamp | tail -120 > reports/v10-runtime-samples/recent-events.txt || true
        else
          echo "V10_INCLUDE_RESOURCE_PROFILE=false" > reports/v10-runtime-samples/resource-profile.disabled
        fi
        if [ "${includePodLogSample}" = "true" ]; then
          kubectl -n ns-devops logs deploy/jenkins --tail=80 > reports/v10-runtime-samples/jenkins.log 2>&1 || true
          kubectl -n default logs deploy/elasticsearch --tail=80 > reports/v10-runtime-samples/elasticsearch.log 2>&1 || true
          kubectl -n default logs deploy/kibana --tail=80 > reports/v10-runtime-samples/kibana.log 2>&1 || true
          kubectl -n monitoring logs statefulset/loki --tail=80 > reports/v10-runtime-samples/loki.log 2>&1 || true
          kubectl -n ns-bigdata logs deploy/kafka --tail=80 > reports/v10-runtime-samples/kafka.log 2>&1 || true
        else
          echo "V10_INCLUDE_POD_LOG_SAMPLE=false" > reports/v10-runtime-samples/pod-log-sample.disabled
        fi
        find reports/v10-runtime-samples -type f -maxdepth 1 -print -exec wc -l {} \\; | tee reports/v10-runtime-samples/index.txt
    """
}

def summarizeV10ServiceProbes(Object strictReady) {
    sh """
        set -eu
        mkdir -p reports
        if [ ! -s reports/v10-service-probes.ndjson ]; then
          echo "No v10 service probes were recorded." | tee reports/v10-service-probes-summary.txt
          [ "${strictReady}" = "true" ] && exit 1 || exit 0
        fi
        node - <<'NODE' | tee reports/v10-service-probes-summary.txt
const fs = require('fs');
const rows = fs.readFileSync('reports/v10-service-probes.ndjson', 'utf8')
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
        node ci/v10_generate_evidence.mjs
        if [ "${strictReady}" = "true" ] && grep -q 'failed=[1-9]' reports/v10-service-probes-summary.txt; then
          exit 1
        fi
    """
}

def rehearseV10ObservabilityImport(Object importAssets, String grafanaTitle, String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v10-observability-import
        cat > reports/v10-observability-import/import-plan.md <<EOF2
# V10 Observability Import Plan

Grafana dashboard title: ${grafanaTitle}
Kibana index prefix: ${kibanaIndexPrefix}
Source files:
- reports/v10-prometheus-metrics.prom
- reports/v10-observability.ndjson
- reports/v10-grafana-dashboard.json
- reports/v10-kibana-dashboard.ndjson
- reports/v10-service-probes.ndjson
EOF2
        if [ "${importAssets}" = "true" ]; then
          echo "Import flag enabled. Current implementation validates assets and records import plan; direct mutation remains gated." | tee reports/v10-observability-import/import.enabled
        else
          echo "V10_IMPORT_OBSERVABILITY_ASSETS=false; generated files are ready for Grafana/Kibana import." | tee reports/v10-observability-import/import.disabled
        fi
        wc -l reports/v10-observability.ndjson reports/v10-service-probes.ndjson reports/v10-prometheus-metrics.prom | tee reports/v10-observability-import/line-counts.txt
    """
}

def rehearseV10DingTalkNotification(Object notifyDingTalk) {
    sh """
        set -eu
        mkdir -p reports/v10-alerting
        cat > reports/v10-alerting/dingtalk-message.json <<EOF2
{
  "msgtype": "markdown",
  "markdown": {
    "title": "Jenkins V10 Pipeline",
    "text": "Jenkins V10 build ${env.BUILD_NUMBER} finished evidence generation. Portal: http://192.168.1.58:${env.V10_PORTAL_NODEPORT}/"
  }
}
EOF2
        if [ "${notifyDingTalk}" = "true" ]; then
          echo "DingTalk notify flag enabled, but no webhook credential is hard-coded. Message payload is generated for credential-backed sending." | tee reports/v10-alerting/dingtalk.enabled
        else
          echo "V10_NOTIFY_DINGTALK=false; payload generated without sending." | tee reports/v10-alerting/dingtalk.disabled
        fi
        cat reports/v10-alerting/dingtalk-message.json
    """
}

def generateV10PrometheusRulePreview(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v10-prometheus
        cat > reports/v10-prometheus/prometheus-rule-preview.yaml <<EOF2
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: jenkins-v10-platform-evidence
  namespace: monitoring
  labels:
    release: kube-stack
spec:
  groups:
  - name: jenkins-v10-platform
    rules:
    - alert: JenkinsV10ServiceProbeFailed
      expr: sum(cicd_v10_service_probe_ok == 0) > 0
      for: 2m
      labels:
        severity: warning
        source: jenkins-v10
      annotations:
        summary: Jenkins V10 service probe detected failed platform checks.
        kibana_index_prefix: ${kibanaIndexPrefix}
    - alert: JenkinsV10PodNotReady
      expr: sum(cicd_v10_pod_ready == 0) > 0
      for: 5m
      labels:
        severity: warning
        source: jenkins-v10
      annotations:
        summary: Jenkins V10 pod readiness evidence contains not-ready pods.
EOF2
        test -s reports/v10-prometheus/prometheus-rule-preview.yaml
        cat reports/v10-prometheus/prometheus-rule-preview.yaml
    """
}

def lintV10GrafanaDashboard(String expectedTitle) {
    sh """
        set -eu
        mkdir -p reports/v10-grafana
        node - <<'NODE' | tee reports/v10-grafana/dashboard-lint.txt
const fs = require('fs');
const dashboard = JSON.parse(fs.readFileSync('reports/v10-grafana-dashboard.json', 'utf8'));
const failures = [];
if (!dashboard.title) failures.push('missing title');
if (dashboard.title !== '${expectedTitle}') failures.push(`title mismatch: \${dashboard.title}`);
if (!Array.isArray(dashboard.panels) || dashboard.panels.length < 4) failures.push('expected at least 4 panels');
const expressions = JSON.stringify(dashboard.panels);
if (!expressions.includes('cicd_v10_pod_ready')) failures.push('missing pod readiness metric');
if (!expressions.includes('cicd_v10_service_probe_ok')) failures.push('missing service probe metric');
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

def lintV10KibanaSavedObjects(String kibanaIndexPrefix) {
    sh """
        set -eu
        mkdir -p reports/v10-kibana
        node - <<'NODE' | tee reports/v10-kibana/saved-object-lint.txt
const fs = require('fs');
const lines = fs.readFileSync('reports/v10-kibana-dashboard.ndjson', 'utf8').split('\\n').filter(Boolean);
if (!lines.length) throw new Error('empty kibana saved object file');
for (const line of lines) {
  const obj = JSON.parse(line);
  if (!obj.type || !obj.attributes) throw new Error('invalid saved object shape');
}
const events = fs.readFileSync('reports/v10-observability.ndjson', 'utf8').split('\\n').filter(Boolean);
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

def writeV10LogRoutingEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v10-log-routing
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-es -o wide > reports/v10-log-routing/filebeat-es.txt 2>&1 || true
        kubectl -n ns-devops get deploy jenkins-build-log-filebeat-kafka -o wide > reports/v10-log-routing/filebeat-kafka.txt 2>&1 || true
        kubectl -n ns-bigdata get deploy filebeat-kafka -o wide > reports/v10-log-routing/bigdata-filebeat-kafka.txt 2>&1 || true
        kubectl -n default get deploy elasticsearch -o wide > reports/v10-log-routing/elasticsearch.txt 2>&1 || true
        kubectl -n default get deploy kibana -o wide > reports/v10-log-routing/kibana.txt 2>&1 || true
        kubectl -n monitoring get statefulset loki -o wide > reports/v10-log-routing/loki.txt 2>&1 || true
        cat > reports/v10-log-routing/README.md <<'EOF2'
# V10 Log Routing Evidence

This directory records the current Jenkins log shippers and downstream stores used by Kibana/Grafana/Loki views.
It does not delete or restart any logging component.
EOF2
        find reports/v10-log-routing -type f -maxdepth 1 -print | sort
    '''
}

def writeV10ZabbixEvidence() {
    sh '''
        set -eu
        mkdir -p reports/v10-zabbix
        kubectl -n zabbix get deploy,svc,pod -o wide > reports/v10-zabbix/zabbix-k8s.txt
        cat > reports/v10-zabbix/zabbix-display-plan.md <<'EOF2'
# V10 Zabbix Display Plan

- Use `reports/v10-service-probes.ndjson` as source evidence for service-level availability.
- Use `reports/v10-prometheus-metrics.prom` as metric source for pod readiness and service probes.
- Keep Zabbix as a display/alert destination; no direct Zabbix database mutation is performed by this pipeline.
EOF2
        cat reports/v10-zabbix/zabbix-display-plan.md
    '''
}

def writeV10CloudflareContract(String namespace, String nodePort, String publicHost) {
    sh """
        set -eu
        mkdir -p reports/v10-cloudflare
        cat > reports/v10-cloudflare/publication-contract.json <<EOF2
{
  "pipeline_version": "v10",
  "portal_service": "hello-app-v10-portal.${namespace}.svc.cluster.local",
  "internal_url": "http://192.168.1.58:${nodePort}/",
  "cloudflare_public_hostname": "${publicHost}",
  "mutation_policy": "Only the isolated v10 portal deployment/service is applied. Existing application pods are not modified when DRY_RUN=true."
}
EOF2
        cat reports/v10-cloudflare/publication-contract.json
    """
}

def auditV10DestructiveCommands() {
    sh '''
        set -eu
        mkdir -p reports/v10-safety
        P1='kubectl[[:space:]]+delete'
        P2='docker[[:space:]]+system[[:space:]]+prune'
        P3='rm[[:space:]]+-rf'
        P4='helm[[:space:]]+uninstall'
        P5='git[[:space:]]+reset[[:space:]]+--hard'
        P6='ctr[[:space:]].*[[:space:]]rm'
        P7='crictl[[:space:]]+rmi'
        grep -nE "$P1|$P2|$P3|$P4|$P5|$P6|$P7" Jenkinsfile-expert-v10 jenkins-v10-evidence.groovy ci/v10_generate_evidence.mjs Jenkinsfile-router > reports/v10-safety/destructive-command-scan.txt || true
        if [ -s reports/v10-safety/destructive-command-scan.txt ]; then
          cat reports/v10-safety/destructive-command-scan.txt
          echo "Potential destructive command pattern found in v10 pipeline files."
          exit 1
        fi
        echo "No destructive command pattern found in v10 pipeline files." | tee reports/v10-safety/destructive-command-scan.txt
    '''
}

def validateV10ArtifactCompleteness() {
    sh '''
        set -eu
        mkdir -p reports/v10-artifact-gate
        for f in \
          meta/build-info.json \
          meta/v10-parameter-contract.json \
          reports/v10-platform-services.json \
          reports/v10-observability.ndjson \
          reports/v10-prometheus-metrics.prom \
          reports/v10-grafana-dashboard.json \
          reports/v10-kibana-dashboard.ndjson \
          reports/v10-service-probes.ndjson \
          reports/v10-service-probes-summary.txt \
          reports/v10-portal/index.html \
          reports/v10-portal/evidence.json \
          reports/v10-prometheus/prometheus-rule-preview.yaml \
          reports/v10-alerting/dingtalk-message.json \
          reports/v10-cloudflare/publication-contract.json
        do
          test -s "$f"
          printf '%s ok\n' "$f" >> reports/v10-artifact-gate/completeness.txt
        done
        cat reports/v10-artifact-gate/completeness.txt
    '''
}

def writeV10StageManifest() {
    sh '''
        set -eu
        mkdir -p reports/v10-stage-manifest
        cat > reports/v10-stage-manifest/stages.txt <<'EOF2'
清理环境
0. 初始化上下文
1. 执行前预检
1.1 V10 参数契约与执行画像
2. 并行质量关卡
3. 产物构建与镜像演练
4. 全平台证据矩阵
4.1 DevOps 服务探针
4.2 GitOps 与镜像仓库探针
4.3 应用与前端成果探针
4.4 数据存储服务探针
4.5 大数据链路探针
4.6 可观测日志链路探针
4.7 监控告警链路探针
4.8 编排分析与 BI 探针
4.9 Kubernetes 基础能力探针
4.10 资源画像与日志样本
4.11 证据汇总与失败门禁
5. Grafana/Kibana 图表素材校验
5.1 观测资产导入演练
5.2 钉钉通知恢复演练
5.3 Prometheus 规则素材生成
5.4 Grafana Dashboard 深度校验
5.5 Kibana Saved Object 深度校验
5.6 Jenkins 日志链路证据
5.7 Zabbix 展示素材证据
5.8 Cloudflare 发布合约
6. Cloudflare-ready 成果门户
6.1 Cloudflare 真实配置门禁
6.2 Cloudflare Tunnel Manifest 渲染
6.3 Cloudflare Tunnel 发布与公网验证
7. 成果验证
8. 构建总结
9.1 破坏性命令审计
9.2 产物完整性门禁
9.3 Stage 结果清单
10. Stage 复杂度与反凑行审计
11. Jenkins 能力与插件核验
12. GitLab 源码与版本契约核验
13. Dockerfile 与本地镜像恢复审计
14. ArgoCD 配置可渲染门禁
15. Kubernetes 工作负载硬门禁
16. 日志链路端到端探针
17. 图表素材可导入门禁
18. 真实发布结论与回滚证据包
EOF2
        nl -ba reports/v10-stage-manifest/stages.txt | tee reports/v10-stage-manifest/stage-count.txt
    '''
}

def publishV10EvidencePortal(String namespace, String imageName, String nodePort, String cloudflareHost) {
    sh """
        set -eux
        test -f reports/v10-portal/index.html
        cat > reports/v10-portal/Dockerfile <<'DOCKERFILE'
FROM 127.0.0.1:30050/library/nginx-alpine:latest
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html evidence.json /usr/share/nginx/html/
EXPOSE 80
DOCKERFILE
        cat > reports/v10-portal/nginx.conf <<'NGINX'
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
        docker build --network none --label app.name=hello-app-v10-portal --label pipeline.version=v10 --label git.commit=${GIT_COMMIT_ID} -t ${imageName} reports/v10-portal
        docker push ${imageName}
        cat > reports/v10-portal/k8s.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app-v10-portal
  namespace: ${namespace}
  labels:
    app: hello-app-v10-portal
    pipeline-version: v10
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-app-v10-portal
  template:
    metadata:
      labels:
        app: hello-app-v10-portal
        pipeline-version: v10
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
        kubectl apply -f reports/v10-portal/k8s.yaml
        kubectl rollout status deployment/hello-app-v10-portal -n ${namespace} --timeout=180s
        curl -fsS --max-time 10 http://hello-app-v10-portal.${namespace}.svc.cluster.local/ >/dev/null
        curl -fsS --max-time 5 http://192.168.1.58:${nodePort}/ >/dev/null || true
        printf '{"internal_url":"http://192.168.1.58:%s/","cloudflare_hostname":"%s","status":"portal_deployed_cloudflare_ready"}\n' "${nodePort}" "${cloudflareHost}" > reports/v10-cloudflare-preview.json
        echo "V10 portal: http://192.168.1.58:${nodePort}/"
    """
}

def writeCloudflareTunnelTemplateV10(String namespace, String publicHost, String tokenSecretName) {
    sh """
        set -eux
        mkdir -p reports/cloudflare
        cat > reports/cloudflare/v10-cloudflared-template.yaml <<EOF2
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app-v10-cloudflared
  namespace: ${namespace}
  labels:
    app: hello-app-v10-cloudflared
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-app-v10-cloudflared
  template:
    metadata:
      labels:
        app: hello-app-v10-cloudflared
    spec:
      containers:
      - name: cloudflared
        image: ${env.CLOUDFLARE_TUNNEL_IMAGE}
        imagePullPolicy: IfNotPresent
        args: ["tunnel", "--no-autoupdate", "run", "--token", "\\\$(CLOUDFLARE_TUNNEL_TOKEN)"]
        env:
        - name: CLOUDFLARE_TUNNEL_TOKEN
          valueFrom:
            secretKeyRef:
              name: ${tokenSecretName}
              key: token
EOF2
        cat > reports/cloudflare/README-v10.md <<EOF2
# V10 Cloudflare display
Portal service: http://hello-app-v10-portal.${namespace}.svc.cluster.local/
Internal NodePort: http://192.168.1.58:${env.V10_PORTAL_NODEPORT}/
Requested hostname: ${publicHost}
Apply this template only after a valid Cloudflare Tunnel token is stored in secret ${tokenSecretName}.
EOF2
    """
}

return this
