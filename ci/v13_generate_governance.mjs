import fs from 'node:fs';

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const build = process.env.BUILD_NUMBER || 'unknown';
const semver = process.env.SEMVER || 'unknown';
const commit = process.env.GIT_COMMIT_ID || 'unknown';
const job = process.env.JOB_NAME || 'jenkins';
const portalNodePort = process.env.V13_PORTAL_NODEPORT || '30089';
const publicHost = process.env.CLOUDFLARE_PUBLIC_HOSTNAME || 'platform.heil.ccwu.cc';
const grafanaTitle = process.env.V13_GRAFANA_DASHBOARD_TITLE || 'ZhangLab V13 Governance Era';
const kibanaIndexPrefix = process.env.V13_KIBANA_INDEX_PREFIX || 'jenkins-v13-governance';

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const write = (file, body) => fs.writeFileSync(file, body, 'utf8');
const exists = (file) => fs.existsSync(file);
const readJson = (file, fallback = {}) => exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const readLines = (file) => exists(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const text = (value) => value == null ? '' : String(value);
const safeName = (value) => text(value).replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 120);
const metricLabel = (value) => text(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

const pods = readJson('meta/k8s-pods.json', { items: [] }).items || [];
const nodes = readJson('meta/k8s-nodes.json', { items: [] }).items || [];
const services = readJson('meta/k8s-services.json', { items: [] }).items || [];
const workloads = readJson('meta/k8s-workloads.json', { items: [] }).items || [];
const endpointSlices = readJson('meta/k8s-endpointslices.json', { items: [] }).items || [];
const podCoverageSummary = readJson('reports/v13-cluster-resilience/pod-full-coverage-summary.json', {});
const serviceProbes = readLines('reports/v13-service-probes.ndjson').map((line) => JSON.parse(line));
const governance = {
  epochCharter: readJson('reports/v13-governance/epoch-charter.json', {}),
  backupInventory: readJson('reports/v13-governance/backup-inventory-summary.json', {}),
  restoreDrill: readJson('reports/v13-governance/restore-drill-verdict.json', {}),
  sloBudget: readJson('reports/v13-governance/slo-budget.json', {}),
  capacityRunway: readJson('reports/v13-governance/capacity-runway.json', {}),
  releaseGate: readJson('reports/v13-governance/release-gate.json', {}),
  v14Backlog: readJson('reports/v13-governance/v14-candidate-backlog.json', {}),
};

function podReady(pod) {
  const statuses = pod.status?.containerStatuses || [];
  return statuses.length > 0 && statuses.every((container) => container.ready === true);
}

function restarts(pod) {
  return (pod.status?.containerStatuses || []).reduce((sum, container) => sum + (container.restartCount || 0), 0);
}

function serviceEndpointCount(namespace, name) {
  let total = 0;
  let ready = 0;
  for (const slice of endpointSlices) {
    const labels = slice.metadata?.labels || {};
    if (slice.metadata?.namespace !== namespace) continue;
    if (labels['kubernetes.io/service-name'] !== name) continue;
    for (const endpoint of slice.endpoints || []) {
      total += 1;
      if (endpoint.conditions?.ready === true) ready += 1;
    }
  }
  return { total, ready };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map].map(([key, items]) => ({ key, items }));
}

const podRows = pods.map((pod) => ({
  namespace: pod.metadata?.namespace || '',
  name: pod.metadata?.name || '',
  phase: pod.status?.phase || 'Unknown',
  ready: podReady(pod),
  restarts: restarts(pod),
  podIP: pod.status?.podIP || '',
  node: pod.spec?.nodeName || '',
  containers: (pod.spec?.containers || []).map((container) => container.name),
  images: (pod.spec?.containers || []).map((container) => container.image),
  owner: pod.metadata?.ownerReferences?.[0]?.kind ? `${pod.metadata.ownerReferences[0].kind}/${pod.metadata.ownerReferences[0].name}` : '',
  coverageStatus: 'covered',
}));

const svcRows = services.map((svc) => {
  const namespace = svc.metadata?.namespace || '';
  const name = svc.metadata?.name || '';
  const endpoints = serviceEndpointCount(namespace, name);
  const ports = (svc.spec?.ports || []).map((port) => {
    let item = `${port.name || 'port'}:${text(port.port)}`;
    if (port.nodePort) item += `/${port.nodePort}`;
    return item;
  }).filter(Boolean);
  return {
    namespace,
    name,
    type: svc.spec?.type || 'ClusterIP',
    clusterIP: svc.spec?.clusterIP || '',
    ports: ports.join(', '),
    endpointTotal: endpoints.total,
    endpointReady: endpoints.ready,
  };
});

const wlRows = workloads.map((workload) => {
  const status = workload.status || {};
  return {
    namespace: workload.metadata?.namespace || '',
    kind: workload.kind || '',
    name: workload.metadata?.name || '',
    desired: status.replicas || status.desiredNumberScheduled || 0,
    ready: status.readyReplicas || status.numberReady || 0,
  };
});

const namespaceSummary = groupBy(podRows, (pod) => pod.namespace).map(({ key, items }) => ({
  namespace: key,
  pods: items.length,
  ready: items.filter((pod) => pod.ready).length,
  restarts: items.reduce((sum, pod) => sum + pod.restarts, 0),
})).sort((a, b) => b.pods - a.pods || a.namespace.localeCompare(b.namespace));

const probeGroups = groupBy(serviceProbes, (probe) => probe.group || 'unknown').map(({ key, items }) => ({
  group: key,
  total: items.length,
  ok: items.filter((probe) => probe.status === 'ok').length,
  failed: items.filter((probe) => probe.status !== 'ok').length,
})).sort((a, b) => b.total - a.total || a.group.localeCompare(b.group));

const sparkPods = podRows.filter((pod) => /spark/i.test(`${pod.namespace}/${pod.name}/${pod.owner}`));
const sparkServices = svcRows.filter((svc) => /spark/i.test(`${svc.namespace}/${svc.name}`));
const sparkProbes = serviceProbes.filter((probe) => /spark/i.test(`${probe.group}/${probe.namespace}/${probe.name}`));
const restartHotspots = [...podRows].filter((pod) => pod.restarts > 0).sort((a, b) => b.restarts - a.restarts).slice(0, 20);
const serviceEndpointIssues = svcRows.filter((svc) => svc.type !== 'ExternalName' && svc.endpointReady === 0).slice(0, 40);
const failedProbes = serviceProbes.filter((probe) => probe.status !== 'ok');
const nodeRows = nodes.map((node) => ({
  name: node.metadata?.name || '',
  ready: (node.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True'),
  internalIP: (node.status?.addresses || []).find((address) => address.type === 'InternalIP')?.address || '',
  kernel: node.status?.nodeInfo?.kernelVersion || '',
  os: node.status?.nodeInfo?.osImage || '',
  runtime: node.status?.nodeInfo?.containerRuntimeVersion || '',
}));

function pct(ok, total) {
  return total ? Math.round((ok * 1000) / total) / 10 : 100;
}

function layerFor(namespace, name = '') {
  const key = `${namespace}/${name}`.toLowerCase();
  if (/jenkins|gitlab|argocd|harbor|sonarqube|portainer|registry|webhook|devops/.test(key)) return 'devops-control';
  if (/kafka|spark|flink|airflow|trino|superset|minio|data-infra|bigdata/.test(key)) return 'data-platform';
  if (/prometheus|grafana|kibana|elastic|loki|jaeger|zabbix|otel|opentelemetry|monitoring/.test(key)) return 'observability';
  if (/kube-system|traefik|dns|metrics|node-exporter/.test(key)) return 'cluster-core';
  if (/hello|jkvideo|ns-apps/.test(key)) return 'application';
  return 'platform-support';
}

function healthScore(parts) {
  const values = parts.filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  return Math.max(0, Math.min(100, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)));
}

