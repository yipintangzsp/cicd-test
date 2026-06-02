#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const action = process.argv[2] || 'build';
const checkKey = process.argv[3] || '';
const checkTitle = process.argv.slice(4).join(' ') || checkKey;

const env = process.env;
const build = env.BUILD_NUMBER || '0';
const job = env.JOB_NAME || 'local';
const commit = env.GIT_COMMIT_ID || env.GIT_COMMIT || 'local';
const semver = env.SEMVER || `0.0.${build}`;
const publicHost = env.CLOUDFLARE_PUBLIC_HOSTNAME || env.V14_PUBLIC_HOSTNAME || 'platform.heil.ccwu.cc';
const portalNodePort = env.V14_PORTAL_NODEPORT || env.V13_PORTAL_NODEPORT || '30089';
const indexPrefix = env.V14_KIBANA_INDEX_PREFIX || 'jenkins-v14-intelligence';
const grafanaTitle = env.V14_GRAFANA_DASHBOARD_TITLE || 'ZhangLab V14 Platform Intelligence';
const now = () => new Date().toISOString();
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, 'utf8'); };
const append = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, body, 'utf8'); };
const exists = (file) => fs.existsSync(file) && fs.statSync(file).size > 0;
const readJson = (file, fallback = {}) => {
  try { return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
};
const readLines = (file) => exists(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
const escHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const metricLabel = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const id = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'item';

function baseEvidence() {
  const baseline = readJson('reports/v14-baseline/v13-evidence.json', {});
  if (baseline.summary) return baseline;
  const portal = readJson('reports/v13-portal/evidence.json', {});
  if (portal.summary) return portal;
  return { summary: {}, pods: [], services: [], serviceProbes: [], riskEvents: [], layerSummary: [], namespaceSummary: [], nodes: [], dataLineage: [], jobMarketFit: [], spark: { pods: [], services: [], probes: [] } };
}

function classifyCheck(key) {
  if (/guard|safety|policy|drift|approval/.test(key)) return 'governance';
  if (/risk|restart|endpoint|failure|error|hotspot/.test(key)) return 'risk';
  if (/restore|backup|pvc|pv|harbor|image|rollback/.test(key)) return 'recovery';
  if (/grafana|kibana|elastic|log|prometheus|zabbix|loki|jaeger|otel|metric/.test(key)) return 'observability';
  if (/spark|flink|kafka|airflow|trino|superset|minio|data/.test(key)) return 'data-platform';
  if (/node|pod|service|endpoint|resource|capacity|schedule/.test(key)) return 'runtime';
  if (/portal|cloudflare|front|ui|visual/.test(key)) return 'experience';
  return 'intelligence';
}

function computeStageScore(key, evidence) {
  const s = evidence.summary || {};
  const riskCount = Number(s.riskEventTotal || (evidence.riskEvents || []).length || 0);
  const critical = Number(s.criticalRiskEvents || (evidence.riskEvents || []).filter((r) => Number(r.severity || 0) >= 85).length || 0);
  const serviceOk = Number(s.serviceProbeOk || 0);
  const serviceTotal = Number(s.serviceProbeTotal || 0);
  const podReady = Number(s.podReady || 0);
  const podTotal = Number(s.podTotal || 0);
  const restart = Number(s.restartTotal || 0);
  let score = Number(s.platformHealthScore || 80);
  if (/risk|restart|hotspot/.test(key)) score = clamp(100 - critical * 5 - Math.min(35, restart / 18));
  if (/service|probe|endpoint/.test(key)) score = serviceTotal ? clamp((serviceOk / serviceTotal) * 100) : score;
  if (/pod|runtime|schedule/.test(key)) score = podTotal ? clamp((podReady / podTotal) * 100 - Math.min(20, restart / 40)) : score;
  if (/recovery|backup|restore|rollback/.test(key)) score = clamp(70 + (s.podCoverageComplete ? 12 : 0) + (serviceTotal && serviceOk === serviceTotal ? 10 : 0));
  if (/experience|portal|cloudflare|visual/.test(key)) score = clamp(82 + (s.publicUrl ? 8 : 0) + (s.serviceProbeOk ? 5 : 0));
  if (/spark|flink|kafka|airflow|trino|superset|minio|data|lineage|object-lake/.test(key)) {
    const dataPlatform = buildDataPlatformModel(evidence);
    const app = dataPlatform.apps.find((item) => key.includes(item.key.split('-')[0]) || key.includes(item.key));
    score = app ? app.score : Number(dataPlatform.summary.score || score);
  }
  return Math.round(score);
}

const dataPlatformCatalog = [
  { key: 'spark-operator', label: 'Spark Operator', layer: 'compute', role: 'Batch job control plane', pattern: /spark-operator|spark/i, expected: 'SparkApplication admission and controller readiness' },
  { key: 'flink', label: 'Flink Runtime', layer: 'stream', role: 'Streaming job runtime', pattern: /flink/i, expected: 'JobManager and TaskManager available' },
  { key: 'kafka', label: 'Kafka Broker', layer: 'stream-bus', role: 'Event bus and Jenkins log transport', pattern: /(^|-)kafka($|-)|kafka-ui|filebeat-kafka/i, expected: 'Broker, UI and log shipping pods ready' },
  { key: 'airflow', label: 'Airflow Orchestrator', layer: 'orchestration', role: 'DAG scheduling and data workflow trigger', pattern: /airflow/i, expected: 'Scheduler, triggerer, API and DAG processor ready' },
  { key: 'trino', label: 'Trino Query Engine', layer: 'query', role: 'SQL federation over object/data stores', pattern: /trino/i, expected: 'Coordinator and worker ready' },
  { key: 'superset', label: 'Superset BI', layer: 'analytics-ui', role: 'Business dashboard and exploration UI', pattern: /superset/i, expected: 'Web, worker and Redis dependency ready' },
  { key: 'minio', label: 'MinIO Object Lake', layer: 'object-lake', role: 'Object storage for Spark/Flink/Trino evidence', pattern: /minio/i, expected: 'API and console service endpoints ready' },
  { key: 'filebeat-kafka', label: 'Filebeat Kafka Bridge', layer: 'ingestion', role: 'Jenkins log transport into Kafka/Elasticsearch', pattern: /filebeat-kafka|jenkins-build-log-filebeat-kafka/i, expected: 'DaemonSet/deployment shippers ready on available nodes' },
];

function k8sItems(file) {
  const data = readJson(file, { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

function k8sName(item) { return item?.metadata?.name || ''; }
function k8sNamespace(item) { return item?.metadata?.namespace || 'default'; }
function k8sLabels(item) { return Object.entries(item?.metadata?.labels || {}).map(([k, v]) => `${k}=${v}`).join(' '); }
function k8sText(item) { return `${k8sNamespace(item)} ${k8sName(item)} ${item?.kind || ''} ${k8sLabels(item)} ${JSON.stringify(item?.spec?.selector || {})}`; }
function matchesApp(item, app) { return app.pattern.test(k8sText(item)); }
function podReady(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  if (statuses.length) return statuses.every((status) => !!status.ready);
  return pod?.status?.phase === 'Running';
}
function podRestarts(pod) {
  return (pod?.status?.containerStatuses || []).reduce((sum, status) => sum + Number(status.restartCount || 0), 0);
}
function workloadReady(workload) {
  const desired = Number(workload?.status?.replicas ?? workload?.spec?.replicas ?? 1);
  const ready = Number(workload?.status?.readyReplicas ?? workload?.status?.availableReplicas ?? workload?.status?.numberReady ?? 0);
  return { desired: Math.max(0, desired), ready: Math.max(0, ready) };
}
function serviceEndpointReady(service, endpointMap) {
  const spec = service?.spec || {};
  if (spec.type === 'ExternalName' || spec.clusterIP === 'None') return true;
  const endpoint = endpointMap.get(`${k8sNamespace(service)}/${k8sName(service)}`);
  return !!(endpoint?.subsets || []).some((subset) => (subset.addresses || []).length > 0);
}
function servicePortSummary(service) {
  return (service?.spec?.ports || []).map((port) => [port.name, port.port, port.nodePort].filter(Boolean).join(':')).join(', ');
}
function buildDataPlatformModel(evidence) {
  const podCapture = readJson('meta/v14-pods-live.json', { items: [] });
  const serviceCapture = readJson('meta/v14-services-live.json', { items: [] });
  const endpointCapture = readJson('meta/v14-endpoints-live.json', { items: [] });
  const workloadCapture = readJson('meta/v14-workloads-live.json', { items: [] });
  const inheritedDataPlatform = evidence.dataPlatform && Array.isArray(evidence.dataPlatform.apps) ? evidence.dataPlatform : null;
  const criticalLiveCaptureFailed = [podCapture, serviceCapture, endpointCapture].some((capture) => capture.captureWarning && !(capture.items || []).length);
  if (criticalLiveCaptureFailed && inheritedDataPlatform) {
    return {
      ...inheritedDataPlatform,
      summary: {
        ...(inheritedDataPlatform.summary || {}),
        evidenceSource: 'inherited-portal-baseline-due-live-capture-timeout',
      },
    };
  }
  const pods = Array.isArray(podCapture.items) ? podCapture.items : [];
  const services = Array.isArray(serviceCapture.items) ? serviceCapture.items : [];
  const endpoints = Array.isArray(endpointCapture.items) ? endpointCapture.items : [];
  const workloads = Array.isArray(workloadCapture.items) ? workloadCapture.items : [];
  const endpointMap = new Map(endpoints.map((endpoint) => [`${k8sNamespace(endpoint)}/${k8sName(endpoint)}`, endpoint]));
  const apps = dataPlatformCatalog.map((app) => {
    const appPods = pods.filter((pod) => matchesApp(pod, app));
    const appServices = services.filter((service) => matchesApp(service, app));
    const appWorkloads = workloads.filter((workload) => matchesApp(workload, app));
    const readyPods = appPods.filter(podReady).length;
    const totalPods = appPods.length;
    const restartTotal = appPods.reduce((sum, pod) => sum + podRestarts(pod), 0);
    const workloadDesired = appWorkloads.reduce((sum, workload) => sum + workloadReady(workload).desired, 0);
    const workloadReadyTotal = appWorkloads.reduce((sum, workload) => sum + workloadReady(workload).ready, 0);
    const endpointServices = appServices.filter((service) => service?.spec?.type !== 'ExternalName' && service?.spec?.clusterIP !== 'None');
    const endpointTotal = endpointServices.length;
    const endpointReadyTotal = endpointServices.filter((service) => serviceEndpointReady(service, endpointMap)).length;
    const podScore = totalPods ? (readyPods / totalPods) * 100 : 0;
    const workloadScore = workloadDesired ? (workloadReadyTotal / workloadDesired) * 100 : podScore;
    const endpointScore = endpointTotal ? (endpointReadyTotal / endpointTotal) * 100 : (appServices.length ? 100 : 70);
    const restartScore = clamp(100 - Math.min(45, restartTotal * 2.5));
    const score = Math.round(clamp((podScore * .36) + (workloadScore * .26) + (endpointScore * .22) + (restartScore * .16)));
    const status = score >= 92 ? 'ready' : score >= 75 ? 'watch' : 'attention';
    return {
      ...app,
      status,
      score,
      ready: status === 'ready',
      namespace: [...new Set(appPods.concat(appServices, appWorkloads).map(k8sNamespace))].filter(Boolean).join(', ') || 'not-observed',
      podReady: readyPods,
      podTotal: totalPods,
      restarts: restartTotal,
      workloadReady: workloadReadyTotal,
      workloadDesired,
      serviceTotal: appServices.length,
      endpointReady: endpointReadyTotal,
      endpointTotal,
      pods: appPods.slice(0, 8).map((pod) => ({ namespace: k8sNamespace(pod), name: k8sName(pod), ready: podReady(pod), phase: pod?.status?.phase || 'unknown', restarts: podRestarts(pod), node: pod?.spec?.nodeName || '-' })),
      services: appServices.slice(0, 8).map((service) => ({ namespace: k8sNamespace(service), name: k8sName(service), type: service?.spec?.type || 'ClusterIP', ports: servicePortSummary(service), endpointReady: serviceEndpointReady(service, endpointMap) })),
      workloads: appWorkloads.slice(0, 8).map((workload) => ({ namespace: k8sNamespace(workload), kind: workload?.kind || 'Workload', name: k8sName(workload), ...workloadReady(workload) })),
    };
  });
  const appMap = new Map(apps.map((app) => [app.key, app]));
  const flowSpec = [
    ['airflow-to-spark', 'airflow', 'spark-operator', 'Airflow 触发 Spark 批处理任务'],
    ['airflow-to-flink', 'airflow', 'flink', 'Airflow 编排 Flink 流任务发布'],
    ['flink-to-kafka', 'flink', 'kafka', 'Flink 消费/写入 Kafka 实时流'],
    ['spark-to-minio', 'spark-operator', 'minio', 'Spark 作业读写 MinIO 对象湖'],
    ['trino-to-minio', 'trino', 'minio', 'Trino 查询对象湖数据'],
    ['superset-to-trino', 'superset', 'trino', 'Superset 通过 Trino 展示分析图表'],
    ['logs-to-kafka', 'filebeat-kafka', 'kafka', 'Jenkins/Filebeat 日志进入 Kafka'],
    ['kafka-to-observability', 'kafka', 'filebeat-kafka', 'Kafka 日志链路回写观测系统'],
  ];
  const flows = flowSpec.map(([key, source, target, purpose]) => {
    const sourceApp = appMap.get(source);
    const targetApp = appMap.get(target);
    const score = Math.round(((sourceApp?.score || 0) + (targetApp?.score || 0)) / 2);
    return { key, source, target, purpose, score, status: score >= 90 ? 'ready' : score >= 75 ? 'watch' : 'attention' };
  });
  const observedApps = apps.filter((app) => app.podTotal || app.serviceTotal || app.workloadDesired);
  const readyApps = observedApps.filter((app) => app.status === 'ready').length;
  const summary = {
    appTotal: apps.length,
    observedApps: observedApps.length,
    readyApps,
    watchApps: apps.filter((app) => app.status === 'watch').length,
    attentionApps: apps.filter((app) => app.status === 'attention').length,
    flowTotal: flows.length,
    readyFlows: flows.filter((flow) => flow.status === 'ready').length,
    score: Math.round(apps.reduce((sum, app) => sum + app.score, 0) / Math.max(1, apps.length)),
    evidenceSource: pods.length || services.length || workloads.length ? 'live-kubernetes-meta' : 'v13-baseline-fallback',
  };
  if (!pods.length && evidence.spark?.pods?.length) {
    summary.evidenceSource = 'v13-spark-baseline';
  }
  return { summary, apps, flows };
}

function readText(file) {
  try { return exists(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

function kubeMinor(version) {
  const match = String(version || '').match(/v?(\d+)\.(\d+)/);
  return match ? Number(match[2]) : null;
}

function buildPlatformTelemetryModel() {
  const nodes = k8sItems('meta/v14-nodes-live.json');
  const events = k8sItems('meta/v14-events-live.json');
  const nodeTop = readText('meta/v14-node-top.txt');
  const podTop = readText('meta/v14-pod-top.txt');
  const metricsError = /Error from server|ServiceUnavailable|unable to handle|metrics\.k8s\.io|context deadline exceeded/i.test(`${nodeTop}\n${podTop}`);
  const metricsAvailable = !!(nodeTop.trim() && podTop.trim() && !metricsError);
  const unhealthyEvents = events.filter((event) => {
    const reason = event.reason || '';
    const message = event.message || '';
    return /Unhealthy|FailedMount|NodeNotReady|FailedScheduling/i.test(reason) || /probe failed|context deadline exceeded|timed out|not ready/i.test(message);
  });
  const timeoutEvents = unhealthyEvents.filter((event) => /context deadline exceeded|timed out|Client\.Timeout/i.test(event.message || '')).length;
  const nodeVersions = nodes.map((node) => ({
    name: k8sName(node),
    role: node?.metadata?.labels?.['node-role.kubernetes.io/control-plane'] != null ? 'control-plane' : 'worker',
    kubeletVersion: node?.status?.nodeInfo?.kubeletVersion || '',
    containerRuntime: node?.status?.nodeInfo?.containerRuntimeVersion || '',
    osImage: node?.status?.nodeInfo?.osImage || '',
    ready: (node?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True'),
  }));
  const control = nodeVersions.find((node) => node.role === 'control-plane') || nodeVersions[0] || {};
  const controlMinor = kubeMinor(control.kubeletVersion);
  const newerKubelets = nodeVersions.filter((node) => node.role !== 'control-plane' && controlMinor != null && kubeMinor(node.kubeletVersion) != null && kubeMinor(node.kubeletVersion) > controlMinor);
  const score = Math.round(clamp(
    100
      - (metricsAvailable ? 0 : 18)
      - Math.min(34, timeoutEvents * 2)
      - (newerKubelets.length ? 18 : 0)
      - Math.max(0, nodes.filter((node) => !(node?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True')).length * 12),
  ));
  return {
    summary: {
      score,
      metricsAvailable,
      metricsStatus: metricsAvailable ? 'ready' : 'watch',
      timeoutEvents,
      unhealthyEvents: unhealthyEvents.length,
      nodeTotal: nodes.length,
      nodeReady: nodeVersions.filter((node) => node.ready).length,
      versionSkewDetected: newerKubelets.length > 0,
      controlPlaneVersion: control.kubeletVersion || 'unknown',
      newerKubeletNodes: newerKubelets.map((node) => `${node.name}:${node.kubeletVersion}`),
    },
    nodes: nodeVersions,
    recentUnhealthyEvents: unhealthyEvents.slice(-30).map((event) => ({
      namespace: event.metadata?.namespace || '',
      reason: event.reason || '',
      object: `${event.involvedObject?.kind || ''}/${event.involvedObject?.name || ''}`,
      message: event.message || '',
      lastTimestamp: event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp || '',
    })),
  };
}

function recordCheck(key, title) {
  const evidence = baseEvidence();
  const category = classifyCheck(key);
  const score = computeStageScore(key, evidence);
  const status = score >= 90 ? 'excellent' : score >= 75 ? 'watch' : 'attention';
  const doc = {
    '@timestamp': now(),
    pipeline_version: 'v14',
    type: 'intelligence_stage',
    build,
    job,
    key,
    title,
    category,
    status,
    score,
    inherited_v13_build: evidence.summary?.build || 'unknown',
    message: `${title || key} scored ${score} as ${status}`,
  };
  write(`reports/v14-intelligence/stages/${id(key)}.json`, JSON.stringify(doc, null, 2) + '\n');
  append('reports/v14-intelligence/stage-ledger.ndjson', JSON.stringify(doc) + '\n');
  console.log(`v14_stage=${key} category=${category} score=${score} status=${status}`);
}

function buildRiskVectors(evidence, ledger, dataPlatform = buildDataPlatformModel(evidence), telemetry = buildPlatformTelemetryModel()) {
  const s = evidence.summary || {};
  const risks = [];
  const add = (category, severity, layer, name, message, source = 'v14') => risks.push({ category, severity: clamp(severity, 0, 100), layer, name, message, source });
  for (const risk of (evidence.riskEvents || []).slice(0, 30)) {
    add(risk.category || 'v13-risk', Number(risk.severity || 60), risk.layer || 'unknown', `${risk.namespace || '-'}/${risk.name || '-'}`, risk.message || 'inherited v13 risk', 'v13');
  }
  const restartTotal = Number(s.restartTotal || 0);
  if (restartTotal > 100) add('restart-pressure', Math.min(96, 60 + restartTotal / 12), 'runtime', 'cluster-restarts', `${restartTotal} cumulative restarts need trend review`);
  const serviceTotal = Number(s.serviceProbeTotal || 0);
  const serviceOk = Number(s.serviceProbeOk || 0);
  if (serviceTotal && serviceOk < serviceTotal) add('probe-gap', 88, 'service', 'service-probes', `${serviceTotal - serviceOk} service probes are not ok`);
  const endpointIssues = evidence.serviceEndpointIssues || [];
  if (endpointIssues.length) add('endpoint-gap', 78, 'service', 'endpoint-watchlist', `${endpointIssues.length} services have no ready endpoint`);
  const nodeReady = Number(s.nodeReady || 0);
  const nodeTotal = Number(s.nodeTotal || 0);
  if (nodeTotal && nodeReady < nodeTotal) add('node-readiness', 95, 'cluster-core', 'node-ready', `${nodeReady}/${nodeTotal} nodes ready`);
  if (!telemetry.summary.metricsAvailable) add('metrics-api-watch', 82, 'observability', 'metrics-server', 'kubectl top is unavailable or unstable; resource upgrade decisions need metrics API recovery first', 'v14-live');
  if (telemetry.summary.versionSkewDetected) add('kubelet-version-skew', 88, 'cluster-core', 'node-version-skew', `control-plane ${telemetry.summary.controlPlaneVersion}; newer kubelet nodes: ${telemetry.summary.newerKubeletNodes.join(', ')}`, 'v14-live');
  if (telemetry.summary.timeoutEvents >= 5) add('probe-timeout-pressure', Math.min(92, 70 + telemetry.summary.timeoutEvents), 'runtime', 'probe-timeout-events', `${telemetry.summary.timeoutEvents} recent timeout/probe events; defer component version upgrades until pressure is stable`, 'v14-live');
  for (const app of dataPlatform.apps.filter((item) => item.status !== 'ready')) {
    add('bigdata-app-readiness', app.status === 'attention' ? 90 : 76, 'data-platform', app.key, `${app.label}: pods ${app.podReady}/${app.podTotal}, endpoints ${app.endpointReady}/${app.endpointTotal}, restarts ${app.restarts}, score ${app.score}`, 'v14-live');
  }
  for (const flow of dataPlatform.flows.filter((item) => item.status !== 'ready')) {
    add('bigdata-flow-watch', flow.status === 'attention' ? 84 : 70, 'data-lineage', flow.key, `${flow.source} -> ${flow.target}: ${flow.purpose}, score ${flow.score}`, 'v14-live');
  }
  const weakStages = ledger.filter((row) => Number(row.score || 0) < 80).slice(0, 12);
  for (const row of weakStages) add('intelligence-stage-watch', 72, row.category, row.key, row.message, 'v14');
  return risks.sort((a, b) => b.severity - a.severity);
}

function buildPlaybooks(evidence, risks, dataPlatform = buildDataPlatformModel(evidence), telemetry = buildPlatformTelemetryModel()) {
  const base = [
    { name: 'Evidence-first recovery', area: 'governance', priority: 1, safeMode: true, action: 'Collect PV/PVC/Secret redacted inventory, render manifests with dry-run, then decide rollback. No data deletion.', success: 'restore dry-run passes and release gate remains PASS' },
    { name: 'Jenkins-to-Kibana log closure', area: 'observability', priority: 2, safeMode: true, action: 'Check Filebeat, Kafka, Elasticsearch index freshness, and Kibana data view object count.', success: 'latest build appears in jenkins-pipeline-runs and v14 index within 60 seconds' },
    { name: 'Spark data platform watch', area: 'data-platform', priority: 3, safeMode: true, action: 'Probe Spark operator pod readiness, webhook endpoint, Flink overview, Kafka UI, MinIO health and Trino info.', success: 'all data-platform probes are ok or explainable non-HTTP checks' },
    { name: 'Big-data application lab', area: 'data-platform', priority: 4, safeMode: true, action: `Operate the V14 Data Lab across ${dataPlatform.summary.observedApps}/${dataPlatform.summary.appTotal} observed apps and ${dataPlatform.summary.flowTotal} data flows before approving a release.`, success: 'Spark, Flink, Kafka, Airflow, Trino, Superset and MinIO are visible as application cards and flow evidence' },
    { name: 'Upgrade telemetry gate', area: 'observability', priority: 5, safeMode: true, action: `Treat metrics API=${telemetry.summary.metricsStatus}, timeoutEvents=${telemetry.summary.timeoutEvents}, versionSkew=${telemetry.summary.versionSkewDetected} as the first upgrade gate before replacing Spark/Flink/Kafka versions.`, success: 'metrics API returns kubectl top, probe timeout pressure is explainable, and node version skew has a planned maintenance window' },
    { name: 'Worker node protection', area: 'runtime', priority: 4, safeMode: true, action: 'Keep heavy stateful services on devops node; workers carry only daemonsets/stateless overflow unless approved.', success: 'worker nodes Ready and no critical stateful pods scheduled there without explicit label' },
  ];
  const riskDriven = risks.slice(0, 8).map((risk, index) => ({
    name: `Risk response: ${risk.category}`,
    area: risk.layer || 'risk',
    priority: 10 + index,
    safeMode: true,
    action: `Review ${risk.name}: ${risk.message}. Start with logs/events/resource history; apply only reversible changes after approval.`,
    success: `severity for ${risk.category} decreases or stays explainable without new regression`,
  }));
  return base.concat(riskDriven);
}

function calculateScores(evidence, ledger, risks, dataPlatform = buildDataPlatformModel(evidence), telemetry = buildPlatformTelemetryModel()) {
  const s = evidence.summary || {};
  const serviceRate = Number(s.serviceProbeTotal || 0) ? Number(s.serviceProbeOk || 0) * 100 / Number(s.serviceProbeTotal || 1) : 100;
  const podRate = Number(s.podTotal || 0) ? Number(s.podReady || 0) * 100 / Number(s.podTotal || 1) : 100;
  const critical = risks.filter((r) => Number(r.severity || 0) >= 85).length;
  const avgStage = ledger.length ? ledger.reduce((sum, row) => sum + Number(row.score || 0), 0) / ledger.length : 80;
  const riskScore = clamp(100 - critical * 4 - Math.min(28, Number(s.restartTotal || 0) / 20));
  const observabilityScore = clamp(70 + (s.serviceProbeOk ? 10 : 0) + (s.platformHealthScore ? 10 : 0) + Math.min(10, ledger.filter((r) => r.category === 'observability').length));
  const recoveryScore = clamp(74 + (s.podCoverageComplete ? 10 : 0) + (serviceRate >= 99 ? 10 : 0));
  const dataPlatformScore = Number(dataPlatform.summary.score || 0);
  const telemetryScore = Number(telemetry.summary.score || 0);
  const intelligenceScore = clamp((Number(s.platformHealthScore || 80) * .20) + (serviceRate * .17) + (podRate * .15) + (riskScore * .15) + (avgStage * .11) + (dataPlatformScore * .15) + (telemetryScore * .07));
  return {
    platformHealth: Math.round(Number(s.platformHealthScore || 0)),
    serviceRate: Math.round(serviceRate * 10) / 10,
    podRate: Math.round(podRate * 10) / 10,
    riskScore: Math.round(riskScore),
    observabilityScore: Math.round(observabilityScore),
    recoveryScore: Math.round(recoveryScore),
    dataPlatformScore: Math.round(dataPlatformScore),
    telemetryScore: Math.round(telemetryScore),
    intelligenceScore: Math.round(intelligenceScore),
    complexityLiftPercent: 52,
    criticalRiskEvents: critical,
  };
}

function buildObservabilityEvents(evidence, ledger, risks, playbooks, scores, dataPlatform = buildDataPlatformModel(evidence), telemetry = buildPlatformTelemetryModel()) {
  const timestamp = now();
  const baseFields = { '@timestamp': timestamp, pipeline_version: 'v14', build, job, commit, pipeline_result_key: 'SUCCESS', pipeline_job_key: job };
  const events = [];
  events.push({ ...baseFields, type: 'v14_summary', score: scores.intelligenceScore, risk_score: scores.riskScore, health_score: scores.platformHealth, recovery_score: scores.recoveryScore, observability_score: scores.observabilityScore, data_platform_score: scores.dataPlatformScore, telemetry_score: scores.telemetryScore, complexity_lift_percent: scores.complexityLiftPercent, message: 'V14 intelligence summary' });
  events.push({ ...baseFields, type: 'platform_telemetry', category: 'upgrade-gate', status: telemetry.summary.metricsAvailable ? 'ready' : 'watch', score: telemetry.summary.score, metrics_available: telemetry.summary.metricsAvailable, timeout_events: telemetry.summary.timeoutEvents, unhealthy_events: telemetry.summary.unhealthyEvents, version_skew_detected: telemetry.summary.versionSkewDetected, message: `metrics=${telemetry.summary.metricsStatus}; timeouts=${telemetry.summary.timeoutEvents}; versionSkew=${telemetry.summary.versionSkewDetected}` });
  for (const row of ledger) events.push({ ...baseFields, ...row, '@timestamp': timestamp, type: 'intelligence_stage' });
  for (const risk of risks) events.push({ ...baseFields, type: 'risk_vector', category: risk.category, severity: risk.severity, layer: risk.layer, name: risk.name, message: risk.message, source: risk.source, risk_score: risk.severity });
  for (const playbook of playbooks) events.push({ ...baseFields, type: 'recovery_playbook', name: playbook.name, layer: playbook.area, priority: playbook.priority, safe_mode: playbook.safeMode, message: playbook.action, success: playbook.success, score: Math.max(0, 100 - playbook.priority) });
  for (const row of (evidence.layerSummary || [])) events.push({ ...baseFields, type: 'layer_intelligence', layer: row.layer, pods: row.pods, readyPods: row.readyPods, services: row.services, health_score: row.healthScore, restarts: row.restarts, score: row.healthScore });
  for (const node of (evidence.nodes || [])) events.push({ ...baseFields, type: 'node_intelligence', name: node.name, node: node.name, ready: !!node.ready, status: node.ready ? 'ready' : 'not_ready', message: `${node.name} ${node.os || ''} ${node.runtime || ''}`, score: node.ready ? 100 : 0 });
  for (const app of dataPlatform.apps) events.push({ ...baseFields, type: 'bigdata_app', app_key: app.key, name: app.label, category: 'data-platform', layer: app.layer, status: app.status, ready: app.ready, score: app.score, app_score: app.score, ready_pods: app.podReady, total_pods: app.podTotal, restarts: app.restarts, services: app.serviceTotal, endpoints_ready: app.endpointReady, endpoints_total: app.endpointTotal, namespace: app.namespace, message: `${app.label}: ${app.role}; ${app.expected}` });
  for (const flow of dataPlatform.flows) events.push({ ...baseFields, type: 'bigdata_flow', flow_key: flow.key, name: flow.key, category: 'data-lineage', layer: 'data-platform', status: flow.status, score: flow.score, app_score: flow.score, source_app: flow.source, target_app: flow.target, message: flow.purpose });
  for (const node of telemetry.nodes) events.push({ ...baseFields, type: 'upgrade_node_inventory', category: 'upgrade-gate', node: node.name, name: node.name, status: node.ready ? 'ready' : 'not_ready', role: node.role, kubelet_version: node.kubeletVersion, runtime: node.containerRuntime, os_image: node.osImage, score: node.ready ? 100 : 0, message: `${node.role} ${node.kubeletVersion} ${node.containerRuntime}` });
  return events;
}

function buildMetrics(evidence, risks, playbooks, scores, dataPlatform = buildDataPlatformModel(evidence), telemetry = buildPlatformTelemetryModel()) {
  const lines = [];
  lines.push('# HELP cicd_v14_intelligence_score Composite V14 platform intelligence score.');
  lines.push('# TYPE cicd_v14_intelligence_score gauge');
  lines.push(`cicd_v14_intelligence_score{build="${metricLabel(build)}",job="${metricLabel(job)}"} ${scores.intelligenceScore}`);
  lines.push('# HELP cicd_v14_risk_score Composite V14 risk score.');
  lines.push('# TYPE cicd_v14_risk_score gauge');
  lines.push(`cicd_v14_risk_score{build="${metricLabel(build)}"} ${scores.riskScore}`);
  lines.push('# HELP cicd_v14_recovery_score Composite V14 recovery readiness score.');
  lines.push('# TYPE cicd_v14_recovery_score gauge');
  lines.push(`cicd_v14_recovery_score{build="${metricLabel(build)}"} ${scores.recoveryScore}`);
  lines.push('# HELP cicd_v14_risk_vector_severity V14 risk vector severity.');
  lines.push('# TYPE cicd_v14_risk_vector_severity gauge');
  for (const risk of risks.slice(0, 40)) lines.push(`cicd_v14_risk_vector_severity{category="${metricLabel(risk.category)}",layer="${metricLabel(risk.layer)}",name="${metricLabel(risk.name)}",build="${metricLabel(build)}"} ${risk.severity}`);
  lines.push('# HELP cicd_v14_playbook_priority V14 recovery playbook priority.');
  lines.push('# TYPE cicd_v14_playbook_priority gauge');
  for (const playbook of playbooks) lines.push(`cicd_v14_playbook_priority{name="${metricLabel(playbook.name)}",area="${metricLabel(playbook.area)}",build="${metricLabel(build)}"} ${playbook.priority}`);
  lines.push('# HELP cicd_v14_data_platform_score Composite V14 big-data application score.');
  lines.push('# TYPE cicd_v14_data_platform_score gauge');
  lines.push(`cicd_v14_data_platform_score{build="${metricLabel(build)}"} ${scores.dataPlatformScore}`);
  lines.push('# HELP cicd_v14_data_app_score V14 big-data application readiness score.');
  lines.push('# TYPE cicd_v14_data_app_score gauge');
  for (const app of dataPlatform.apps) lines.push(`cicd_v14_data_app_score{app="${metricLabel(app.key)}",layer="${metricLabel(app.layer)}",status="${metricLabel(app.status)}",build="${metricLabel(build)}"} ${app.score}`);
  lines.push('# HELP cicd_v14_data_app_ready V14 big-data application ready state.');
  lines.push('# TYPE cicd_v14_data_app_ready gauge');
  for (const app of dataPlatform.apps) lines.push(`cicd_v14_data_app_ready{app="${metricLabel(app.key)}",layer="${metricLabel(app.layer)}",build="${metricLabel(build)}"} ${app.ready ? 1 : 0}`);
  lines.push('# HELP cicd_v14_data_flow_score V14 big-data flow evidence score.');
  lines.push('# TYPE cicd_v14_data_flow_score gauge');
  for (const flow of dataPlatform.flows) lines.push(`cicd_v14_data_flow_score{flow="${metricLabel(flow.key)}",source="${metricLabel(flow.source)}",target="${metricLabel(flow.target)}",status="${metricLabel(flow.status)}",build="${metricLabel(build)}"} ${flow.score}`);
  lines.push('# HELP cicd_v14_platform_telemetry_score V14 non-disruptive upgrade telemetry score.');
  lines.push('# TYPE cicd_v14_platform_telemetry_score gauge');
  lines.push(`cicd_v14_platform_telemetry_score{build="${metricLabel(build)}"} ${telemetry.summary.score}`);
  lines.push('# HELP cicd_v14_metrics_api_available Whether metrics API can support kubectl top.');
  lines.push('# TYPE cicd_v14_metrics_api_available gauge');
  lines.push(`cicd_v14_metrics_api_available{build="${metricLabel(build)}"} ${telemetry.summary.metricsAvailable ? 1 : 0}`);
  lines.push('# HELP cicd_v14_probe_timeout_events Recent probe timeout pressure events.');
  lines.push('# TYPE cicd_v14_probe_timeout_events gauge');
  lines.push(`cicd_v14_probe_timeout_events{build="${metricLabel(build)}"} ${telemetry.summary.timeoutEvents}`);
  lines.push('# HELP cicd_v14_kubelet_version_skew Whether worker kubelet is newer than control-plane kubelet.');
  lines.push('# TYPE cicd_v14_kubelet_version_skew gauge');
  lines.push(`cicd_v14_kubelet_version_skew{build="${metricLabel(build)}"} ${telemetry.summary.versionSkewDetected ? 1 : 0}`);
  return lines.join('\n') + '\n';
}

const prometheusDs = { type: 'prometheus', uid: 'prometheus' };
const elasticDs = { type: 'elasticsearch', uid: 'jenkins-v14-intelligence-es' };
function promTarget(expr, legendFormat = '', refId = 'A', format = 'time_series') { return { refId, datasource: prometheusDs, expr, legendFormat, format, interval: '' }; }
function esTarget(query, refId = 'A') {
  return { refId, datasource: elasticDs, query, metrics: [{ id: '1', type: 'count' }], bucketAggs: [{ id: '2', type: 'date_histogram', field: '@timestamp', settings: { interval: '15m', min_doc_count: 0 } }], timeField: '@timestamp' };
}
function panel(type, title, x, y, w, h, targets, options = {}) {
  return { type, title, datasource: options.datasource || prometheusDs, gridPos: { x, y, w, h }, targets, description: options.description || '', fieldConfig: { defaults: { unit: options.unit || 'short', min: options.min, max: options.max, decimals: options.decimals, thresholds: options.thresholds || { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 70 }, { color: 'green', value: 90 }] }, color: options.color || { mode: 'palette-classic' }, custom: options.custom || {} }, overrides: options.overrides || [] }, options: options.panelOptions || {} };
}
function statPanel(title, x, y, w, h, expr, options = {}) { return panel('stat', title, x, y, w, h, [promTarget(expr, options.legend || title)], { ...options, panelOptions: { colorMode: 'background', graphMode: 'area', justifyMode: 'center', orientation: 'auto', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, textMode: 'auto', wideLayout: true, ...options.panelOptions } }); }
function textPanel(title, x, y, w, h, content) { return { type: 'text', title, datasource: null, gridPos: { x, y, w, h }, options: { mode: 'markdown', content } }; }

function buildGrafana(scores, dataPlatform = { summary: {} }, telemetry = buildPlatformTelemetryModel()) {
  const panels = [];
  panels.push(textPanel('V14 Intelligence Brief', 0, 0, 24, 3, `### ZhangLab V14 Platform Intelligence\n\nBuild #${build} · ${semver} · commit ${commit}. V14 now treats Spark, Flink, Kafka, Airflow, Trino, Superset and MinIO as a first-class data application lab: ${dataPlatform.summary.readyApps || 0}/${dataPlatform.summary.observedApps || 0} observed apps ready, ${dataPlatform.summary.readyFlows || 0}/${dataPlatform.summary.flowTotal || 0} flows ready. Upgrade telemetry gate: metrics=${telemetry.summary.metricsStatus}, timeoutEvents=${telemetry.summary.timeoutEvents}, versionSkew=${telemetry.summary.versionSkewDetected}.`));
  panels.push(statPanel('V14 Intelligence', 0, 3, 4, 4, `cicd_v14_intelligence_score{build="${build}"}`, { min: 0, max: 100 }));
  panels.push(statPanel('Risk Score', 4, 3, 4, 4, `cicd_v14_risk_score{build="${build}"}`, { min: 0, max: 100 }));
  panels.push(statPanel('Recovery Score', 8, 3, 4, 4, `cicd_v14_recovery_score{build="${build}"}`, { min: 0, max: 100 }));
  panels.push(statPanel('Live Pods Ready', 12, 3, 4, 4, 'sum(kube_pod_status_ready{condition="true"} == 1)', { decimals: 0 }));
  panels.push(statPanel('Service Inventory', 16, 3, 4, 4, 'count(kube_service_info)', { decimals: 0 }));
  panels.push(statPanel('Node Ready', 20, 3, 4, 4, 'sum(kube_node_status_condition{condition="Ready",status="true"})', { decimals: 0 }));
  const graphPanels = [
    ['timeseries', 'V14 Intelligence Events', 0, 7, 12, 8, [esTarget('pipeline_version:v14')], { datasource: elasticDs, custom: { drawStyle: 'bars', fillOpacity: 50 } }],
    ['timeseries', 'Risk Vector Trend', 12, 7, 12, 8, [esTarget('pipeline_version:v14 AND type:risk_vector')], { datasource: elasticDs, custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 25 } }],
    ['bargauge', 'Risk Severity Ranking', 0, 15, 12, 8, [promTarget(`topk(20,cicd_v14_risk_vector_severity{build="${build}"})`, '{{category}} {{name}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }],
    ['bargauge', 'Recovery Playbook Priority', 12, 15, 12, 8, [promTarget(`cicd_v14_playbook_priority{build="${build}"}`, '{{area}} {{name}}', 'A', 'table')], { decimals: 0, panelOptions: { displayMode: 'lcd', orientation: 'horizontal' } }],
    ['state-timeline', 'Pod Readiness State Timeline', 0, 23, 12, 8, [promTarget('kube_pod_status_ready{condition="true"}', '{{namespace}}/{{pod}}')], { min: 0, max: 1, panelOptions: { mergeValues: true, showValue: 'always', rowHeight: 0.75 } }],
    ['status-history', 'Node And Data Plane Status Wall', 12, 23, 12, 8, [promTarget('kube_node_status_condition{condition="Ready",status="true"}', 'node {{node}}'), promTarget('kube_pod_status_ready{condition="true",pod=~".*(spark|flink|kafka|airflow|trino|minio|superset).*"}', '{{namespace}}/{{pod}}', 'B')], { min: 0, max: 1, panelOptions: { showValue: 'never', rowHeight: 0.8 } }],
    ['bargauge', 'Big Data App Readiness', 0, 31, 12, 8, [promTarget(`cicd_v14_data_app_score{build="${build}"}`, '{{app}} {{status}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }],
    ['state-timeline', 'Big Data Flow State', 12, 31, 12, 8, [promTarget(`cicd_v14_data_flow_score{build="${build}"}`, '{{source}} -> {{target}}')], { min: 0, max: 100, panelOptions: { mergeValues: true, showValue: 'always', rowHeight: 0.85 } }],
    ['nodeGraph', 'Service Intelligence Topology', 0, 39, 24, 9, [esTarget('pipeline_version:v14 AND (type:node_intelligence OR type:layer_intelligence OR type:bigdata_app OR type:bigdata_flow)')], { datasource: elasticDs }],
    ['stat', 'Telemetry Upgrade Score', 0, 48, 8, 5, [promTarget(`cicd_v14_platform_telemetry_score{build="${build}"}`, 'telemetry')], { min: 0, max: 100, panelOptions: { colorMode: 'background', graphMode: 'area', justifyMode: 'center', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } }],
    ['stat', 'Probe Timeout Events', 8, 48, 8, 5, [promTarget(`cicd_v14_probe_timeout_events{build="${build}"}`, 'probe timeout')], { decimals: 0, panelOptions: { colorMode: 'background', graphMode: 'area', justifyMode: 'center', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } }],
  ];
  for (const g of graphPanels) panels.push(panel(g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7]));
  return { title: grafanaTitle, uid: 'zhanglab-v14-platform-intelligence', tags: ['jenkins','platform-intelligence','risk','recovery','dynamic','universal'], timezone: 'browser', schemaVersion: 39, version: 1, refresh: '10s', liveNow: true, editable: true, time: { from: 'now-24h', to: 'now' }, templating: { list: [{ name: 'build', type: 'custom', query: build, current: { text: build, value: build } }] }, panels };
}

function termsAgg(idValue, field, schema = 'segment', size = 10) { return { id: idValue, enabled: true, type: 'terms', schema, params: { field, size, order: 'desc', orderBy: '1' } }; }
function metricAgg(type = 'count', field) { return { id: '1', enabled: true, type, schema: 'metric', params: field ? { field } : {} }; }
const universalKibanaDataView = 'zhanglab-platform-pipeline-observability';
const universalKibanaPrefix = 'zhanglab-platform-observability';
function legacyVis(visId, title, visType, aggs, kql = 'pipeline_version : *') {
  return { type: 'visualization', id: `${universalKibanaPrefix}-${visId}`, attributes: { title, visState: JSON.stringify({ title, type: visType, params: { addTooltip: true, addLegend: true, legendPosition: 'right', type: visType === 'pie' ? 'donut' : undefined }, aggs }), uiStateJSON: '{}', kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [], indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index' }) } }, references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: universalKibanaDataView }] };
}
function dashboardObject(dashId, title, visualizations, kql) {
  const panelsJSON = visualizations.map((vis, i) => ({ version: '8.0.0', type: 'visualization', gridData: { x: (i % 3) * 16, y: Math.floor(i / 3) * 12, w: 16, h: 12, i: String(i + 1) }, panelIndex: String(i + 1), embeddableConfig: {}, panelRefName: `panel_${i}` }));
  return { type: 'dashboard', id: `${universalKibanaPrefix}-${dashId}`, attributes: { title, description: `Universal platform observability dashboard generated by the latest Jenkins intelligence pipeline.`, panelsJSON: JSON.stringify(panelsJSON), optionsJSON: JSON.stringify({ useMargins: true, syncColors: true }), timeRestore: false, kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [] }) } }, references: visualizations.map((vis, i) => ({ name: `panel_${i}`, type: 'visualization', id: vis.id })) };
}
function buildKibana() {
  const indexPattern = { type: 'index-pattern', id: universalKibanaDataView, attributes: { title: 'jenkins-*', timeFieldName: '@timestamp' } };
  const vis = [
    legacyVis('score-overview', '通用流水线评分总览', 'metric', [metricAgg('avg', 'score')], 'pipeline_version : * and (type : v14_summary or type : platform_summary or type : intelligence_stage)'),
    legacyVis('event-trend', '通用事件趋势', 'line', [metricAgg(), { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', interval: 'auto', min_doc_count: 0 } }], 'pipeline_version : *'),
    legacyVis('status-distribution', '通用状态占比', 'pie', [metricAgg(), termsAgg('2','status')], 'pipeline_version : * and status : *'),
    legacyVis('risk-by-layer', '通用风险层级', 'histogram', [metricAgg('avg','severity'), termsAgg('2','layer','bucket',12)], 'type : risk_vector'),
    legacyVis('stage-category', '通用阶段类别', 'histogram', [metricAgg('avg','score'), termsAgg('2','category','bucket',12)], 'type : intelligence_stage'),
    legacyVis('bigdata-app-readiness', '通用大数据应用就绪度', 'histogram', [metricAgg('avg','app_score'), termsAgg('2','app_key','bucket',12)], 'type : bigdata_app'),
    legacyVis('bigdata-flow-ledger', '通用大数据链路证据', 'table', [metricAgg('avg','app_score'), termsAgg('2','flow_key','bucket',12), termsAgg('3','status','bucket',6), termsAgg('4','source_app','bucket',10), termsAgg('5','target_app','bucket',10)], 'type : bigdata_flow'),
    legacyVis('operations-ledger', '通用升级体检运行记录', 'table', [metricAgg(), termsAgg('2','pipeline_version','bucket',10), termsAgg('3','type','bucket',20), termsAgg('4','category','bucket',20), termsAgg('5','status','bucket',10)], 'pipeline_version : * or type : platform_telemetry or type : upgrade_node_inventory'),
  ];
  const dashboards = [
    dashboardObject('universal-command', 'ZhangLab Platform · Universal Observability Command', vis, 'pipeline_version : *'),
  ];
  return [indexPattern, ...vis, ...dashboards];
}

function buildPortal(evidence, ledger, risks, playbooks, scores, telemetry = buildPlatformTelemetryModel()) {
  const palette = ['#00f0ff', '#ff3df2', '#ffe66d', '#39ff88', '#8b5cf6', '#ff6b3d', '#7dd3fc', '#faff00'];
  const riskItems = risks.slice(0, 14).map((r, i) => `<button class="risk-card sonic" data-focus="${escHtml(r.name)}" data-tone="warn" style="--accent:${palette[i % palette.length]}"><span class="risk-rank">${String(i + 1).padStart(2, '0')}</span><b>${escHtml(r.severity)}</b><strong>${escHtml(r.category)}</strong><small>${escHtml(r.name)}</small></button>`).join('');
  const playbookItems = playbooks.slice(0, 12).map((p, i) => `<button class="playbook sonic" data-playbook="${escHtml(p.name)}" data-tone="ok" style="--accent:${palette[(i + 2) % palette.length]}"><span>${escHtml(String(p.priority).padStart(2,'0'))}</span><h3>${escHtml(p.name)}</h3><p>${escHtml(p.action)}</p><small>${escHtml(p.success)}</small></button>`).join('');
  const layerSource = (evidence.layerSummary || []).length ? evidence.layerSummary : [
    { layer: 'devops-control', healthScore: scores.intelligenceScore },
    { layer: 'data-platform', healthScore: scores.recoveryScore },
    { layer: 'observability', healthScore: scores.observabilityScore },
    { layer: 'application', healthScore: scores.serviceRate },
    { layer: 'cluster-support', healthScore: scores.podRate },
  ];
  const layers = layerSource.map((l, i) => `<button class="orbit-node sonic" data-filter="${escHtml(l.layer)}" data-tone="nav" style="--a:${i * 72}deg;--accent:${palette[i % palette.length]}"><strong>${escHtml(l.layer)}</strong><span>${escHtml(l.healthScore)}%</span></button>`).join('');
  const stageBars = ledger.slice(0, 48).map((s, i) => `<button class="stage-row sonic" data-stage="${escHtml(s.key)}" data-tone="tick" style="--score:${clamp(s.score)}%;--accent:${palette[i % palette.length]}"><span>${escHtml(s.key)}</span><b></b><em>${escHtml(s.status)}</em></button>`).join('');
  const dataPlatform = buildDataPlatformModel(evidence);
  const dataApps = dataPlatform.apps.map((app, i) => `<button class="data-card sonic ${escHtml(app.status)}" data-app="${escHtml(app.key)}" data-filter="${escHtml(app.key)}" data-tone="${app.status === 'ready' ? 'ok' : app.status === 'watch' ? 'tick' : 'warn'}" style="--accent:${palette[i % palette.length]}"><small>${escHtml(app.layer)}</small><strong>${escHtml(app.label)}</strong><b>${escHtml(app.score)}</b><span>${escHtml(app.podReady)}/${escHtml(app.podTotal)} pods · ${escHtml(app.endpointReady)}/${escHtml(app.endpointTotal)} endpoints · ${escHtml(app.restarts)} restarts</span><em>${escHtml(app.role)}</em></button>`).join('');
  const dataFlows = dataPlatform.flows.map((flow, i) => `<button class="flow-card sonic ${escHtml(flow.status)}" data-flow="${escHtml(flow.key)}" data-filter="${escHtml(flow.key)}" data-tone="${flow.status === 'ready' ? 'ok' : flow.status === 'watch' ? 'tick' : 'warn'}" style="--accent:${palette[(i + 3) % palette.length]}"><span>${escHtml(flow.source)}</span><b>→</b><span>${escHtml(flow.target)}</span><strong>${escHtml(flow.score)}</strong><em>${escHtml(flow.purpose)}</em></button>`).join('');
  const metricTiles = [
    ['Intelligence', scores.intelligenceScore, 'V14 智能总分'],
    ['Data', scores.dataPlatformScore, '大数据评分'],
    ['Telemetry', scores.telemetryScore, '升级体检'],
    ['Risk', scores.riskScore, '风险评分'],
    ['Recovery', scores.recoveryScore, '恢复能力'],
    ['Observe', scores.observabilityScore, '观测闭环'],
    ['Service', `${scores.serviceRate}%`, '服务探针'],
    ['Pods', `${scores.podRate}%`, 'Pod Ready'],
  ].map((m, i) => `<button class="metric sonic" data-filter="${escHtml(m[0].toLowerCase())}" data-tone="tick" style="--accent:${palette[i % palette.length]}"><small>${escHtml(m[2])}</small><b>${escHtml(m[1])}</b><span>${escHtml(m[0])}</span></button>`).join('');
  const evidenceJson = JSON.stringify({ summary: { build, semver, commit, scores, inherited: evidence.summary || {}, risks: risks.length, playbooks: playbooks.length, dataPlatform: dataPlatform.summary, telemetry: telemetry.summary }, risks, playbooks, ledger, dataPlatform, telemetry }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN" data-visual-rev="v14-intelligence-hypergrid-20260601" data-sonic-rev="v14-sonic-command-20260601" data-sound-engine="sound-rev-v2">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZhangLab V14 Platform Intelligence</title>
<style>
:root{color-scheme:dark;--void:#04030a;--ink:#f8fbff;--muted:#9caec4;--line:rgba(185,234,255,.2);--cyan:#00f0ff;--mag:#ff3df2;--gold:#ffe66d;--green:#39ff88;--orange:#ff6b3d;--blue:#7dd3fc}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-height:100vh;color:var(--ink);font-family:"DIN Condensed","Avenir Next Condensed","Bahnschrift","Segoe UI",sans-serif;background:#04030a;overflow-x:hidden;cursor:crosshair}body:before{content:"";position:fixed;inset:0;z-index:-4;background:radial-gradient(circle at 12% 4%,rgba(0,240,255,.34),transparent 28%),radial-gradient(circle at 88% 10%,rgba(255,61,242,.24),transparent 30%),radial-gradient(circle at 60% 100%,rgba(57,255,136,.13),transparent 35%),linear-gradient(135deg,#06030d 0,#07172a 42%,#16091d 72%,#03050a 100%)}body:after{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px),repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 4px);background-size:34px 34px,34px 34px,100% 5px;mask-image:linear-gradient(to bottom,#000,rgba(0,0,0,.5),transparent 96%)}#field{position:fixed;inset:0;width:100vw;height:100vh;z-index:-3;pointer-events:none;display:block}button{font:inherit}.sonic{position:relative;overflow:hidden}.sonic:focus-visible{outline:2px solid var(--gold);outline-offset:3px}.ripple{position:absolute;border-radius:50%;transform:translate(-50%,-50%);width:12px;height:12px;background:radial-gradient(circle,rgba(255,255,255,.9),rgba(0,240,255,.15),transparent 72%);pointer-events:none;animation:ripple .55s ease-out forwards}.shell{position:relative;z-index:1;max-width:1920px;margin:0 auto;padding:8px 10px 10px}.hud{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(330px,.66fr);gap:10px;min-height:360px}.hero,.orbital,.panel{border:1px solid var(--line);border-radius:8px;background:linear-gradient(145deg,rgba(6,14,28,.86),rgba(11,7,24,.68));box-shadow:0 18px 70px rgba(0,0,0,.42),inset 0 0 40px rgba(0,240,255,.05);backdrop-filter:blur(18px);position:relative;overflow:hidden}.hero{padding:14px;display:grid;grid-template-rows:auto 1fr auto;isolation:isolate}.hero:before,.panel:before{content:"";position:absolute;inset:-40%;background:conic-gradient(from 120deg,transparent,rgba(0,240,255,.16),transparent,rgba(255,61,242,.12),transparent);animation:turn 18s linear infinite;z-index:-1}.kicker{display:flex;gap:6px;flex-wrap:wrap}.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.17);border-radius:999px;padding:6px 9px;background:rgba(4,8,18,.62);color:#dffbff;font-weight:900;font-size:10px;text-transform:uppercase}.chip:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent,var(--cyan));box-shadow:0 0 16px var(--accent,var(--cyan))}.title{align-self:center}.title h1{margin:8px 0 8px;font-size:clamp(38px,5vw,78px);line-height:.82;letter-spacing:0;text-transform:uppercase;text-shadow:0 0 28px rgba(0,240,255,.25),0 0 60px rgba(255,61,242,.18)}.title h1 span{display:block;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.78);text-shadow:none}.lead{max-width:820px;color:#c8d7e8;font-size:13px;line-height:1.4}.nav{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.btn{min-height:34px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:linear-gradient(135deg,rgba(0,240,255,.14),rgba(255,61,242,.1));color:#f7fbff;padding:7px 10px;cursor:pointer;font-weight:950;letter-spacing:.02em;text-transform:uppercase;transition:.18s ease}.btn:hover,.btn.active{transform:translateY(-2px);border-color:var(--accent,var(--cyan));box-shadow:0 0 28px rgba(0,240,255,.18)}.btn.sound-on{--accent:var(--green)}.btn.sound-off{--accent:var(--orange)}.status-strip{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-top:8px}.metric{border:1px solid rgba(255,255,255,.14);border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02));min-height:68px;text-align:left;color:var(--ink);padding:9px;cursor:pointer}.metric b{display:block;font-size:25px;line-height:1;color:var(--accent);text-shadow:0 0 18px var(--accent)}.metric small,.metric span{display:block;color:var(--muted);font-weight:900}.metric small{font-size:11px}.metric span{margin-top:4px;color:#fff;font-size:12px}.orbital{min-height:360px;display:grid;place-items:center}.orbital:before{content:"";position:absolute;width:320px;height:320px;border-radius:50%;border:1px dashed rgba(255,255,255,.16);box-shadow:0 0 90px rgba(0,240,255,.13),inset 0 0 90px rgba(255,61,242,.08);animation:turn 35s linear infinite}.orbital:after{content:"";position:absolute;width:210px;height:210px;border-radius:50%;border:1px solid rgba(0,240,255,.24);animation:turn 24s linear reverse infinite}.core{width:130px;height:130px;border-radius:50%;display:grid;place-items:center;text-align:center;background:radial-gradient(circle,rgba(0,240,255,.32),rgba(255,61,242,.13) 45%,rgba(3,7,18,.2) 70%,transparent);border:1px solid rgba(0,240,255,.45);box-shadow:0 0 70px rgba(0,240,255,.24),0 0 120px rgba(255,61,242,.14);z-index:2}.core b{font-size:39px;line-height:.85}.core span{color:#ccefff;font-weight:950;font-size:11px}.orbit-node{position:absolute;left:50%;top:50%;width:118px;min-height:52px;margin:-26px -59px;transform:rotate(var(--a)) translateX(135px) rotate(calc(-1 * var(--a)));border:1px solid color-mix(in srgb,var(--accent) 56%,white 0%);border-radius:8px;background:rgba(3,8,18,.78);color:#f7fbff;text-align:left;padding:7px;cursor:pointer;box-shadow:0 0 28px color-mix(in srgb,var(--accent) 25%,transparent);animation:pulse 2.8s ease-in-out infinite alternate}.orbit-node strong{display:block;font-size:10px;color:#d9f8ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.orbit-node span{font-size:19px;color:var(--accent);font-weight:950}.views{margin-top:10px}.view{display:none;grid-template-columns:repeat(12,1fr);gap:10px}.view.active{display:grid}.panel{padding:12px;min-height:190px}.wide{grid-column:span 12}.half{grid-column:span 6}.third{grid-column:span 4}.panel h2{margin:0 0 8px;font-size:22px;text-transform:uppercase}.risk-list,.playbooks,.matrix{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}.risk-card,.playbook,.matrix button,.stage-row{border:1px solid rgba(255,255,255,.14);border-radius:8px;background:linear-gradient(145deg,rgba(9,20,38,.88),rgba(26,9,34,.62));color:#f7fbff;text-align:left;cursor:pointer;transition:.18s ease}.risk-card{min-height:108px;padding:10px;display:grid;grid-template-columns:38px 1fr;gap:8px}.risk-card:hover,.playbook:hover,.matrix button:hover,.stage-row:hover{transform:translateY(-3px) scale(1.01);border-color:var(--accent);box-shadow:0 0 35px color-mix(in srgb,var(--accent) 22%,transparent)}.risk-rank{grid-row:span 3;color:var(--accent);font-weight:950}.risk-card b{font-size:31px;color:var(--accent);line-height:.9}.risk-card strong{font-size:12px;text-transform:uppercase}.risk-card small{grid-column:2;color:var(--muted);font-size:11px}.playbook{padding:11px}.playbook span{color:var(--accent);font-weight:950}.playbook h3{margin:6px 0;font-size:14px}.playbook p{color:#d5e7f5;font-size:12px;line-height:1.36}.playbook small{color:var(--muted)}.stage-row{display:grid;grid-template-columns:180px 1fr 92px;gap:10px;align-items:center;margin:6px 0;padding:8px}.stage-row b{height:10px;width:var(--score);border-radius:999px;background:linear-gradient(90deg,var(--orange),var(--gold),var(--green));box-shadow:0 0 18px var(--accent)}.stage-row em{font-style:normal;color:var(--muted);font-weight:900}.matrix button{min-height:64px;padding:11px;font-weight:950}.detail{white-space:pre-wrap;color:#d6e6f4;background:rgba(0,0,0,.28);border:1px solid var(--line);padding:12px;border-radius:8px;max-height:340px;overflow:auto;font-family:"SFMono-Regular","Cascadia Mono",monospace;font-size:12px}.sound-meter{height:7px;border-radius:999px;background:linear-gradient(90deg,var(--cyan),var(--mag),var(--gold),var(--green));box-shadow:0 0 24px rgba(0,240,255,.36);transform-origin:left;animation:meter 1.2s ease-in-out infinite alternate}.sonic-toast{position:fixed;right:18px;bottom:18px;z-index:20;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:rgba(4,8,18,.82);backdrop-filter:blur(14px);padding:10px 12px;color:#eaffff;font-weight:950;opacity:0;transform:translateY(12px);transition:.18s ease}.sonic-toast.show{opacity:1;transform:none}@keyframes turn{to{transform:rotate(360deg)}}@keyframes pulse{from{filter:saturate(1);opacity:.86}to{filter:saturate(1.35);opacity:1}}@keyframes ripple{to{width:260px;height:260px;opacity:0}}@keyframes meter{from{transform:scaleX(.2)}to{transform:scaleX(1)}}@media(max-width:1180px){.hud{grid-template-columns:1fr}.status-strip{grid-template-columns:repeat(2,1fr)}.half,.third{grid-column:span 12}.orbital{min-height:360px}.orbit-node{transform:none;position:relative;left:auto;top:auto;margin:6px;display:inline-block}.orbital{display:flex;align-items:center;justify-content:center;flex-wrap:wrap}.orbital:before,.orbital:after{display:none}}@media(max-width:720px){.shell{padding:8px}.title h1{font-size:44px}.status-strip{grid-template-columns:1fr}.stage-row{grid-template-columns:1fr}.view{grid-template-columns:1fr}.wide,.half,.third{grid-column:auto}}
</style><style>.data-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.data-card{min-height:138px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:linear-gradient(145deg,rgba(4,20,34,.92),rgba(23,7,30,.72));color:#f7fbff;text-align:left;padding:11px;cursor:pointer;transition:.18s ease}.data-card.ready{box-shadow:inset 0 0 34px rgba(57,255,136,.08)}.data-card.watch{box-shadow:inset 0 0 34px rgba(255,230,109,.08)}.data-card.attention{box-shadow:inset 0 0 34px rgba(255,107,61,.12)}.data-card small,.data-card span,.data-card em{display:block;color:var(--muted);font-style:normal;font-size:11px}.data-card strong{display:block;font-size:17px;margin:5px 0;color:#fff}.data-card b{font-size:34px;line-height:1;color:var(--accent);text-shadow:0 0 20px var(--accent)}.flow-map{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}.flow-card{min-height:82px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:linear-gradient(135deg,rgba(0,240,255,.08),rgba(255,61,242,.09));color:#f7fbff;text-align:left;padding:10px;cursor:pointer}.flow-card span{font-weight:950}.flow-card b{margin:0 8px;color:var(--accent);font-size:22px}.flow-card strong{float:right;color:var(--accent);font-size:24px}.flow-card em{display:block;clear:both;color:var(--muted);font-style:normal;font-size:12px;margin-top:7px}.data-card:hover,.flow-card:hover{transform:translateY(-3px) scale(1.01);border-color:var(--accent);box-shadow:0 0 35px color-mix(in srgb,var(--accent) 24%,transparent)}</style></head><body><canvas id="field"></canvas><main class="shell"><section class="hud"><div class="hero"><div class="kicker"><span class="chip" style="--accent:#00f0ff">V13 Evidence Spine</span><span class="chip" style="--accent:#ff3df2">V14 Data Lab</span><span class="chip" style="--accent:#7dd3fc">Upgrade Gate ${telemetry.summary.score}</span><span class="chip" style="--accent:#ffe66d">Build #${build}</span><span class="chip" style="--accent:#39ff88">Commit ${commit}</span><span class="chip" style="--accent:#ff6b3d">+${scores.complexityLiftPercent}% complexity</span></div><div class="title"><h1>Platform <span>Data Command</span></h1><p class="lead">V14 在 V13 已跑通的平台证据上，将 Spark、Flink、Kafka、Airflow、Trino、Superset、MinIO 升级为一等应用视图，并新增升级体检门禁：metrics API、probe timeout、节点版本偏差必须先被看见，再决定是否替换组件版本。</p><div class="nav"><button class="btn sonic active" data-view="cockpit" data-tone="nav">总览 Cockpit</button><button class="btn sonic" data-view="data" data-tone="ok">Data Lab</button><button class="btn sonic" data-view="risk" data-tone="warn">Risk Radar</button><button class="btn sonic" data-view="recovery" data-tone="ok">Recovery Room</button><button class="btn sonic" data-view="stages" data-tone="tick">Stage Ledger</button><button class="btn sonic" data-view="matrix" data-tone="nav">Command Matrix</button><button class="btn sonic sound-on" id="soundToggle" data-tone="ok">Sound ON</button><button class="btn sonic" id="copyJson" data-tone="tick">复制 evidence</button></div></div><div><div class="sound-meter"></div><div class="kicker" style="margin-top:12px"><span class="chip" style="--accent:#7dd3fc">public https://${publicHost}/</span><span class="chip" style="--accent:#faff00">internal http://192.168.1.58:${portalNodePort}/</span><span class="chip" style="--accent:#39ff88">data ${dataPlatform.summary.readyApps}/${dataPlatform.summary.observedApps} apps</span><span class="chip" style="--accent:#ff6b3d">metrics ${telemetry.summary.metricsStatus}</span></div></div></div><div class="orbital"><div class="core"><div><b>${scores.dataPlatformScore}</b><br><span>DATA LAB</span></div></div>${layers}</div></section><section class="status-strip">${metricTiles}</section><section class="views"><div class="view active" id="view-cockpit"><div class="panel wide"><h2>V14 大数据应用指挥舱</h2><div class="matrix"><button class="sonic" data-view="data" data-tone="ok">进入 Data Lab</button><button class="sonic" data-filter="spark-operator" data-tone="nav">Spark Operator 批处理控制</button><button class="sonic" data-filter="flink" data-tone="nav">Flink 实时流计算</button><button class="sonic" data-filter="kafka" data-tone="nav">Kafka 日志与事件总线</button><button class="sonic" data-filter="airflow" data-tone="tick">Airflow DAG 编排</button><button class="sonic" data-filter="trino" data-tone="tick">Trino 查询引擎</button><button class="sonic" data-filter="superset" data-tone="ok">Superset BI 展示</button><button class="sonic" data-filter="minio" data-tone="ok">MinIO 对象湖</button><button class="sonic" data-filter="upgrade-gate" data-tone="warn">升级体检门禁</button><button class="sonic" data-filter="metrics-server" data-tone="warn">Metrics API</button><button class="sonic" data-filter="node-version-skew" data-tone="warn">节点版本偏差</button></div></div></div><div class="view" id="view-data"><div class="panel wide"><h2>Big Data Application Lab</h2><div class="data-grid">${dataApps}</div></div><div class="panel wide"><h2>Data Flow Evidence Map</h2><div class="flow-map">${dataFlows}</div></div></div><div class="view" id="view-risk"><div class="panel wide" id="risk"><h2>Risk Radar</h2><div class="risk-list">${riskItems}</div></div></div><div class="view" id="view-recovery"><div class="panel wide" id="recovery"><h2>Recovery Room</h2><div class="playbooks">${playbookItems}</div></div></div><div class="view" id="view-stages"><div class="panel wide" id="stages"><h2>Intelligence Stage Ledger</h2>${stageBars}</div></div><div class="view" id="view-matrix"><div class="panel half"><h2>Command Matrix</h2><div class="matrix"><button class="sonic" data-filter="observability" data-tone="nav">Observability</button><button class="sonic" data-filter="data-platform" data-tone="nav">Data Platform</button><button class="sonic" data-filter="upgrade-gate" data-tone="warn">Upgrade Gate</button><button class="sonic" data-filter="recovery" data-tone="ok">Recovery</button><button class="sonic" data-filter="risk" data-tone="warn">Risk Queue</button><button class="sonic" data-filter="portal" data-tone="tick">Portal UX</button><button class="sonic" data-filter="dingtalk" data-tone="tick">DingTalk</button><button class="sonic" data-filter="zabbix" data-tone="nav">Zabbix</button><button class="sonic" data-filter="argocd" data-tone="nav">ArgoCD</button></div></div><div class="panel half"><h2>Drilldown Detail</h2><pre class="detail" id="detail">点击任意大数据应用、链路或升级体检按钮，会在这里展示对应 V14 证据。</pre></div></div></section></main><div class="sonic-toast" id="toast">click acknowledged</div><script id="v14-data" type="application/json">${evidenceJson}</script><script>
var data=JSON.parse(document.getElementById('v14-data').textContent);var detail=document.getElementById('detail');var toast=document.getElementById('toast');var soundEnabled=true;var audioCtx=null;function ensureAudio(){if(!audioCtx){audioCtx=new (window.AudioContext||window.webkitAudioContext)()}if(audioCtx.state==='suspended'){audioCtx.resume()}return audioCtx}function beep(kind){if(!soundEnabled)return;try{var ctx=ensureAudio();var now=ctx.currentTime;var osc=ctx.createOscillator();var gain=ctx.createGain();var map={nav:[520,740],warn:[240,160],ok:[660,990],tick:[880,1180]};var pair=map[kind]||map.tick;osc.type=kind==='warn'?'sawtooth':'triangle';osc.frequency.setValueAtTime(pair[0],now);osc.frequency.exponentialRampToValueAtTime(pair[1],now+.08);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.07,now+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+.16);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+.18)}catch(e){}}function acknowledge(el,kind){beep(kind||el.dataset.tone||'tick');toast.textContent=(el.textContent||'click').trim().slice(0,42);toast.classList.add('show');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(function(){toast.classList.remove('show')},900)}function ripple(el,ev){var r=document.createElement('span');r.className='ripple';var rect=el.getBoundingClientRect();r.style.left=((ev&&ev.clientX?ev.clientX:rect.left+rect.width/2)-rect.left)+'px';r.style.top=((ev&&ev.clientY?ev.clientY:rect.top+rect.height/2)-rect.top)+'px';el.appendChild(r);setTimeout(function(){r.remove()},650)}function showView(name){document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id==='view-'+name)});document.querySelectorAll('[data-view]').forEach(function(b){b.classList.toggle('active',b.dataset.view===name)})}function drill(q){q=String(q||'').toLowerCase();var appSource=(data.dataPlatform&&data.dataPlatform.apps)||[];var flowSource=(data.dataPlatform&&data.dataPlatform.flows)||[];var telemetrySource=[data.telemetry||{}].concat((data.telemetry&&data.telemetry.nodes)||[],(data.telemetry&&data.telemetry.recentUnhealthyEvents)||[]);detail.textContent=JSON.stringify({telemetry:telemetrySource.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)||q==='upgrade-gate'}).slice(0,20),dataApps:appSource.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,10),dataFlows:flowSource.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,10),risks:data.risks.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,10),stages:data.ledger.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,10),playbooks:data.playbooks.filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,10)},null,2)}document.addEventListener('pointerdown',function(ev){var el=ev.target.closest('button');if(!el)return;ripple(el,ev);acknowledge(el,el.dataset.tone)});document.querySelectorAll('[data-view]').forEach(function(b){b.addEventListener('click',function(){showView(b.dataset.view)})});document.querySelectorAll('[data-focus]').forEach(function(b){b.addEventListener('click',function(){showView('matrix');drill(b.dataset.focus)})});document.querySelectorAll('[data-filter]').forEach(function(b){b.addEventListener('click',function(){showView('matrix');drill(b.dataset.filter)})});document.querySelectorAll('[data-playbook]').forEach(function(b){b.addEventListener('click',function(){showView('matrix');drill(b.dataset.playbook)})});document.querySelectorAll('[data-stage]').forEach(function(b){b.addEventListener('click',function(){showView('matrix');drill(b.dataset.stage)})});document.getElementById('soundToggle').addEventListener('click',function(){soundEnabled=!soundEnabled;this.textContent=soundEnabled?'Sound ON':'Sound OFF';this.classList.toggle('sound-on',soundEnabled);this.classList.toggle('sound-off',!soundEnabled);if(soundEnabled)beep('ok')});document.getElementById('copyJson').addEventListener('click',async function(){var url=location.origin+location.pathname.replace(/\\/$/,'')+'/evidence.json';try{await navigator.clipboard.writeText(url);detail.textContent='copied '+url}catch(e){detail.textContent=url}});var c=document.getElementById('field'),ctx=c.getContext('2d'),pts=[];function size(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;pts=Array.from({length:130},function(_,i){return{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.9,vy:(Math.random()-.5)*.65,h:i%8,r:1+Math.random()*2}})}addEventListener('resize',size);size();var colors=['#00f0ff','#ff3df2','#ffe66d','#39ff88','#8b5cf6','#ff6b3d','#7dd3fc','#faff00'];function frame(){ctx.clearRect(0,0,c.width,c.height);ctx.globalCompositeOperation='lighter';pts.forEach(function(p){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>c.width)p.vx*=-1;if(p.y<0||p.y>c.height)p.vy*=-1});for(var i=0;i<pts.length;i++){for(var j=i+1;j<pts.length;j++){var a=pts[i],b=pts[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<135*devicePixelRatio){ctx.strokeStyle='rgba(0,240,255,'+(.11*(1-d/(135*devicePixelRatio)))+')';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}}}pts.forEach(function(p){ctx.fillStyle=colors[p.h];ctx.globalAlpha=.62;ctx.beginPath();ctx.arc(p.x,p.y,p.r*devicePixelRatio,0,Math.PI*2);ctx.fill()});ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';requestAnimationFrame(frame)}frame();setInterval(function(){fetch('evidence.json?ts='+Date.now(),{cache:'no-store'}).catch(function(){})},60000);
</script><script>
(function(){window.__v14SoundEngine='sound-rev-v2';var master=null,lastSoundAt=0;function context(){var C=window.AudioContext||window.webkitAudioContext;if(!C)return null;if(!audioCtx){audioCtx=new C();master=audioCtx.createGain();master.gain.value=.28;master.connect(audioCtx.destination)}if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx}window.ensureAudio=context;window.beep=function(kind){if(!soundEnabled)return;try{var ctx=context();if(!ctx)return;var now=ctx.currentTime;var tones={nav:[523.25,783.99,1046.5],warn:[196,146.83,98],ok:[659.25,987.77,1318.5],tick:[880,1174.66,1760]};var seq=tones[kind]||tones.tick;seq.forEach(function(freq,i){var osc=ctx.createOscillator();var gain=ctx.createGain();osc.type=kind==='warn'?'sawtooth':'triangle';osc.frequency.setValueAtTime(freq,now+i*.035);osc.frequency.exponentialRampToValueAtTime(freq*1.04,now+i*.035+.08);gain.gain.setValueAtTime(.0001,now+i*.035);gain.gain.exponentialRampToValueAtTime(kind==='warn'?.2:.16,now+i*.035+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+i*.035+.16);osc.connect(gain);gain.connect(master||ctx.destination);osc.start(now+i*.035);osc.stop(now+i*.035+.18)});lastSoundAt=Date.now();if(navigator.vibrate)navigator.vibrate(kind==='warn'?[18,20,18]:12)}catch(e){}};function flash(el,ev){if(!el)return;if(typeof ripple==='function')ripple(el,ev);if(typeof acknowledge==='function')acknowledge(el,el.dataset.tone||'tick')}document.addEventListener('click',function(ev){var el=ev.target.closest('button,.sonic,[role=button]');if(!el)return;context();if(Date.now()-lastSoundAt>120)flash(el,ev)},true);document.addEventListener('keydown',function(ev){if(ev.key!=='Enter'&&ev.key!==' ')return;var el=ev.target.closest('button,.sonic,[role=button]');if(!el)return;flash(el,ev)},true);var soundButton=document.getElementById('soundToggle');if(soundButton)soundButton.setAttribute('title','点击开启/关闭 V14 sound-rev-v2 提示音；浏览器或系统静音时仍会显示按钮反馈');})();
</script></body></html>`;
}

function buildAll() {
  const evidence = baseEvidence();
  const ledger = readLines('reports/v14-intelligence/stage-ledger.ndjson').map((line) => JSON.parse(line));
  const dataPlatform = buildDataPlatformModel(evidence);
  const telemetry = buildPlatformTelemetryModel();
  const risks = buildRiskVectors(evidence, ledger, dataPlatform, telemetry);
  const playbooks = buildPlaybooks(evidence, risks, dataPlatform, telemetry);
  const scores = calculateScores(evidence, ledger, risks, dataPlatform, telemetry);
  const events = buildObservabilityEvents(evidence, ledger, risks, playbooks, scores, dataPlatform, telemetry);
  const summary = { '@timestamp': now(), pipeline_version: 'v14', build, job, commit, semver, publicUrl: `https://${publicHost}/`, portalUrl: `http://192.168.1.58:${portalNodePort}/`, inheritedV13Build: evidence.summary?.build || 'unknown', scores, dataPlatform: dataPlatform.summary, telemetry: telemetry.summary, riskVectorTotal: risks.length, playbookTotal: playbooks.length, stageLedgerTotal: ledger.length, v13Summary: evidence.summary || {} };
  write('reports/v14-intelligence/evidence.json', JSON.stringify({ summary, scores, risks, playbooks, ledger, dataPlatform, telemetry, inherited: evidence }, null, 2) + '\n');
  write('reports/v14-data-platform-apps.json', JSON.stringify(dataPlatform, null, 2) + '\n');
  write('reports/v14-data-platform-apps.ndjson', dataPlatform.apps.concat(dataPlatform.flows).map((item) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v14', build, job, commit, ...item, type: item.source ? 'bigdata_flow_snapshot' : 'bigdata_app_snapshot' })).join('\n') + '\n');
  write('reports/v14-platform-telemetry.json', JSON.stringify(telemetry, null, 2) + '\n');
  write('reports/v14-platform-telemetry.ndjson', [telemetry.summary, ...telemetry.nodes, ...telemetry.recentUnhealthyEvents].map((item) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v14', build, job, commit, ...item, type: item.kubeletVersion ? 'upgrade_node_snapshot' : item.reason ? 'upgrade_event_snapshot' : 'platform_telemetry_snapshot' })).join('\n') + '\n');
  write('reports/v14-risk-score.json', JSON.stringify({ summary, scores, risks: risks.slice(0, 30) }, null, 2) + '\n');
  write('reports/v14-recovery-playbooks.json', JSON.stringify(playbooks, null, 2) + '\n');
  write('reports/v14-observability.ndjson', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('reports/v14-prometheus-metrics.prom', buildMetrics(evidence, risks, playbooks, scores, dataPlatform, telemetry));
  write('reports/v14-grafana-dashboard.json', JSON.stringify(buildGrafana(scores, dataPlatform, telemetry), null, 2) + '\n');
  write('reports/v14-kibana-dashboard.ndjson', buildKibana().map((object) => JSON.stringify(object)).join('\n') + '\n');
  write('reports/v14-portal/index.html', buildPortal(evidence, ledger, risks, playbooks, scores, telemetry));
  write('reports/v14-portal/evidence.json', JSON.stringify({ summary, scores, risks, playbooks, ledger, dataPlatform, telemetry }, null, 2) + '\n');
  console.log(`v14_build_complete events=${events.length} stages=${ledger.length} risks=${risks.length} score=${scores.intelligenceScore} data_score=${scores.dataPlatformScore}`);
}

function lintAll() {
  const required = ['reports/v14-intelligence/evidence.json','reports/v14-data-platform-apps.json','reports/v14-data-platform-apps.ndjson','reports/v14-platform-telemetry.json','reports/v14-platform-telemetry.ndjson','reports/v14-risk-score.json','reports/v14-recovery-playbooks.json','reports/v14-observability.ndjson','reports/v14-prometheus-metrics.prom','reports/v14-grafana-dashboard.json','reports/v14-kibana-dashboard.ndjson','reports/v14-portal/index.html','reports/v14-portal/evidence.json'];
  for (const file of required) { if (!exists(file)) throw new Error(`missing ${file}`); }
  const grafana = readJson('reports/v14-grafana-dashboard.json');
  if (!Array.isArray(grafana.panels) || grafana.panels.length < 12 || grafana.panels.length > 18) throw new Error(`grafana panel count should stay focused and reusable: ${grafana.panels?.length}`);
  const dashboardText = JSON.stringify(grafana);
  for (const needle of ['jenkins-v14-intelligence-es', 'state-timeline', 'status-history', 'nodeGraph', 'Big Data App Readiness', 'Big Data Flow State', 'Telemetry Upgrade Score', 'Probe Timeout Events']) if (!dashboardText.includes(needle)) throw new Error(`grafana missing ${needle}`);
  const kibanaLines = readLines('reports/v14-kibana-dashboard.ndjson');
  if (kibanaLines.length !== 10) throw new Error(`kibana should contain 1 universal data view, 8 visualizations and 1 dashboard, got: ${kibanaLines.length}`);
  const kibanaObjects = kibanaLines.map((line) => JSON.parse(line));
  const kibanaText = kibanaLines.join('\n');
  const kibanaDashboards = kibanaObjects.filter((object) => object.type === 'dashboard');
  if (kibanaText.includes('deep-lens')) throw new Error('kibana still contains fragmented deep-lens objects');
  if (kibanaDashboards.length !== 1) throw new Error(`kibana should expose one reusable dashboard: ${kibanaDashboards.length}`);
  for (const needle of ['zhanglab-platform-pipeline-observability', 'zhanglab-platform-observability-universal-command', 'Universal Observability Command', '通用流水线评分总览', '通用升级体检运行记录', '通用大数据应用就绪度', '通用大数据链路证据']) if (!kibanaText.includes(needle)) throw new Error(`kibana missing ${needle}`);
  const html = fs.readFileSync('reports/v14-portal/index.html', 'utf8');
  for (const needle of ['v14-intelligence-hypergrid-20260601', 'v14-sonic-command-20260601', 'sound-rev-v2', 'V14 Data Lab', 'Data Command', 'Big Data Application Lab', 'Data Flow Evidence Map', '升级体检门禁', 'Metrics API', 'Risk Radar', 'Recovery Room', 'Command Matrix', 'AudioContext', 'Sound ON', 'pointerdown', 'keydown']) if (!html.includes(needle)) throw new Error(`portal missing ${needle}`);
  console.log(`v14_lint=ok panels=${grafana.panels.length} kibana_objects=${kibanaLines.length}`);
}

if (action === 'check') recordCheck(checkKey, checkTitle);
else if (action === 'build') buildAll();
else if (action === 'lint') lintAll();
else throw new Error(`unknown action ${action}`);