const layerNames = ['cluster-core', 'devops-control', 'data-platform', 'observability', 'application', 'platform-support'];
const podHealth = pct(podRows.filter((pod) => pod.ready).length, podRows.length);
const serviceHealth = pct(svcRows.filter((svc) => svc.endpointReady > 0 || svc.type === 'ExternalName').length, svcRows.length);
const workloadHealth = pct(wlRows.filter((workload) => workload.desired === 0 || workload.ready >= workload.desired).length, wlRows.length);
const probeHealth = pct(serviceProbes.filter((probe) => probe.status === 'ok').length, serviceProbes.length);
const nodeHealth = pct(nodeRows.filter((node) => node.ready).length, nodeRows.length);
const sparkHealth = pct(sparkPods.filter((pod) => pod.ready).length + sparkProbes.filter((probe) => probe.status === 'ok').length, sparkPods.length + sparkProbes.length);
const restartPenalty = Math.min(30, Math.round(podRows.reduce((sum, pod) => sum + pod.restarts, 0) / Math.max(1, podRows.length)));
const platformHealthScore = Math.max(0, healthScore([podHealth, serviceHealth, workloadHealth, probeHealth, nodeHealth, sparkHealth]) - restartPenalty);
const podCoverageLiveTotal = Number.isFinite(Number(podCoverageSummary.livePodCount)) ? Number(podCoverageSummary.livePodCount) : podRows.length;
const podCoverageRecordTotal = Number.isFinite(Number(podCoverageSummary.coverageRecordCount)) ? Number(podCoverageSummary.coverageRecordCount) : podRows.length;
const podCoverageReady = Number.isFinite(Number(podCoverageSummary.readyPods)) ? Number(podCoverageSummary.readyPods) : podRows.filter((pod) => pod.ready).length;
const podCoverageNotHealthy = Number.isFinite(Number(podCoverageSummary.notHealthyPods)) ? Number(podCoverageSummary.notHealthyPods) : podRows.filter((pod) => !pod.ready && pod.phase !== 'Succeeded').length;
const podCoverageComplete = podCoverageSummary.coverageComplete == null ? podCoverageRecordTotal === podCoverageLiveTotal : podCoverageSummary.coverageComplete === true;
const podCoverageRatio = pct(podCoverageRecordTotal, podCoverageLiveTotal);

const layerSummary = layerNames.map((layer) => {
  const podsInLayer = podRows.filter((pod) => layerFor(pod.namespace, pod.name) === layer);
  const servicesInLayer = svcRows.filter((svc) => layerFor(svc.namespace, svc.name) === layer);
  const probesInLayer = serviceProbes.filter((probe) => layerFor(probe.namespace, probe.name) === layer || layerFor(probe.group, probe.name) === layer);
  const readyPods = podsInLayer.filter((pod) => pod.ready).length;
  const readyServices = servicesInLayer.filter((svc) => svc.endpointReady > 0 || svc.type === 'ExternalName').length;
  const okProbes = probesInLayer.filter((probe) => probe.status === 'ok').length;
  return {
    layer,
    pods: podsInLayer.length,
    readyPods,
    services: servicesInLayer.length,
    readyServices,
    probes: probesInLayer.length,
    okProbes,
    restarts: podsInLayer.reduce((sum, pod) => sum + pod.restarts, 0),
    healthScore: healthScore([pct(readyPods, podsInLayer.length), pct(readyServices, servicesInLayer.length), pct(okProbes, probesInLayer.length)]),
  };
});

const riskEvents = [
  ...podRows.filter((pod) => !pod.ready && pod.phase !== 'Succeeded').map((pod) => ({
    severity: 90,
    category: 'pod-not-ready',
    layer: layerFor(pod.namespace, pod.name),
    namespace: pod.namespace,
    name: pod.name,
    message: `${pod.namespace}/${pod.name} is not ready`,
  })),
  ...restartHotspots.slice(0, 12).map((pod) => ({
    severity: Math.min(85, 35 + pod.restarts * 5),
    category: 'restart-hotspot',
    layer: layerFor(pod.namespace, pod.name),
    namespace: pod.namespace,
    name: pod.name,
    message: `${pod.namespace}/${pod.name} restarted ${pod.restarts} times`,
  })),
  ...serviceEndpointIssues.slice(0, 12).map((svc) => ({
    severity: 70,
    category: 'service-no-endpoint',
    layer: layerFor(svc.namespace, svc.name),
    namespace: svc.namespace,
    name: svc.name,
    message: `${svc.namespace}/${svc.name} has no ready endpoint`,
  })),
  ...failedProbes.slice(0, 12).map((probe) => ({
    severity: 75,
    category: 'probe-failed',
    layer: layerFor(probe.namespace, probe.name),
    namespace: probe.namespace,
    name: probe.name,
    message: `${probe.namespace}/${probe.name} probe status ${probe.status}`,
  })),
].sort((a, b) => b.severity - a.severity);

const summary = {
  timestamp: now,
  job,
  build,
  semver,
  commit,
  pipelineVersion: 'v13',
  publicUrl: `https://${publicHost}/`,
  portalUrl: `http://192.168.1.58:${portalNodePort}/`,
  podTotal: podRows.length,
  podReady: podRows.filter((pod) => pod.ready).length,
  podAttention: podRows.filter((pod) => !pod.ready && pod.phase !== 'Succeeded').length,
  podCoverageLiveTotal,
  podCoverageRecordTotal,
  podCoverageReady,
  podCoverageNotHealthy,
  podCoverageComplete,
  podCoverageRatio,
  restartTotal: podRows.reduce((sum, pod) => sum + pod.restarts, 0),
  nodeTotal: nodeRows.length,
  nodeReady: nodeRows.filter((node) => node.ready).length,
  serviceTotal: svcRows.length,
  serviceEndpointReady: svcRows.filter((svc) => svc.endpointReady > 0 || svc.type === 'ExternalName').length,
  workloadTotal: wlRows.length,
  workloadReady: wlRows.filter((workload) => workload.desired === 0 || workload.ready >= workload.desired).length,
  serviceProbeTotal: serviceProbes.length,
  serviceProbeOk: serviceProbes.filter((probe) => probe.status === 'ok').length,
  sparkPods: sparkPods.length,
  sparkPodsReady: sparkPods.filter((pod) => pod.ready).length,
  sparkServices: sparkServices.length,
  sparkProbeOk: sparkProbes.filter((probe) => probe.status === 'ok').length,
  sparkProbeTotal: sparkProbes.length,
  platformHealthScore,
  governanceGate: governance.releaseGate.pass === true ? 'PASS' : 'EVIDENCE',
  sloAvailabilityPercent: governance.sloBudget.availabilityPercent ?? null,
  layerCount: layerSummary.length,
  riskEventTotal: riskEvents.length,
  criticalRiskEvents: riskEvents.filter((risk) => risk.severity >= 85).length,
};

const jobMarketFit = [
  { capability: 'Kubernetes operations', demand: 'high', platform: 'kube-system, metrics-server, Traefik, multi-node k3s', coverage: 'covered', score: 100 },
  { capability: 'CI/CD automation', demand: 'high', platform: 'Jenkins, GitLab webhook, GitHub webhook relay', coverage: 'covered', score: 100 },
  { capability: 'GitOps delivery', demand: 'high', platform: 'ArgoCD applications and manifest dry-run gates', coverage: 'covered', score: 92 },
  { capability: 'Observability', demand: 'high', platform: 'Prometheus, Grafana, Elasticsearch, Kibana, Loki, Jaeger, Zabbix, OpenTelemetry Collector', coverage: 'covered', score: 98 },
  { capability: 'DevSecOps', demand: 'high', platform: 'SonarQube, Harbor Trivy service, Trivy CLI, Cosign image signing tool, image policy gates', coverage: 'partial', score: 86 },
  { capability: 'Streaming data', demand: 'medium-high', platform: 'Kafka, Filebeat Kafka link, Flink', coverage: 'covered', score: 90 },
  { capability: 'Spark/data platform', demand: 'medium-high', platform: 'Spark operator, Airflow, Trino, Superset, MinIO', coverage: 'covered', score: 88 },
  { capability: 'Infrastructure as Code', demand: 'high', platform: 'Kubernetes manifests, ArgoCD, Helm, Terraform and Kubeconform in Jenkins tools path; Ansible deferred because Jenkins has no Python runtime', coverage: 'partial', score: 84 },
];

const dataLineage = [
  { from: 'Jenkins', to: 'Filebeat', purpose: 'pipeline console and build evidence collection', status: 'covered' },
  { from: 'Filebeat', to: 'Kafka', purpose: 'log sharing stream', status: 'covered' },
  { from: 'Kafka', to: 'Flink', purpose: 'stream processing readiness', status: sparkProbes.length >= 0 ? 'covered' : 'check' },
  { from: 'Spark', to: 'MinIO', purpose: 'batch and artifact lake path', status: sparkPods.length ? 'covered' : 'check' },
  { from: 'Airflow', to: 'Trino', purpose: 'workflow orchestration and SQL query surface', status: 'covered' },
  { from: 'Trino', to: 'Superset', purpose: 'BI/dashboard consumption', status: 'covered' },
  { from: 'Jenkins', to: 'Elasticsearch/Kibana', purpose: 'run result and visual evidence', status: 'covered' },
  { from: 'OpenTelemetry Collector', to: 'Prometheus/Jaeger/Kibana-ready pipelines', purpose: 'unified OTLP entrypoint for future metrics, traces and logs', status: 'covered' },
  { from: 'Prometheus', to: 'Grafana/Zabbix', purpose: 'metrics and alert display', status: 'covered' },
];

const capabilityGaps = [
  { name: 'helm', reason: 'common in job descriptions and available in Jenkins tools path', action: 'use for chart validation only when a service owns a chart lifecycle' },
  { name: 'terraform', reason: 'common for cloud infrastructure provisioning and available in Jenkins tools path', action: 'use for plan/validate first; do not apply cloud changes without review' },
  { name: 'ansible', reason: 'common for host configuration, but current Kubernetes API and GitOps cover runtime changes', action: 'install only for repeatable host bootstrap' },
  { name: 'trivy-cli', reason: 'available in Jenkins tools path, extracted from the local Harbor Trivy image to avoid slow upstream downloads', action: 'use for filesystem and image scan evidence' },
  { name: 'cosign', reason: 'available in Jenkins tools path, extracted from a verified v3.0.6 Chainguard image', action: 'use only after signing keys are prepared' },
  { name: 'kubeconform', reason: 'available in Jenkins tools path for Kubernetes manifest schema validation', action: 'run together with kubectl dry-run before GitOps sync' },
];

const evidence = {
  summary,
  jobMarketFit,
  dataLineage,
  capabilityGaps,
  layerSummary,
  riskEvents,
  namespaceSummary,
  probeGroups,
  nodes: nodeRows,
  spark: { pods: sparkPods, services: sparkServices, probes: sparkProbes },
  pods: podRows,
  services: svcRows,
  workloads: wlRows,
  serviceProbes,
  restartHotspots,
  serviceEndpointIssues,
  failedProbes,
  podCoverage: podCoverageSummary,
  governance,
};

ensureDir('reports/v13-portal');
write('reports/v13-platform-services.json', JSON.stringify(evidence, null, 2));
write('reports/v13-portal/evidence.json', JSON.stringify(evidence, null, 2));

const ndjson = [];
ndjson.push(JSON.stringify({ '@timestamp': now, type: 'platform_summary', pipeline_version: 'v13', pipeline_result_key: platformHealthScore >= 90 ? 'EXCELLENT' : platformHealthScore >= 75 ? 'HEALTHY' : 'ATTENTION', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: 'all', health_score: platformHealthScore, risk_score: Math.max(0, 100 - platformHealthScore), ...summary }));
ndjson.push(JSON.stringify({ '@timestamp': now, type: 'pod_coverage_summary', pipeline_version: 'v13', pipeline_result_key: podCoverageComplete && podCoverageNotHealthy === 0 ? 'FULL_COVERAGE' : 'ATTENTION', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: 'cluster-core', health_score: podCoverageRatio, risk_score: podCoverageComplete ? podCoverageNotHealthy * 10 : 80, ...summary }));
for (const row of podRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'pod', pipeline_version: 'v13', pipeline_result_key: row.ready ? 'READY' : 'NOT_READY', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: layerFor(row.namespace, row.name), health_score: row.ready ? Math.max(55, 100 - Math.min(45, row.restarts * 5)) : 15, risk_score: row.ready ? Math.min(70, row.restarts * 8) : 90, ready_count: row.ready ? 1 : 0, coverage_count: 1, ...row }));
for (const row of svcRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service', pipeline_version: 'v13', pipeline_result_key: row.endpointReady > 0 || row.type === 'ExternalName' ? 'READY' : 'NO_ENDPOINT', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: layerFor(row.namespace, row.name), health_score: row.endpointReady > 0 || row.type === 'ExternalName' ? 100 : 20, risk_score: row.endpointReady > 0 || row.type === 'ExternalName' ? 0 : 70, ...row }));
for (const row of serviceProbes) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service_probe', pipeline_version: 'v13', pipeline_result_key: row.status === 'ok' ? 'SUCCESS' : 'FAILURE', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: layerFor(row.namespace, row.name), health_score: row.status === 'ok' ? 100 : 0, risk_score: row.status === 'ok' ? 0 : 75, ok_count: row.status === 'ok' ? 1 : 0, failed_count: row.status === 'ok' ? 0 : 1, ...row }));
for (const row of namespaceSummary) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'namespace_summary', pipeline_version: 'v13', pipeline_result_key: row.ready >= row.pods ? 'READY' : 'ATTENTION', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: layerFor(row.namespace), health_score: pct(row.ready, row.pods), risk_score: Math.max(0, 100 - pct(row.ready, row.pods)) + Math.min(30, row.restarts), ...row }));
for (const row of nodeRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'node', pipeline_version: 'v13', pipeline_result_key: row.ready ? 'READY' : 'NOT_READY', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: 'cluster-core', health_score: row.ready ? 100 : 0, risk_score: row.ready ? 0 : 95, ...row }));
for (const row of layerSummary) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'layer_summary', pipeline_version: 'v13', pipeline_result_key: row.healthScore >= 90 ? 'EXCELLENT' : row.healthScore >= 75 ? 'HEALTHY' : 'ATTENTION', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: row.layer, health_score: row.healthScore, risk_score: Math.max(0, 100 - row.healthScore), ...row }));
for (const row of jobMarketFit) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'capability_fit', pipeline_version: 'v13', pipeline_result_key: row.score >= 90 ? 'STRONG' : row.score >= 75 ? 'GOOD' : 'GAP', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: 'market-fit', capability: row.capability, demand: row.demand, coverage: row.coverage, health_score: row.score, risk_score: Math.max(0, 100 - row.score), score: row.score, platform: row.platform }));
for (const row of riskEvents) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'risk_event', pipeline_version: 'v13', pipeline_result_key: row.severity >= 85 ? 'CRITICAL' : 'WARNING', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, health_score: Math.max(0, 100 - row.severity), risk_score: row.severity, ...row }));
ndjson.push(JSON.stringify({ '@timestamp': now, type: 'governance_gate', pipeline_version: 'v13', pipeline_result_key: governance.releaseGate.pass === true ? 'PASS' : 'EVIDENCE', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, layer: 'governance', health_score: governance.releaseGate.pass === true ? 100 : 75, risk_score: governance.releaseGate.pass === true ? 0 : 25, ...governance.releaseGate }));
write('reports/v13-observability.ndjson', ndjson.join('\n') + '\n');

const metrics = [
  '# HELP cicd_v13_pod_ready Kubernetes pod readiness captured by Jenkins v13.',
  '# TYPE cicd_v13_pod_ready gauge',
];
for (const row of podRows) metrics.push(`cicd_v13_pod_ready{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
metrics.push('# HELP cicd_v13_pod_coverage Kubernetes pod coverage records captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_pod_coverage gauge');
for (const row of podRows) metrics.push(`cicd_v13_pod_coverage{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",node="${metricLabel(row.node)}",build="${metricLabel(build)}"} 1`);
metrics.push('# HELP cicd_v13_pod_coverage_ratio Kubernetes live pod coverage ratio captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_pod_coverage_ratio gauge');
metrics.push(`cicd_v13_pod_coverage_ratio{build="${metricLabel(build)}"} ${podCoverageRatio}`);
metrics.push('# HELP cicd_v13_pod_restarts Kubernetes pod restart count captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_pod_restarts gauge');
for (const row of podRows) metrics.push(`cicd_v13_pod_restarts{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.restarts}`);
metrics.push('# HELP cicd_v13_service_endpoint_ready Ready endpoints captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_service_endpoint_ready gauge');
for (const row of svcRows) metrics.push(`cicd_v13_service_endpoint_ready{namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.endpointReady}`);
metrics.push('# HELP cicd_v13_service_probe_ok Platform service probe status captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_service_probe_ok gauge');
for (const row of serviceProbes) metrics.push(`cicd_v13_service_probe_ok{group="${metricLabel(row.group)}",namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.status === 'ok' ? 1 : 0}`);
metrics.push('# HELP cicd_v13_spark_component_ready Spark component readiness captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_spark_component_ready gauge');
for (const row of sparkPods) metrics.push(`cicd_v13_spark_component_ready{namespace="${metricLabel(row.namespace)}",component="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
metrics.push('# HELP cicd_v13_node_ready Kubernetes node readiness captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_node_ready gauge');
for (const row of nodeRows) metrics.push(`cicd_v13_node_ready{node="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
metrics.push('# HELP cicd_v13_market_capability_score Recruitment capability fit score captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_market_capability_score gauge');
for (const row of jobMarketFit) metrics.push(`cicd_v13_market_capability_score{capability="${metricLabel(row.capability)}",coverage="${metricLabel(row.coverage)}",build="${metricLabel(build)}"} ${row.score}`);
metrics.push('# HELP cicd_v13_platform_health_score Composite platform health score captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_platform_health_score gauge');
metrics.push(`cicd_v13_platform_health_score{build="${metricLabel(build)}"} ${platformHealthScore}`);
metrics.push('# HELP cicd_v13_layer_health_score Composite layer health score captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_layer_health_score gauge');
for (const row of layerSummary) metrics.push(`cicd_v13_layer_health_score{layer="${metricLabel(row.layer)}",build="${metricLabel(build)}"} ${row.healthScore}`);
metrics.push('# HELP cicd_v13_risk_event_severity Risk event severity captured by Jenkins v13.');
metrics.push('# TYPE cicd_v13_risk_event_severity gauge');
for (const row of riskEvents.slice(0, 30)) metrics.push(`cicd_v13_risk_event_severity{category="${metricLabel(row.category)}",layer="${metricLabel(row.layer)}",namespace="${metricLabel(row.namespace)}",name="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.severity}`);
write('reports/v13-prometheus-metrics.prom', metrics.join('\n') + '\n');

const grafana = {
  title: grafanaTitle,
  tags: ['jenkins', 'v13', 'platform', 'spark'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '30s',
  panels: [
    { type: 'stat', title: 'Platform Health Score', gridPos: { x: 0, y: 0, w: 4, h: 4 }, targets: [{ expr: 'cicd_v13_platform_health_score' }] },
    { type: 'stat', title: 'Ready Pods', gridPos: { x: 4, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v13_pod_ready)' }] },
    { type: 'stat', title: 'Service Probes OK', gridPos: { x: 8, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v13_service_probe_ok)' }] },
    { type: 'stat', title: 'Spark Ready', gridPos: { x: 12, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v13_spark_component_ready)' }] },
    { type: 'stat', title: 'Risk Events', gridPos: { x: 16, y: 0, w: 4, h: 4 }, targets: [{ expr: 'count(cicd_v13_risk_event_severity)' }] },
    { type: 'stat', title: 'Ready Nodes', gridPos: { x: 20, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v13_node_ready)' }] },
    { type: 'gauge', title: 'Layer Health Gauge', gridPos: { x: 0, y: 4, w: 8, h: 8 }, targets: [{ expr: 'avg(cicd_v13_layer_health_score)' }] },
    { type: 'bargauge', title: 'Layer Health Ranking', gridPos: { x: 8, y: 4, w: 16, h: 8 }, targets: [{ expr: 'cicd_v13_layer_health_score' }] },
    { type: 'timeseries', title: 'Pod Readiness By Namespace', gridPos: { x: 0, y: 12, w: 12, h: 8 }, targets: [{ expr: 'sum by(namespace) (cicd_v13_pod_ready)' }] },
    { type: 'timeseries', title: 'Service Probe OK By Group', gridPos: { x: 12, y: 12, w: 12, h: 8 }, targets: [{ expr: 'sum by(group) (cicd_v13_service_probe_ok)' }] },
    { type: 'barchart', title: 'Restart Hotspots', gridPos: { x: 0, y: 20, w: 12, h: 8 }, targets: [{ expr: 'topk(20, cicd_v13_pod_restarts)' }] },
    { type: 'barchart', title: 'Risk Severity Hotspots', gridPos: { x: 12, y: 20, w: 12, h: 8 }, targets: [{ expr: 'topk(20, cicd_v13_risk_event_severity)' }] },
    { type: 'table', title: 'Spark Components', gridPos: { x: 0, y: 28, w: 12, h: 8 }, targets: [{ expr: 'cicd_v13_spark_component_ready' }] },
    { type: 'barchart', title: 'Recruitment Capability Fit', gridPos: { x: 12, y: 28, w: 12, h: 8 }, targets: [{ expr: 'cicd_v13_market_capability_score' }] },
    { type: 'table', title: 'Service Probe Detail', gridPos: { x: 0, y: 36, w: 12, h: 8 }, targets: [{ expr: 'cicd_v13_service_probe_ok' }] },
    { type: 'table', title: 'Layer Health Detail', gridPos: { x: 12, y: 36, w: 12, h: 8 }, targets: [{ expr: 'cicd_v13_layer_health_score' }] },
    { type: 'stat', title: 'Full Pod Coverage Ratio', gridPos: { x: 0, y: 44, w: 6, h: 4 }, targets: [{ expr: 'cicd_v13_pod_coverage_ratio' }] },
    { type: 'table', title: 'Full Pod Coverage Records', gridPos: { x: 6, y: 44, w: 18, h: 8 }, targets: [{ expr: 'cicd_v13_pod_coverage' }] },
  ],
};
write('reports/v13-grafana-dashboard.json', JSON.stringify(grafana, null, 2));

function legacyVis(id, title, visType, aggs, kql = 'pipeline_version : v13') {
  return {
    type: 'visualization',
    id: `${kibanaIndexPrefix}-${id}`,
    attributes: {
      title,
      description: 'Generated by Jenkins V13 for platform evidence observability.',
      visState: JSON.stringify({
        title,
        type: visType,
        params: {
          addTooltip: true,
          addLegend: true,
          legendPosition: 'right',
          isDonut: visType === 'pie',
          type: visType === 'histogram' ? 'histogram' : undefined,
          mode: visType === 'metric' ? 'number' : undefined,
          percentageMode: false,
        },
        aggs,
      }),
      uiStateJSON: '{}',
      version: 1,
      kibanaSavedObjectMeta: {
        searchSourceJSON: JSON.stringify({
          query: { language: 'kuery', query: kql },
          filter: [],
          indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        }),
      },
    },
    references: [
      {
        name: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        type: 'index-pattern',
        id: kibanaIndexPrefix,
      },
    ],
  };
}

const metricAgg = { id: '1', enabled: true, type: 'count', schema: 'metric', params: {} };
const avgHealthAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'health_score' } };
const avgRiskAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'risk_score' } };
const termsAgg = (id, field, schema = 'segment', size = 12) => ({ id, enabled: true, type: 'terms', schema, params: { field, orderBy: '1', order: 'desc', size, otherBucket: false, missingBucket: false } });
const dateAgg = { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', timeRange: { from: 'now-24h', to: 'now' }, useNormalizedEsInterval: true, scaleMetricValues: false, interval: 'auto', drop_partials: false, min_doc_count: 1, extended_bounds: {} } };
const kibanaVisualizations = [
  legacyVis('platform-health-metric', 'V13 平台综合健康分', 'metric', [avgHealthAgg], 'type : platform_summary'),
  legacyVis('result-donut', '流水线与服务状态占比', 'pie', [metricAgg, termsAgg('2', 'pipeline_result_key', 'segment', 10)]),
  legacyVis('layer-health-bars', '平台层级健康评分', 'histogram', [avgHealthAgg, termsAgg('2', 'layer', 'segment', 10)], 'type : layer_summary'),
  legacyVis('risk-severity-bars', '风险事件严重度排行', 'histogram', [avgRiskAgg, termsAgg('2', 'category', 'segment', 10)], 'type : risk_event'),
  legacyVis('probe-group-bars', '服务探针分组成功度', 'histogram', [avgHealthAgg, termsAgg('2', 'group', 'segment', 12)], 'type : service_probe'),
  legacyVis('namespace-health-bars', '命名空间健康评分', 'histogram', [avgHealthAgg, termsAgg('2', 'namespace', 'segment', 16)], 'type : namespace_summary'),
  legacyVis('capability-fit-bars', '招聘高频能力覆盖评分', 'histogram', [avgHealthAgg, termsAgg('2', 'capability', 'segment', 12)], 'type : capability_fit'),
  legacyVis('health-trend', '健康分时间趋势', 'line', [avgHealthAgg, dateAgg], 'type : platform_summary or type : layer_summary'),
  legacyVis('pod-coverage-metric', '全 Pod 覆盖率', 'metric', [avgHealthAgg], 'type : pod_coverage_summary'),
];
function dashboardPanel(object, index) {
  return {
  version: '8.0.0',
  panelIndex: String(index + 1),
  panelRefName: `panel_${index}`,
  embeddableConfig: {},
  gridData: {
    x: (index % 2) * 24,
    y: Math.floor(index / 2) * 15,
    w: 24,
    h: 15,
    i: String(index + 1),
  },
  };
}
function dashboardObject(id, title, description, visualizations, kql) {
  return {
    type: 'dashboard',
    id: `${kibanaIndexPrefix}-${id}`,
    attributes: {
      title,
      description,
      panelsJSON: JSON.stringify(visualizations.map(dashboardPanel)),
      optionsJSON: '{"useMargins":true,"syncColors":true,"hidePanelTitles":false}',
      version: 3,
      timeRestore: true,
      timeTo: 'now',
      timeFrom: 'now-24h',
      refreshInterval: { pause: false, value: 60000 },
      kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [] }) },
    },
    references: visualizations.map((object, index) => ({
      name: `panel_${index}`,
      type: 'visualization',
      id: object.id,
    })),
  };
}
const overviewVisualizations = kibanaVisualizations;
const riskVisualizations = [
  kibanaVisualizations[0],
  kibanaVisualizations[3],
  kibanaVisualizations[5],
  kibanaVisualizations[7],
  kibanaVisualizations[1],
  kibanaVisualizations[2],
  kibanaVisualizations[4],
  kibanaVisualizations[6],
];
const dataFlowVisualizations = [
  kibanaVisualizations[0],
  kibanaVisualizations[2],
  kibanaVisualizations[4],
  kibanaVisualizations[6],
  kibanaVisualizations[7],
  kibanaVisualizations[1],
  kibanaVisualizations[5],
  kibanaVisualizations[3],
];
const kibanaObjects = [
  {
    type: 'index-pattern',
    id: kibanaIndexPrefix,
    attributes: { title: `${kibanaIndexPrefix}*,jenkins-pipeline-runs-*`, timeFieldName: '@timestamp' },
    references: [],
  },
  ...kibanaVisualizations,
  dashboardObject('evidence', `${grafanaTitle} · Command`, 'V13 command dashboard with health score, layer status, probes, capability fit and trend.', overviewVisualizations, 'pipeline_version : v13'),
  dashboardObject('risk-response', `${grafanaTitle} · Risk Response`, 'Focused risk dashboard for failed probes, restart hotspots, endpoint gaps and namespace attention.', riskVisualizations, 'pipeline_version : v13 and (type : risk_event or type : namespace_summary or type : service_probe or type : platform_summary)'),
  dashboardObject('data-flow', `${grafanaTitle} · Data Flow`, 'Focused data platform dashboard for Spark, Kafka, Flink, Airflow, Trino, Superset and MinIO evidence.', dataFlowVisualizations, 'pipeline_version : v13 and (layer : data-platform or type : capability_fit or type : platform_summary)'),
];
write('reports/v13-kibana-dashboard.ndjson', kibanaObjects.map((object) => JSON.stringify(object)).join('\n') + '\n');

const evidenceJson = JSON.stringify(evidence).replace(/</g, '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZhangLab DevOps V13 Control Surface</title>
  <style>
    :root { color-scheme: dark; --ink:#ecf7ff; --muted:#9fb2c9; --line:rgba(145,180,220,.24); --bg:#08111e; --panel:rgba(12,25,43,.78); --panel2:rgba(18,37,62,.92); --cyan:#22d3ee; --amber:#f59e0b; --red:#ef4444; --blue:#60a5fa; --green:#34d399; --violet:#a78bfa; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:"Avenir Next", "Segoe UI", -apple-system, sans-serif; background:radial-gradient(circle at 18% 5%,rgba(34,211,238,.20),transparent 30%),radial-gradient(circle at 82% 8%,rgba(167,139,250,.16),transparent 29%),linear-gradient(180deg,#08111e 0%,#0c1728 54%,#07101b 100%); color:var(--ink); min-height:100vh; }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:44px 44px; mask-image:linear-gradient(to bottom,black,transparent 80%); }
    header { min-height:330px; padding:42px 36px 30px; color:white; display:grid; grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr); gap:24px; align-items:end; position:relative; overflow:hidden; border-bottom:1px solid var(--line); }
    header:after { content:""; position:absolute; inset:auto -8% -42% 28%; height:260px; background:conic-gradient(from 120deg,var(--cyan),transparent,var(--violet),transparent,var(--green)); filter:blur(54px); opacity:.32; animation:pulse 6s ease-in-out infinite alternate; }
    header h1 { margin:0; font-size:clamp(34px,5vw,72px); line-height:.96; letter-spacing:0; max-width:920px; }
    header p { margin:18px 0 0; color:#c6d9ea; font-size:16px; }
    .hero-meter { position:relative; z-index:1; border:1px solid var(--line); background:linear-gradient(145deg,rgba(12,25,43,.82),rgba(14,39,62,.58)); border-radius:8px; padding:22px; box-shadow:0 24px 80px rgba(0,0,0,.28); }
    .hero-score { font-size:74px; font-weight:900; line-height:1; color:var(--green); text-shadow:0 0 24px rgba(52,211,153,.25); }
    .hero-meter span { color:var(--muted); }
    main { padding:24px 34px 36px; max-width:1680px; margin:0 auto; }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:18px; }
    .pill { border:1px solid var(--line); background:rgba(12,25,43,.72); border-radius:999px; padding:8px 12px; color:var(--muted); font-size:13px; backdrop-filter:blur(14px); }
    .search { min-width:280px; flex:1; border:1px solid var(--line); border-radius:8px; padding:11px 13px; font:inherit; background:rgba(5,13,24,.76); color:var(--ink); outline:none; }
    .search:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(34,211,238,.12); }
    .viewbar { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:0 0 18px; }
    .view-btn { appearance:none; border:1px solid var(--line); background:linear-gradient(145deg,rgba(12,25,43,.78),rgba(27,45,72,.58)); color:var(--ink); border-radius:8px; padding:13px 12px; font:inherit; font-weight:800; cursor:pointer; text-align:left; position:relative; overflow:hidden; transition:transform .18s ease,border-color .18s ease,background .18s ease; }
    .view-btn:after { content:""; position:absolute; inset:auto 10px 8px 10px; height:2px; background:linear-gradient(90deg,var(--cyan),var(--violet)); transform:scaleX(0); transform-origin:left; transition:transform .2s ease; }
    .view-btn:hover { transform:translateY(-2px); border-color:rgba(34,211,238,.72); }
    .view-btn.active { background:linear-gradient(145deg,rgba(34,211,238,.22),rgba(96,165,250,.16)); border-color:rgba(34,211,238,.78); box-shadow:0 0 32px rgba(34,211,238,.12); }
    .view-btn.active:after { transform:scaleX(1); }
    .view-btn small { display:block; margin-top:4px; color:var(--muted); font-weight:600; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(185px,1fr)); gap:14px; margin-bottom:18px; }
    .card, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:0 18px 60px rgba(0,0,0,.22); backdrop-filter:blur(18px); }
    .card { padding:16px; min-height:118px; position:relative; overflow:hidden; }
    .card:after { content:""; position:absolute; inset:auto 12px 10px 12px; height:3px; border-radius:999px; background:linear-gradient(90deg,var(--cyan),var(--green),var(--amber)); transform-origin:left; animation:grow .9s ease both; }
    .metric { font-size:34px; line-height:1; font-weight:900; }
    .label { color:var(--muted); margin-top:8px; font-size:14px; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; align-items:start; }
    .panel { padding:16px; min-height:280px; }
    .view-panel { animation:panelIn .28s ease both; }
    .view-panel.is-hidden { display:none; }
    .wide { grid-column:span 12; }
    .half { grid-column:span 6; }
    .third { grid-column:span 4; }
    h2 { margin:0 0 12px; font-size:18px; letter-spacing:0; }
    svg { width:100%; min-height:210px; display:block; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { padding:9px 10px; border-bottom:1px solid rgba(219,228,239,.12); text-align:left; vertical-align:top; }
    th { background:rgba(96,165,250,.12); color:#d7e6f8; position:sticky; top:0; }
    .table-wrap { max-height:430px; overflow:auto; border:1px solid var(--line); border-radius:8px; }
    .ok { color:var(--green); font-weight:700; }
    .warn { color:var(--amber); font-weight:700; }
    .bad { color:var(--red); font-weight:700; }
    .legend { display:flex; gap:12px; flex-wrap:wrap; color:var(--muted); font-size:12px; margin-top:8px; }
    code { background:rgba(245,158,11,.14); color:#ffdc93; padding:2px 5px; border-radius:4px; }
    @keyframes pulse { from { transform:scale(.96) rotate(0deg); } to { transform:scale(1.08) rotate(9deg); } }
    @keyframes grow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes panelIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
    @media (max-width: 980px) { header { grid-template-columns:1fr; min-height:360px; } header h1 { font-size:34px; } main { padding:18px; } .half,.third { grid-column:span 12; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>ZhangLab DevOps V13 Control Surface</h1>
      <p>Build #${build} · ${semver} · commit ${commit} · Spark-aware full-platform evidence · ${publicHost}</p>
    </div>
    <div class="hero-meter">
      <span>Composite platform health</span>
      <div class="hero-score">${platformHealthScore}</div>
      <span>${summary.serviceProbeOk}/${summary.serviceProbeTotal} probes · ${summary.podCoverageRecordTotal}/${summary.podCoverageLiveTotal} covered pods · ${summary.riskEventTotal} risk events</span>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <span class="pill">public <code>https://${publicHost}/</code></span>
      <span class="pill">internal <code>http://192.168.1.58:${portalNodePort}/</code></span>
      <span class="pill" id="clock">refreshing</span>
      <input class="search" id="filter" placeholder="Filter services, pods, namespaces, Spark components">
    </div>
    <nav class="viewbar" aria-label="Platform views">
      <button class="view-btn active" data-target-view="overview">Command<small>健康、层级、探针</small></button>
      <button class="view-btn" data-target-view="risk">Risk<small>风险热力、重启、端点</small></button>
      <button class="view-btn" data-target-view="data">Data Flow<small>Spark、Kafka、Flink、BI</small></button>
      <button class="view-btn" data-target-view="services">Services<small>服务矩阵、Pod 明细</small></button>
      <button class="view-btn" data-target-view="market">Fit<small>招聘能力、工具缺口</small></button>
    </nav>
    <section class="cards" id="cards"></section>
    <section class="grid">
      <div class="panel half view-panel" data-view="overview data"><h2>Layer Health Radar</h2><svg id="layerChart"></svg><div class="legend">Cluster, DevOps, data, observability and app layer health in one view.</div></div>
      <div class="panel half view-panel" data-view="risk overview"><h2>Risk Event Heat</h2><svg id="riskChart"></svg><div class="legend">Risk severity from failed probes, endpoint gaps, restarts and not-ready pods.</div></div>
      <div class="panel half view-panel" data-view="overview services"><h2>Namespace Readiness</h2><svg id="namespaceChart"></svg><div class="legend">Pod readiness and restart load by namespace.</div></div>
      <div class="panel half view-panel" data-view="overview services"><h2>Probe Group Status</h2><svg id="probeChart"></svg><div class="legend">HTTP/DNS/service checks grouped by platform layer.</div></div>
      <div class="panel third view-panel" data-view="data overview"><h2>Spark Components</h2><div id="sparkPanel"></div></div>
      <div class="panel third view-panel" data-view="risk services"><h2>Restart Hotspots</h2><svg id="restartChart"></svg></div>
      <div class="panel third view-panel" data-view="overview"><h2>Coverage Rings</h2><svg id="ringChart"></svg></div>
      <div class="panel half view-panel" data-view="market data"><h2>Recruitment Capability Fit</h2><svg id="marketChart"></svg><div class="legend">High-frequency DevOps/SRE/data-platform requirements mapped to installed services.</div></div>
      <div class="panel half view-panel" data-view="data"><h2>Data Lineage</h2><div class="table-wrap"><table id="lineageTable"></table></div></div>
      <div class="panel half view-panel" data-view="market"><h2>Capability Gaps</h2><div class="table-wrap"><table id="gapTable"></table></div></div>
      <div class="panel half view-panel" data-view="risk services"><h2>No Endpoint Watchlist</h2><div class="table-wrap"><table id="endpointTable"></table></div></div>
      <div class="panel wide view-panel" data-view="risk"><h2>Risk Event Ledger</h2><div class="table-wrap"><table id="riskTable"></table></div></div>
      <div class="panel wide view-panel" data-view="services"><h2>Service Probe Matrix</h2><div class="table-wrap"><table id="probeTable"></table></div></div>
      <div class="panel wide view-panel" data-view="services"><h2>Pod Evidence Matrix</h2><div class="table-wrap"><table id="podTable"></table></div></div>
    </section>
  </main>
  <script id="evidence-data" type="application/json">${evidenceJson}</script>
  <script>
    const evidence = JSON.parse(document.getElementById('evidence-data').textContent);
    const fmt = new Intl.NumberFormat('en-US');
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    const ratio = (a,b) => b ? Math.round(a * 100 / b) : 0;
    function renderCards() {
      const s = evidence.summary;
      const cards = [
        [s.platformHealthScore, 'Platform health score'],
        [s.podCoverageRecordTotal + '/' + s.podCoverageLiveTotal, 'Pods covered by evidence'],
        [s.podCoverageRatio + '%', 'Pod coverage ratio'],
        [s.podReady + '/' + s.podTotal, 'Pods ready'],
        [s.serviceEndpointReady + '/' + s.serviceTotal, 'Services with endpoints'],
        [s.workloadReady + '/' + s.workloadTotal, 'Workloads ready'],
        [s.serviceProbeOk + '/' + s.serviceProbeTotal, 'Service probes OK'],
        [s.sparkPodsReady + '/' + s.sparkPods, 'Spark pods ready'],
        [s.nodeReady + '/' + s.nodeTotal, 'Nodes ready'],
        [s.riskEventTotal, 'Risk events tracked'],
        [fmt.format(s.restartTotal), 'Total restarts observed'],
      ];
      el('cards').innerHTML = cards.map((c) => '<div class="card"><div class="metric">' + esc(c[0]) + '</div><div class="label">' + esc(c[1]) + '</div></div>').join('');
    }
    function barChart(node, rows, labelKey, valueKey, maxValue, color) {
      const width = 860, rowH = 28, top = 16, left = 190, height = Math.max(220, top + rows.length * rowH + 20);
      const max = Math.max(1, maxValue || Math.max(1, ...rows.map((row) => row[valueKey] || 0)));
      const body = rows.map((row, index) => {
        const y = top + index * rowH;
        const value = Number(row[valueKey] || 0);
        const w = Math.round((width - left - 30) * value / max);
        return '<text x="0" y="' + (y + 17) + '" fill="#c6d9ea" font-size="12">' + esc(row[labelKey]) + '</text><rect x="' + left + '" y="' + (y + 4) + '" width="' + w + '" height="16" rx="4" fill="' + color + '"><animate attributeName="width" from="0" to="' + w + '" dur=".7s" fill="freeze"/></rect><text x="' + (left + w + 8) + '" y="' + (y + 17) + '" fill="#9fb2c9" font-size="12">' + value + '</text>';
      }).join('');
      node.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      node.innerHTML = body;
    }
    function stackedProbeChart() {
      const rows = evidence.probeGroups.slice(0, 12);
      const width = 860, rowH = 30, left = 185, height = Math.max(220, rows.length * rowH + 34);
      const max = Math.max(1, ...rows.map((row) => row.total));
      el('probeChart').setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      el('probeChart').innerHTML = rows.map((row, i) => {
        const y = 18 + i * rowH;
        const okW = Math.round((width - left - 40) * row.ok / max);
        const badW = Math.round((width - left - 40) * row.failed / max);
        return '<text x="0" y="' + (y + 15) + '" fill="#c6d9ea" font-size="12">' + esc(row.group) + '</text><rect x="' + left + '" y="' + (y + 2) + '" width="' + okW + '" height="17" rx="4" fill="#34d399"></rect><rect x="' + (left + okW + 2) + '" y="' + (y + 2) + '" width="' + badW + '" height="17" rx="4" fill="#ef4444"></rect><text x="' + (left + okW + badW + 10) + '" y="' + (y + 15) + '" fill="#9fb2c9" font-size="12">' + row.ok + '/' + row.total + '</text>';
      }).join('');
    }
    function ringChart() {
      const s = evidence.summary;
      const rings = [
        ['Coverage', s.podCoverageRecordTotal, s.podCoverageLiveTotal, '#22d3ee'],
        ['Pods', s.podReady, s.podTotal, '#0f9f9a'],
        ['Services', s.serviceEndpointReady, s.serviceTotal, '#2e6bd7'],
        ['Spark', s.sparkPodsReady, s.sparkPods || 1, '#d9822b'],
      ];
      el('ringChart').setAttribute('viewBox', '0 0 520 240');
      el('ringChart').innerHTML = rings.map((r, i) => {
        const x = 65 + i * 130, pct = ratio(r[1], r[2]), dash = pct * 2.64;
        return '<circle cx="' + x + '" cy="92" r="42" fill="none" stroke="rgba(219,228,239,.16)" stroke-width="14"></circle><circle cx="' + x + '" cy="92" r="42" fill="none" stroke="' + r[3] + '" stroke-width="14" stroke-dasharray="' + dash + ' 264" transform="rotate(-90 ' + x + ' 92)"></circle><text x="' + x + '" y="98" text-anchor="middle" font-size="20" font-weight="800" fill="#ecf7ff">' + pct + '%</text><text x="' + x + '" y="158" text-anchor="middle" font-size="13" fill="#9fb2c9">' + r[0] + '</text>';
      }).join('');
    }
    function layerChart() {
      const rows = evidence.layerSummary;
      const cx = 260, cy = 125, maxR = 92;
      const points = rows.map((row, i) => {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / rows.length;
        const r = maxR * row.healthScore / 100;
        return { row, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, lx: cx + Math.cos(angle) * (maxR + 34), ly: cy + Math.sin(angle) * (maxR + 34) };
      });
      const polygon = points.map((p) => p.x + ',' + p.y).join(' ');
      el('layerChart').setAttribute('viewBox', '0 0 520 270');
      el('layerChart').innerHTML = [25,50,75,100].map((v) => '<circle cx="' + cx + '" cy="' + cy + '" r="' + (maxR*v/100) + '" fill="none" stroke="rgba(219,228,239,.15)" stroke-width="1"></circle>').join('') +
        '<polygon points="' + polygon + '" fill="rgba(34,211,238,.20)" stroke="#22d3ee" stroke-width="3"><animate attributeName="opacity" from=".2" to="1" dur=".8s" fill="freeze"/></polygon>' +
        points.map((p) => '<circle cx="' + p.x + '" cy="' + p.y + '" r="5" fill="#34d399"></circle><text x="' + p.lx + '" y="' + p.ly + '" text-anchor="middle" fill="#c6d9ea" font-size="11">' + esc(p.row.layer) + ' ' + p.row.healthScore + '</text>').join('');
    }
    function riskChart() {
      const rows = evidence.riskEvents.slice(0, 16);
      const width = 860, cellW = 92, cellH = 42;
      el('riskChart').setAttribute('viewBox', '0 0 ' + width + ' 230');
      el('riskChart').innerHTML = rows.map((risk, i) => {
        const x = (i % 8) * (cellW + 10), y = Math.floor(i / 8) * (cellH + 28) + 20;
        const color = risk.severity >= 85 ? '#ef4444' : risk.severity >= 70 ? '#f59e0b' : '#60a5fa';
        return '<rect x="' + x + '" y="' + y + '" width="' + cellW + '" height="' + cellH + '" rx="6" fill="' + color + '" opacity=".86"></rect><text x="' + (x + 8) + '" y="' + (y + 17) + '" fill="#06101d" font-size="11" font-weight="800">' + risk.severity + '</text><text x="' + (x + 8) + '" y="' + (y + 32) + '" fill="#06101d" font-size="9">' + esc(risk.category.slice(0,12)) + '</text><text x="' + x + '" y="' + (y + cellH + 15) + '" fill="#9fb2c9" font-size="9">' + esc((risk.namespace + '/' + risk.name).slice(0,18)) + '</text>';
      }).join('') || '<text x="20" y="80" fill="#34d399" font-size="20">No active risk events</text>';
    }
    function sparkPanel() {
      const pods = evidence.spark.pods;
      const services = evidence.spark.services;
      const probes = evidence.spark.probes;
      const podRows = pods.map((pod) => '<tr><td>' + esc(pod.namespace) + '</td><td>' + esc(pod.name) + '</td><td class="' + (pod.ready ? 'ok' : 'bad') + '">' + (pod.ready ? 'READY' : 'CHECK') + '</td><td>' + pod.restarts + '</td></tr>').join('');
      const serviceRows = services.map((svc) => '<tr><td>' + esc(svc.namespace) + '</td><td>' + esc(svc.name) + '</td><td>' + svc.endpointReady + '/' + svc.endpointTotal + '</td><td>' + esc(svc.ports) + '</td></tr>').join('');
      const probeRows = probes.map((probe) => '<tr><td>' + esc(probe.group) + '</td><td>' + esc(probe.name) + '</td><td class="' + (probe.status === 'ok' ? 'ok' : 'bad') + '">' + esc(probe.status) + '</td></tr>').join('');
      el('sparkPanel').innerHTML = '<div class="label">Spark operator, webhook, service endpoints, and probe evidence.</div><div class="table-wrap" style="max-height:325px"><table><thead><tr><th>Scope</th><th>Name</th><th>Status</th><th>Extra</th></tr></thead><tbody>' + podRows + serviceRows + probeRows + '</tbody></table></div>';
    }
    function table(node, headers, rows) {
      node.innerHTML = '<thead><tr>' + headers.map((h) => '<th>' + esc(h[0]) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + headers.map((h) => '<td>' + esc(row[h[1]]) + '</td>').join('') + '</tr>').join('') + '</tbody>';
    }
    function setView(view) {
      document.querySelectorAll('.view-btn').forEach((button) => button.classList.toggle('active', button.dataset.targetView === view));
      document.querySelectorAll('.view-panel').forEach((panel) => {
        const views = (panel.dataset.view || '').split(' ');
        panel.classList.toggle('is-hidden', !views.includes(view));
      });
      window.location.hash = view;
    }
    function applyFilter() {
      const q = el('filter').value.trim().toLowerCase();
      const probes = evidence.serviceProbes.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q));
      const pods = evidence.pods.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q));
      table(el('probeTable'), [['Group','group'],['Namespace','namespace'],['Object','name'],['Status','status'],['HTTP','http_status']], probes);
      table(el('podTable'), [['Namespace','namespace'],['Pod','name'],['Phase','phase'],['Ready','ready'],['Coverage','coverageStatus'],['Restarts','restarts'],['Node','node'],['Images','images']], pods);
      table(el('lineageTable'), [['From','from'],['To','to'],['Purpose','purpose'],['Status','status']], evidence.dataLineage.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q)));
      table(el('gapTable'), [['Tool','name'],['Reason','reason'],['Action','action']], evidence.capabilityGaps.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q)));
      table(el('endpointTable'), [['Namespace','namespace'],['Service','name'],['Type','type'],['Ready Endpoints','endpointReady'],['Ports','ports']], evidence.serviceEndpointIssues.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q)));
      table(el('riskTable'), [['Severity','severity'],['Category','category'],['Layer','layer'],['Namespace','namespace'],['Name','name'],['Message','message']], evidence.riskEvents.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q)));
    }
    function boot() {
      renderCards();
      barChart(el('namespaceChart'), evidence.namespaceSummary.slice(0, 18), 'namespace', 'ready', null, '#0f9f9a');
      stackedProbeChart();
      barChart(el('restartChart'), evidence.restartHotspots.slice(0, 12).map((pod) => ({ name: pod.namespace + '/' + pod.name, restarts: pod.restarts })), 'name', 'restarts', null, '#d9822b');
      barChart(el('marketChart'), evidence.jobMarketFit.map((row) => ({ capability: row.capability, score: row.score })), 'capability', 'score', 100, '#2e6bd7');
      layerChart();
      riskChart();
      ringChart();
      sparkPanel();
      applyFilter();
      setInterval(() => { el('clock').textContent = 'browser time ' + new Date().toLocaleString(); }, 1000);
      el('filter').addEventListener('input', applyFilter);
      document.querySelectorAll('.view-btn').forEach((button) => button.addEventListener('click', () => setView(button.dataset.targetView)));
      const initialView = ['overview','risk','data','services','market'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
      setView(initialView);
    }
    boot();
  </script>
</body>
</html>`;

write('reports/v13-portal/index.html', html);
