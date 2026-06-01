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

const prometheusDs = { type: 'prometheus', uid: 'prometheus' };
const elasticDs = { type: 'elasticsearch', uid: 'jenkins-v13-governance-es' };
const graphThresholds = {
  mode: 'absolute',
  steps: [
    { color: 'red', value: null },
    { color: 'orange', value: 70 },
    { color: 'green', value: 90 },
  ],
};
function promTarget(expr, legendFormat = '', refId = 'A', format = 'time_series') {
  return {
    refId,
    datasource: prometheusDs,
    expr,
    legendFormat,
    format,
    interval: '',
  };
}
function panel(type, title, x, y, w, h, targets, options = {}) {
  return {
    type,
    title,
    datasource: options.datasource || prometheusDs,
    gridPos: { x, y, w, h },
    targets,
    description: options.description || '',
    fieldConfig: {
      defaults: {
        unit: options.unit || 'short',
        min: options.min,
        max: options.max,
        decimals: options.decimals,
        thresholds: options.thresholds || graphThresholds,
        color: options.color || { mode: 'palette-classic' },
        custom: options.custom || {},
      },
      overrides: options.overrides || [],
    },
    options: options.panelOptions || {},
  };
}
function statPanel(title, x, y, w, h, expr, options = {}) {
  return panel('stat', title, x, y, w, h, [promTarget(expr, options.legend || title)], {
    ...options,
    panelOptions: {
      colorMode: 'background',
      graphMode: 'area',
      justifyMode: 'center',
      orientation: 'auto',
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      textMode: 'auto',
      wideLayout: true,
      ...options.panelOptions,
    },
  });
}
function textPanel(title, x, y, w, h, content) {
  return {
    type: 'text',
    title,
    datasource: null,
    gridPos: { x, y, w, h },
    options: {
      mode: 'markdown',
      content,
    },
  };
}
function esTarget(query, refId = 'A') {
  return {
    refId,
    datasource: elasticDs,
    query,
    metrics: [{ id: '1', type: 'count' }],
    bucketAggs: [
      { id: '2', type: 'date_histogram', field: '@timestamp', settings: { interval: '30m', min_doc_count: 0 } },
    ],
    timeField: '@timestamp',
  };
}

const grafana = {
  title: grafanaTitle,
  uid: 'zhanglab-v13-observability-command',
  tags: ['jenkins', 'v13', 'platform', 'spark', 'kibana', 'dynamic-command-center'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 2,
  refresh: '15s',
  liveNow: true,
  editable: true,
  time: { from: 'now-24h', to: 'now' },
  links: [
    { title: 'V13 Portal', url: `https://${publicHost}/`, targetBlank: true, icon: 'external link' },
    { title: 'Kibana V13 Command', url: 'http://192.168.1.58:30061/app/dashboards#/view/jenkins-v13-governance-evidence', targetBlank: true, icon: 'dashboard' },
  ],
  templating: {
    list: [
      { name: 'namespace', type: 'query', datasource: prometheusDs, query: 'label_values(kube_pod_status_ready{condition="true"}, namespace)', includeAll: true, multi: true, current: { text: 'All', value: '$__all' }, refresh: 2, sort: 1 },
      { name: 'node', type: 'query', datasource: prometheusDs, query: 'label_values(kube_node_status_condition{condition="Ready"}, node)', includeAll: true, multi: true, current: { text: 'All', value: '$__all' }, refresh: 2, sort: 1 },
      { name: 'layer', type: 'custom', query: 'cluster-core,devops-control,data-platform,observability,application,platform-support', includeAll: true, multi: true, current: { text: 'All', value: '$__all' }, sort: 1 },
      { name: 'build', type: 'custom', query: `${build}`, includeAll: false, multi: false, current: { text: build, value: build }, sort: 3 },
    ],
  },
  annotations: {
    list: [
      {
        builtIn: 1,
        datasource: { type: 'grafana', uid: '-- Grafana --' },
        enable: true,
        hide: true,
        iconColor: 'rgba(0, 211, 255, 1)',
        name: 'Annotations & Alerts',
        type: 'dashboard',
      },
    ],
  },
  panels: [
    textPanel('V13 Dynamic Command Brief', 0, 0, 24, 3, `### ZhangLab V13 Observability Command Center\n\n**Build #${build} · ${semver} · commit ${commit}**  \n15 秒自动刷新，联动 Prometheus + Elasticsearch/Kibana，覆盖 Pod、Service、Spark、风险、招聘能力、数据链路与发布证据。`),
    statPanel('Live Health', 0, 3, 4, 4, '100 * sum(kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1) / count(kube_pod_status_ready{condition="true",namespace=~"$namespace"})', { unit: 'percent', min: 0, max: 100, decimals: 0 }),
    statPanel('Pods Ready', 4, 3, 4, 4, 'sum(kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1)', { decimals: 0 }),
    statPanel('Services Covered', 8, 3, 4, 4, 'count(kube_service_info{namespace=~"$namespace"})', { decimals: 0 }),
    statPanel('Spark Ready', 12, 3, 4, 4, 'sum(kube_pod_status_ready{condition="true",pod=~".*spark.*"} == 1)', { decimals: 0, color: { mode: 'thresholds' } }),
    statPanel('Pods Not Ready', 16, 3, 4, 4, 'count(kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 0)', { decimals: 0, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 1 }, { color: 'red', value: 5 }] } }),
    statPanel('24h Restarts', 20, 3, 4, 4, 'sum(increase(kube_pod_container_status_restarts_total{namespace=~"$namespace"}[24h]))', { decimals: 0 }),

    panel('gauge', 'Live Readiness Energy Core', 0, 7, 8, 8, [promTarget('100 * sum(kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1) / count(kube_pod_status_ready{condition="true",namespace=~"$namespace"})', 'live readiness')], { unit: 'percent', min: 0, max: 100, panelOptions: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdLabels: true, showThresholdMarkers: true } }),
    panel('bargauge', 'Namespace Readiness Ranking', 8, 7, 16, 8, [promTarget('100 * sum by(namespace) (kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1) / count by(namespace) (kube_pod_status_ready{condition="true",namespace=~"$namespace"})', '{{namespace}}')], { unit: 'percent', min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showUnfilled: true } }),

    panel('timeseries', 'Live Health Pulse', 0, 15, 12, 8, [promTarget('100 * sum(kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1) / count(kube_pod_status_ready{condition="true",namespace=~"$namespace"})', 'health')], { unit: 'percent', min: 0, max: 100, custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 28, gradientMode: 'hue', lineWidth: 3, showPoints: 'never' } }),
    panel('timeseries', 'Pod Readiness By Namespace', 12, 15, 12, 8, [promTarget('sum by(namespace) (kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1)', '{{namespace}}')], { decimals: 0, custom: { drawStyle: 'bars', fillOpacity: 55, gradientMode: 'opacity', lineWidth: 2, showPoints: 'never', stacking: { mode: 'normal', group: 'A' } } }),

    panel('state-timeline', 'Pod State Timeline', 0, 23, 12, 8, [promTarget('kube_pod_status_ready{condition="true",namespace=~"$namespace"}', '{{namespace}}/{{pod}}')], { min: 0, max: 1, panelOptions: { mergeValues: true, showValue: 'always', alignValue: 'center', rowHeight: 0.8 } }),
    panel('status-history', 'Node And Spark Availability Wall', 12, 23, 12, 8, [
      promTarget('kube_node_status_condition{condition="Ready",status="true",node=~"$node"}', 'node {{node}}', 'A'),
      promTarget('kube_pod_status_ready{condition="true",pod=~".*spark.*"}', 'spark {{pod}}', 'B'),
    ], { min: 0, max: 1, panelOptions: { showValue: 'never', rowHeight: 0.85 } }),

    panel('barchart', 'Restart Hotspots', 0, 31, 12, 8, [promTarget('topk(25, sum by(namespace,pod) (increase(kube_pod_container_status_restarts_total{namespace=~"$namespace"}[24h])))', '{{namespace}}/{{pod}}', 'A', 'table')], { decimals: 0, panelOptions: { orientation: 'horizontal', xTickLabelRotation: 0, xTickLabelSpacing: 0, showValue: 'always', stacking: 'none' } }),
    panel('heatmap', 'Restart Pressure Heatmap', 12, 31, 12, 8, [promTarget('sum by(namespace) (increase(kube_pod_container_status_restarts_total{namespace=~"$namespace"}[24h]))', '{{namespace}}')], { custom: { hideFrom: { tooltip: false, viz: false, legend: false } }, panelOptions: { calculate: true, cellGap: 2, color: { mode: 'scheme', scheme: 'Spectral', steps: 64 }, yAxis: { axisPlacement: 'left' } } }),

    panel('piechart', 'Not Ready Share By Namespace', 0, 39, 8, 7, [promTarget('sum by(namespace) (kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 0)', '{{namespace}}', 'A', 'table')], { panelOptions: { displayLabels: ['name', 'percent'], legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'] }, pieType: 'donut', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } }),
    panel('piechart', 'Ready Pod Share By Namespace', 8, 39, 8, 7, [promTarget('sum by(namespace) (kube_pod_status_ready{condition="true",namespace=~"$namespace"} == 1)', '{{namespace}}', 'A', 'table')], { panelOptions: { displayLabels: ['name', 'percent'], legend: { displayMode: 'table', placement: 'right', values: ['value', 'percent'] }, pieType: 'donut', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } }),
    panel('barchart', 'Deployment Availability', 16, 39, 8, 7, [promTarget('kube_deployment_status_replicas_available{namespace=~"$namespace"}', '{{namespace}}/{{deployment}}', 'A', 'table')], { decimals: 0, panelOptions: { orientation: 'horizontal', showValue: 'always' } }),

    panel('table', 'Service Inventory Matrix', 0, 46, 12, 9, [promTarget('kube_service_info{namespace=~"$namespace"}', '{{namespace}}/{{service}}', 'A', 'table')], { decimals: 0, panelOptions: { showHeader: true, sortBy: [{ desc: false, displayName: 'Value' }] } }),
    panel('table', 'Pod Readiness And Placement', 12, 46, 12, 9, [promTarget('kube_pod_status_ready{condition="true",namespace=~"$namespace"}', '{{namespace}}/{{pod}}', 'A', 'table')], { decimals: 0, panelOptions: { showHeader: true } }),

    panel('table', 'Deployment Detail Drilldown', 0, 55, 8, 8, [promTarget('kube_deployment_status_replicas_available{namespace=~"$namespace"}', '{{namespace}}/{{deployment}}', 'A', 'table')], { decimals: 0 }),
    panel('table', 'Spark Component Drilldown', 8, 55, 8, 8, [promTarget('kube_pod_status_ready{condition="true",pod=~".*spark.*"}', '{{namespace}}/{{pod}}', 'A', 'table')], { decimals: 0 }),
    panel('table', 'Node Condition Drilldown', 16, 55, 8, 8, [promTarget('kube_node_status_condition{node=~"$node"}', '{{node}}/{{condition}}/{{status}}', 'A', 'table')], { decimals: 0 }),

    panel('timeseries', 'Elasticsearch Imported V13 Events', 0, 63, 12, 8, [esTarget('pipeline_version:v13')], { datasource: elasticDs, decimals: 0, custom: { drawStyle: 'bars', fillOpacity: 65, gradientMode: 'opacity' } }),
    panel('timeseries', 'Kibana Risk Events Trend', 12, 63, 12, 8, [esTarget('pipeline_version:v13 AND type:risk_event')], { datasource: elasticDs, decimals: 0, custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 30, gradientMode: 'hue' } }),

    panel('bargauge', 'Service Inventory Distribution', 0, 71, 12, 8, [promTarget('count by(namespace) (kube_service_info{namespace=~"$namespace"})', '{{namespace}}')], { decimals: 0, panelOptions: { displayMode: 'lcd', orientation: 'horizontal', showUnfilled: true } }),
    panel('bargauge', 'Node Readiness', 12, 71, 12, 8, [promTarget('kube_node_status_condition{condition="Ready",status="true",node=~"$node"}', '{{node}}')], { min: 0, max: 1, decimals: 0, panelOptions: { displayMode: 'gradient', orientation: 'horizontal' } }),

    textPanel('Operational Links', 0, 79, 24, 3, `- Public portal: https://${publicHost}/\n- Internal V13 portal: http://192.168.1.58:${portalNodePort}/\n- Kibana: http://192.168.1.58:30061\n- Grafana: http://192.168.1.58:30084\n- Evidence source: Jenkins build #${build}`),
  ],
};
write('reports/v13-grafana-dashboard.json', JSON.stringify(grafana, null, 2));

function legacyVis(id, title, visType, aggs, kql = 'pipeline_version : v13', params = {}) {
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
          perPage: 12,
          showPartialRows: false,
          showMetricsAtAllLevels: false,
          type: visType === 'histogram' ? 'histogram' : undefined,
          mode: visType === 'metric' ? 'number' : undefined,
          percentageMode: false,
          valueAxes: visType === 'line' || visType === 'histogram' ? [{ id: 'ValueAxis-1', type: 'value', position: 'left', show: true, scale: { type: 'linear' }, labels: { show: true }, title: { text: '' } }] : undefined,
          categoryAxes: visType === 'line' || visType === 'histogram' ? [{ id: 'CategoryAxis-1', type: 'category', position: 'bottom', show: true, scale: { type: 'linear' }, labels: { show: true }, title: {} }] : undefined,
          seriesParams: visType === 'line' || visType === 'histogram' ? [{ show: true, type: visType === 'line' ? 'line' : 'histogram', mode: 'normal', data: { label: title, id: '1' }, valueAxis: 'ValueAxis-1', drawLinesBetweenPoints: true, showCircles: true }] : undefined,
          ...params,
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
const avgSeverityAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'severity' } };
const avgScoreAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'score' } };
const avgRestartsAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'restarts' } };
const avgEndpointAgg = { id: '1', enabled: true, type: 'avg', schema: 'metric', params: { field: 'endpointReady' } };
const termsAgg = (id, field, schema = 'segment', size = 12) => ({ id, enabled: true, type: 'terms', schema, params: { field, orderBy: '1', order: 'desc', size, otherBucket: false, missingBucket: false } });
const dateAgg = { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', timeRange: { from: 'now-24h', to: 'now' }, useNormalizedEsInterval: true, scaleMetricValues: false, interval: 'auto', drop_partials: false, min_doc_count: 1, extended_bounds: {} } };
const kibanaVisualizations = [
  legacyVis('platform-health-metric', 'V13 平台综合健康分', 'metric', [avgHealthAgg], 'type : platform_summary'),
  legacyVis('result-donut', '流水线与服务状态占比', 'pie', [metricAgg, termsAgg('2', 'pipeline_result_key', 'segment', 10)]),
  legacyVis('layer-health-bars', '平台层级健康评分', 'histogram', [avgHealthAgg, termsAgg('2', 'layer', 'segment', 10)], 'type : layer_summary'),
  legacyVis('risk-severity-bars', '风险事件严重度排行', 'histogram', [avgSeverityAgg, termsAgg('2', 'category', 'segment', 10)], 'type : risk_event'),
  legacyVis('risk-layer-donut', '风险层级分布', 'pie', [metricAgg, termsAgg('2', 'layer', 'segment', 8)], 'type : risk_event'),
  legacyVis('probe-group-bars', '服务探针分组成功度', 'histogram', [avgHealthAgg, termsAgg('2', 'group', 'segment', 12)], 'type : service_probe'),
  legacyVis('namespace-health-bars', '命名空间健康评分', 'histogram', [avgHealthAgg, termsAgg('2', 'namespace', 'segment', 16)], 'type : namespace_summary'),
  legacyVis('service-endpoint-bars', '服务 Endpoint Ready 分布', 'histogram', [avgEndpointAgg, termsAgg('2', 'name', 'segment', 18)], 'type : service'),
  legacyVis('restart-hotspots-bars', 'Pod 重启热点排行', 'histogram', [avgRestartsAgg, termsAgg('2', 'name', 'segment', 18)], 'type : pod'),
  legacyVis('capability-fit-bars', '招聘高频能力覆盖评分', 'histogram', [avgScoreAgg, termsAgg('2', 'capability', 'segment', 12)], 'type : capability_fit'),
  legacyVis('capability-coverage-donut', '能力覆盖状态占比', 'pie', [metricAgg, termsAgg('2', 'coverage', 'segment', 6)], 'type : capability_fit'),
  legacyVis('health-trend', '健康分时间趋势', 'line', [avgHealthAgg, dateAgg], 'type : platform_summary or type : layer_summary'),
  legacyVis('risk-trend', '风险分时间趋势', 'line', [avgRiskAgg, dateAgg], 'type : risk_event or type : platform_summary'),
  legacyVis('spark-status-donut', 'Spark 与数据平台状态', 'pie', [metricAgg, termsAgg('2', 'pipeline_result_key', 'segment', 8)], 'layer : data-platform or namespace : *spark* or group : *spark*'),
  legacyVis('pod-coverage-metric', '全 Pod 覆盖率', 'metric', [avgHealthAgg], 'type : pod_coverage_summary'),
  legacyVis('node-ready-donut', 'Node Ready 状态', 'pie', [metricAgg, termsAgg('2', 'pipeline_result_key', 'segment', 6)], 'type : node'),
  legacyVis('http-status-donut', 'HTTP 探针状态码占比', 'pie', [metricAgg, termsAgg('2', 'http_status', 'segment', 10)], 'type : service_probe'),
  legacyVis('latest-records-table', '最新 V13 观测记录', 'table', [metricAgg, termsAgg('2', 'type', 'bucket', 12), termsAgg('3', 'pipeline_result_key', 'bucket', 8), termsAgg('4', 'layer', 'bucket', 8)], 'pipeline_version : v13'),
  legacyVis('service-probe-table', '服务探针明细矩阵', 'table', [metricAgg, termsAgg('2', 'group', 'bucket', 12), termsAgg('3', 'namespace', 'bucket', 12), termsAgg('4', 'name', 'bucket', 20), termsAgg('5', 'status', 'bucket', 5)], 'type : service_probe'),
  legacyVis('pod-evidence-table', 'Pod 证据明细矩阵', 'table', [metricAgg, termsAgg('2', 'namespace', 'bucket', 12), termsAgg('3', 'name', 'bucket', 20), termsAgg('4', 'node', 'bucket', 10), termsAgg('5', 'pipeline_result_key', 'bucket', 6)], 'type : pod'),
  legacyVis('governance-gate-metric', '治理发布门禁证据', 'metric', [metricAgg], 'type : governance_gate'),
];
function dashboardPanel(object, index) {
  const columns = 3;
  const width = 16;
  return {
  version: '8.0.0',
  panelIndex: String(index + 1),
  panelRefName: `panel_${index}`,
  embeddableConfig: {},
  gridData: {
    x: (index % columns) * width,
    y: Math.floor(index / columns) * 14,
    w: width,
    h: 14,
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
      refreshInterval: { pause: false, value: 30000 },
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
  kibanaVisualizations[4],
  kibanaVisualizations[12],
  kibanaVisualizations[1],
  kibanaVisualizations[2],
  kibanaVisualizations[5],
  kibanaVisualizations[6],
  kibanaVisualizations[8],
  kibanaVisualizations[16],
  kibanaVisualizations[18],
];
const dataFlowVisualizations = [
  kibanaVisualizations[0],
  kibanaVisualizations[2],
  kibanaVisualizations[5],
  kibanaVisualizations[9],
  kibanaVisualizations[11],
  kibanaVisualizations[1],
  kibanaVisualizations[3],
  kibanaVisualizations[13],
  kibanaVisualizations[17],
];
const sparkVisualizations = [
  kibanaVisualizations[13],
  kibanaVisualizations[5],
  kibanaVisualizations[7],
  kibanaVisualizations[11],
  kibanaVisualizations[17],
  kibanaVisualizations[18],
];
const serviceVisualizations = [
  kibanaVisualizations[5],
  kibanaVisualizations[6],
  kibanaVisualizations[7],
  kibanaVisualizations[8],
  kibanaVisualizations[15],
  kibanaVisualizations[17],
  kibanaVisualizations[18],
  kibanaVisualizations[19],
];
const marketVisualizations = [
  kibanaVisualizations[9],
  kibanaVisualizations[10],
  kibanaVisualizations[0],
  kibanaVisualizations[2],
  kibanaVisualizations[11],
  kibanaVisualizations[16],
];
const kibanaObjects = [
  {
    type: 'index-pattern',
    id: kibanaIndexPrefix,
    attributes: { title: `${kibanaIndexPrefix}*,jenkins-pipeline-runs-*`, timeFieldName: '@timestamp' },
    references: [],
  },
  ...kibanaVisualizations,
  dashboardObject('evidence', `${grafanaTitle} · Neon Command`, 'V13 dynamic command dashboard with health score, layer status, probes, capability fit, timelines and service matrices.', overviewVisualizations, 'pipeline_version : v13'),
  dashboardObject('risk-response', `${grafanaTitle} · Risk Radar`, 'Focused risk dashboard for failed probes, restart hotspots, endpoint gaps and namespace attention.', riskVisualizations, 'pipeline_version : v13 and (type : risk_event or type : namespace_summary or type : service_probe or type : platform_summary or type : pod)'),
  dashboardObject('data-flow', `${grafanaTitle} · Data Flow Reactor`, 'Focused data platform dashboard for Spark, Kafka, Flink, Airflow, Trino, Superset and MinIO evidence.', dataFlowVisualizations, 'pipeline_version : v13 and (layer : data-platform or type : capability_fit or type : platform_summary or type : service_probe)'),
  dashboardObject('spark-command', `${grafanaTitle} · Spark Command`, 'Spark and big-data service command view.', sparkVisualizations, 'pipeline_version : v13 and (layer : data-platform or namespace : *spark* or group : *spark*)'),
  dashboardObject('service-matrix', `${grafanaTitle} · Service Matrix`, 'Full service, pod, endpoint, probe and namespace matrix.', serviceVisualizations, 'pipeline_version : v13 and (type : service or type : service_probe or type : pod or type : namespace_summary or type : node)'),
  dashboardObject('market-fit', `${grafanaTitle} · Market Fit`, 'Recruitment-demand capability coverage and platform maturity view.', marketVisualizations, 'pipeline_version : v13 and (type : capability_fit or type : platform_summary or type : layer_summary)'),
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
    :root {
      color-scheme: dark;
      --bg0:#050816; --bg1:#07121f; --bg2:#0a1f2b; --ink:#eef8ff; --muted:#9fb2c9;
      --line:rgba(158,192,231,.22); --panel:rgba(8,18,32,.70); --panel2:rgba(12,29,49,.88);
      --cyan:#22d3ee; --green:#34d399; --amber:#f59e0b; --red:#fb7185; --blue:#60a5fa; --magenta:#f472b6; --lime:#a3e635;
    }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body {
      margin:0; min-height:100vh; color:var(--ink); overflow-x:hidden;
      font-family:"Avenir Next","Segoe UI",-apple-system,BlinkMacSystemFont,sans-serif;
      background:
        radial-gradient(circle at 12% -8%,rgba(34,211,238,.32),transparent 32%),
        radial-gradient(circle at 85% 4%,rgba(244,114,182,.22),transparent 28%),
        radial-gradient(circle at 46% 48%,rgba(52,211,153,.12),transparent 34%),
        linear-gradient(135deg,var(--bg0),var(--bg1) 48%,var(--bg2));
    }
    body:before {
      content:""; position:fixed; inset:0; pointer-events:none; z-index:-2;
      background:
        linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),
        linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
      background-size:48px 48px; mask-image:linear-gradient(to bottom,#000 10%,transparent 88%);
    }
    body:after {
      content:""; position:fixed; inset:-40% -18% auto auto; width:70vw; height:70vw; z-index:-2; pointer-events:none;
      background:conic-gradient(from 45deg,rgba(34,211,238,.22),rgba(52,211,153,.08),rgba(245,158,11,.20),rgba(244,114,182,.16),rgba(34,211,238,.22));
      filter:blur(70px); opacity:.62; animation:aurora 12s ease-in-out infinite alternate;
    }
    #ambientCanvas { position:fixed; inset:0; width:100%; height:100%; z-index:-1; pointer-events:none; opacity:.44; }
    a { color:inherit; }
    .topbar {
      min-height:56px; padding:10px 30px; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:18px; align-items:center;
      border-bottom:1px solid rgba(158,192,231,.18); background:rgba(5,12,22,.68); backdrop-filter:blur(18px);
      position:sticky; top:0; z-index:24;
    }
    .brand { display:flex; gap:10px; align-items:center; font-weight:950; font-size:18px; }
    .brand-mark { width:30px; height:30px; border-radius:7px; display:grid; place-items:center; color:#04111f; background:linear-gradient(135deg,var(--cyan),var(--green)); box-shadow:0 0 24px rgba(34,211,238,.28); }
    .live-tape { min-width:0; overflow:hidden; border-inline:1px solid rgba(255,255,255,.08); }
    .live-track { display:flex; gap:28px; white-space:nowrap; width:max-content; animation:tape 26s linear infinite; color:#cfe5f7; font-size:12px; font-weight:800; }
    .top-actions { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
    .top-actions .chip { min-height:32px; display:inline-flex; align-items:center; }
    .shell { max-width:1780px; margin:0 auto; padding:26px 30px 42px; }
    .hero {
      min-height:420px; display:grid; grid-template-columns:minmax(0,1.06fr) minmax(360px,.94fr); gap:24px; align-items:stretch;
      padding:26px 30px 10px; position:relative;
    }
    .hero-copy, .command-core {
      border:1px solid var(--line); border-radius:8px; background:linear-gradient(145deg,rgba(8,18,32,.80),rgba(13,34,54,.55));
      box-shadow:0 28px 90px rgba(0,0,0,.35); backdrop-filter:blur(22px);
    }
    .hero-copy { padding:30px; display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; position:relative; }
    .hero-copy:before {
      content:""; position:absolute; inset:0; opacity:.45; pointer-events:none;
      background:linear-gradient(120deg,transparent 0%,rgba(34,211,238,.18) 24%,transparent 42%,rgba(245,158,11,.14) 64%,transparent 82%);
      transform:translateX(-60%); animation:sweep 8s linear infinite;
    }
    .signal-row { display:flex; gap:10px; flex-wrap:wrap; position:relative; z-index:1; }
    .signal {
      display:inline-flex; align-items:center; gap:8px; min-height:34px; padding:7px 11px; border-radius:999px;
      color:#d8ebff; border:1px solid rgba(255,255,255,.13); background:rgba(3,10,18,.38); font-size:12px; font-weight:800;
    }
    .signal i { width:8px; height:8px; border-radius:99px; background:var(--green); box-shadow:0 0 16px currentColor; display:inline-block; }
    h1 { position:relative; z-index:1; margin:40px 0 14px; max-width:980px; font-size:clamp(38px,6.4vw,92px); line-height:.92; letter-spacing:0; }
    .hero-sub { position:relative; z-index:1; margin:0; color:#c8d9ea; max-width:980px; font-size:17px; line-height:1.65; }
    .hero-actions { position:relative; z-index:1; display:flex; flex-wrap:wrap; gap:12px; margin-top:24px; }
    .action {
      appearance:none; border:1px solid var(--line); border-radius:8px; padding:12px 14px; color:var(--ink); cursor:pointer;
      background:rgba(5,14,24,.68); font:inherit; font-weight:900; transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;
    }
    .action.primary { border-color:rgba(34,211,238,.72); background:linear-gradient(135deg,rgba(34,211,238,.24),rgba(52,211,153,.14)); box-shadow:0 0 28px rgba(34,211,238,.12); }
    .action:hover { transform:translateY(-2px); border-color:rgba(245,158,11,.75); box-shadow:0 12px 38px rgba(0,0,0,.25); }
    .command-core { padding:22px; display:grid; grid-template-columns:1fr 1fr; gap:14px; overflow:hidden; }
    .health-orb {
      grid-row:span 2; min-height:328px; display:grid; place-items:center; position:relative; border-radius:8px;
      background:radial-gradient(circle at 50% 46%,rgba(34,211,238,.20),rgba(5,12,22,.10) 42%,rgba(5,12,22,.72));
      border:1px solid rgba(255,255,255,.11);
    }
    .health-orb svg { width:min(92%,350px); min-height:300px; filter:drop-shadow(0 0 24px rgba(34,211,238,.18)); }
    .health-center { position:absolute; text-align:center; }
    .score { font-size:76px; line-height:1; font-weight:950; color:var(--green); text-shadow:0 0 26px rgba(52,211,153,.35); }
    .score-label { color:var(--muted); font-size:13px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .mini-stat {
      min-height:156px; padding:16px; border-radius:8px; border:1px solid rgba(255,255,255,.12);
      background:linear-gradient(160deg,rgba(12,30,52,.76),rgba(5,13,24,.62)); position:relative; overflow:hidden;
    }
    .mini-stat:after { content:""; position:absolute; left:14px; right:14px; bottom:12px; height:3px; border-radius:99px; background:linear-gradient(90deg,var(--cyan),var(--lime),var(--amber)); transform-origin:left; animation:grow .95s ease both; }
    .mini-value { font-size:36px; line-height:1; font-weight:950; }
    .mini-label { margin-top:8px; color:var(--muted); font-size:13px; }
    .mini-spark { position:absolute; left:14px; right:14px; bottom:26px; height:42px; opacity:.7; }
    .control-strip {
      position:sticky; top:0; z-index:12; margin:8px 0 18px; padding:10px; border:1px solid var(--line); border-radius:8px;
      background:rgba(5,13,24,.78); backdrop-filter:blur(22px); box-shadow:0 16px 44px rgba(0,0,0,.24);
      display:grid; grid-template-columns:minmax(260px,1fr) auto; gap:12px; align-items:center;
    }
    .search {
      width:100%; border:1px solid rgba(255,255,255,.13); border-radius:8px; padding:13px 14px; font:inherit; color:var(--ink);
      background:rgba(3,9,18,.76); outline:none;
    }
    .search:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(34,211,238,.14); }
    .chip-row { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .chip {
      border:1px solid rgba(255,255,255,.13); background:rgba(13,30,50,.72); color:#d8ebff; border-radius:999px;
      padding:8px 10px; font-size:12px; font-weight:800;
    }
    .viewbar { display:grid; grid-template-columns:repeat(6,minmax(120px,1fr)); gap:10px; margin-bottom:16px; }
    .view-btn {
      min-height:76px; appearance:none; text-align:left; border:1px solid var(--line); color:var(--ink); border-radius:8px;
      padding:13px; background:linear-gradient(145deg,rgba(10,25,43,.82),rgba(14,39,62,.44)); cursor:pointer; font:inherit; font-weight:950;
      position:relative; overflow:hidden; transition:transform .18s ease,border-color .18s ease,background .18s ease;
    }
    .view-btn:before { content:""; position:absolute; inset:0; opacity:0; background:radial-gradient(circle at 18% 12%,rgba(34,211,238,.30),transparent 42%); transition:opacity .2s ease; }
    .view-btn:after { content:""; position:absolute; left:12px; right:12px; bottom:9px; height:3px; background:linear-gradient(90deg,var(--cyan),var(--green),var(--amber),var(--magenta)); border-radius:99px; transform:scaleX(0); transform-origin:left; transition:transform .2s ease; }
    .view-btn:hover { transform:translateY(-2px); border-color:rgba(34,211,238,.68); }
    .view-btn.active { background:linear-gradient(145deg,rgba(34,211,238,.22),rgba(245,158,11,.10),rgba(244,114,182,.12)); border-color:rgba(34,211,238,.82); }
    .view-btn.active:before { opacity:1; }
    .view-btn.active:after { transform:scaleX(1); }
    .view-btn span, .view-btn small { position:relative; z-index:1; }
    .view-btn small { display:block; margin-top:6px; color:var(--muted); font-weight:700; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(174px,1fr)); gap:12px; margin-bottom:16px; }
    .card, .panel {
      border:1px solid var(--line); border-radius:8px; background:var(--panel); box-shadow:0 20px 64px rgba(0,0,0,.24); backdrop-filter:blur(18px);
    }
    .card { min-height:132px; padding:15px; position:relative; overflow:hidden; }
    .card:before { content:""; position:absolute; inset:-30% auto auto -20%; width:120px; height:120px; border-radius:50%; background:var(--accent,var(--cyan)); opacity:.18; filter:blur(22px); }
    .metric { position:relative; font-size:34px; line-height:1; font-weight:950; }
    .label { position:relative; color:var(--muted); margin-top:8px; font-size:13px; line-height:1.35; }
    .sparkline { position:absolute; left:12px; right:12px; bottom:12px; height:34px; opacity:.72; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; align-items:start; }
    .panel { min-height:288px; padding:16px; overflow:hidden; }
    .panel-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:10px; }
    h2 { margin:0; font-size:17px; letter-spacing:0; }
    .sub { color:var(--muted); font-size:12px; line-height:1.45; margin-top:4px; }
    .panel-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .mini-btn { border:1px solid rgba(255,255,255,.13); background:rgba(3,10,18,.42); color:#d8ebff; border-radius:6px; padding:6px 8px; font:inherit; font-size:11px; font-weight:800; cursor:pointer; }
    .mini-btn.active { border-color:var(--amber); color:#ffe0a6; background:rgba(245,158,11,.12); }
    svg { width:100%; min-height:224px; display:block; }
    .wide { grid-column:span 12; } .half { grid-column:span 6; } .third { grid-column:span 4; } .two-third { grid-column:span 8; }
    .view-panel { animation:panelIn .28s ease both; }
    .view-panel.is-hidden { display:none; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { padding:9px 10px; border-bottom:1px solid rgba(219,228,239,.11); text-align:left; vertical-align:top; }
    th { color:#dcecff; background:rgba(96,165,250,.12); position:sticky; top:0; z-index:1; }
    tbody tr { transition:background .14s ease; }
    tbody tr:hover { background:rgba(34,211,238,.07); }
    .table-wrap { max-height:460px; overflow:auto; border:1px solid rgba(255,255,255,.10); border-radius:8px; }
    .flow-lane { min-height:310px; position:relative; }
    .flow-node { position:absolute; width:128px; min-height:62px; padding:10px; border:1px solid rgba(255,255,255,.16); border-radius:8px; background:rgba(6,18,32,.78); box-shadow:0 0 32px rgba(34,211,238,.08); }
    .flow-node strong { display:block; font-size:13px; }
    .flow-node span { color:var(--muted); font-size:11px; }
    .flow-line { position:absolute; height:2px; background:linear-gradient(90deg,var(--cyan),var(--green),var(--amber)); transform-origin:left; box-shadow:0 0 18px rgba(34,211,238,.35); animation:flowPulse 2.2s linear infinite; }
    .ok { color:var(--green); font-weight:900; } .warn { color:var(--amber); font-weight:900; } .bad { color:var(--red); font-weight:900; }
    .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:currentColor; box-shadow:0 0 12px currentColor; }
    code { background:rgba(245,158,11,.13); color:#ffe0a6; padding:2px 5px; border-radius:4px; }
    .toast {
      position:fixed; right:18px; bottom:18px; z-index:30; max-width:min(420px,calc(100vw - 36px));
      padding:12px 14px; border:1px solid rgba(34,211,238,.45); border-radius:8px; background:rgba(4,12,22,.88);
      color:#dff7ff; box-shadow:0 18px 60px rgba(0,0,0,.34); opacity:0; transform:translateY(14px); transition:.22s ease;
    }
    .toast.show { opacity:1; transform:translateY(0); }
    @keyframes aurora { from { transform:translate3d(0,0,0) rotate(0deg) scale(.92); } to { transform:translate3d(-8%,8%,0) rotate(18deg) scale(1.06); } }
    @keyframes sweep { from { transform:translateX(-70%); } to { transform:translateX(90%); } }
    @keyframes tape { from { transform:translateX(2%); } to { transform:translateX(-50%); } }
    @keyframes grow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    @keyframes panelIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes flowPulse { from { filter:hue-rotate(0deg); opacity:.45; } 50% { opacity:1; } to { filter:hue-rotate(80deg); opacity:.45; } }
    @media (prefers-reduced-motion: reduce) { *, *:before, *:after { animation:none !important; transition:none !important; } }
    @media (max-width: 1180px) { .hero { grid-template-columns:1fr; } .viewbar { grid-template-columns:repeat(3,1fr); } .half,.third,.two-third { grid-column:span 12; } .command-core { grid-template-columns:1fr; } .health-orb { grid-row:auto; } }
    @media (max-width: 720px) { .topbar { grid-template-columns:1fr; padding:10px 14px; } .top-actions { justify-content:flex-start; } .shell,.hero { padding-left:14px; padding-right:14px; } h1 { font-size:40px; } .control-strip { grid-template-columns:1fr; } .chip-row { justify-content:flex-start; } .viewbar { grid-template-columns:1fr 1fr; } .cards { grid-template-columns:1fr 1fr; } }
  </style>
</head>
<body>
  <canvas id="ambientCanvas" aria-hidden="true"></canvas>
  <div class="topbar">
    <div class="brand"><span class="brand-mark">Z</span><span>ZhangLab</span><span class="signal">V13</span></div>
    <div class="live-tape" aria-label="Live platform status">
      <div class="live-track">
        <span>LIVE · build #${build} · ${semver}</span>
        <span>Platform Health ${platformHealthScore}</span>
        <span>Pods ${summary.podReady}/${summary.podTotal}</span>
        <span>Services ${summary.serviceEndpointReady}/${summary.serviceTotal}</span>
        <span>Probes ${summary.serviceProbeOk}/${summary.serviceProbeTotal}</span>
        <span>Spark ${summary.sparkPodsReady}/${summary.sparkPods}</span>
        <span>Risk Events ${summary.riskEventTotal}</span>
        <span>Coverage ${summary.podCoverageRatio}%</span>
        <span>LIVE · build #${build} · ${semver}</span>
        <span>Platform Health ${platformHealthScore}</span>
        <span>Pods ${summary.podReady}/${summary.podTotal}</span>
        <span>Services ${summary.serviceEndpointReady}/${summary.serviceTotal}</span>
      </div>
    </div>
    <div class="top-actions"><span class="chip">Asia/Shanghai</span><span class="chip">refresh 60s</span></div>
  </div>
  <section class="hero">
    <div class="hero-copy">
      <div class="signal-row">
        <span class="signal"><i></i>V13 new era</span>
        <span class="signal"><i style="background:var(--cyan)"></i>auto refresh 60s</span>
        <span class="signal"><i style="background:var(--amber)"></i>Spark aware</span>
        <span class="signal"><i style="background:var(--magenta)"></i>observability ready</span>
      </div>
      <div>
        <h1>ZhangLab V13 Command Center</h1>
        <p class="hero-sub">Build #${build} · ${semver} · commit ${commit} · full-platform evidence cockpit. 这版不再把所有数据平铺出来，而是按健康、风险、数据链路、服务矩阵和招聘能力覆盖分层展示。</p>
        <div class="hero-actions">
          <button class="action primary" data-jump-view="overview">进入总览</button>
          <button class="action" data-jump-view="risk">查看风险</button>
          <button class="action" data-jump-view="data">数据链路</button>
          <button class="action" id="copyEvidence">复制证据地址</button>
        </div>
      </div>
      <div class="signal-row">
        <span class="signal">public <code>https://${publicHost}/</code></span>
        <span class="signal">internal <code>http://192.168.1.58:${portalNodePort}/</code></span>
      </div>
    </div>
    <div class="command-core">
      <div class="health-orb">
        <svg id="healthOrb" aria-label="Platform health core"></svg>
        <div class="health-center">
          <div class="score">${platformHealthScore}</div>
          <div class="score-label">platform health</div>
        </div>
      </div>
      <div class="mini-stat">
        <div class="mini-value">${summary.serviceProbeOk}/${summary.serviceProbeTotal}</div>
        <div class="mini-label">service probes ok</div>
        <svg class="mini-spark" id="heroProbeSpark"></svg>
      </div>
      <div class="mini-stat">
        <div class="mini-value">${summary.podCoverageRecordTotal}/${summary.podCoverageLiveTotal}</div>
        <div class="mini-label">pods covered by evidence</div>
        <svg class="mini-spark" id="heroCoverageSpark"></svg>
      </div>
    </div>
  </section>
  <main class="shell">
    <div class="control-strip">
      <input class="search" id="filter" placeholder="搜索 service / pod / namespace / Spark / risk / image">
      <div class="chip-row">
        <span class="chip" id="clock">browser time syncing</span>
        <span class="chip" id="syncStatus">evidence loaded</span>
        <span class="chip">job ${job}</span>
        <span class="chip">nodePort ${portalNodePort}</span>
      </div>
    </div>
    <nav class="viewbar" aria-label="Platform views">
      <button class="view-btn active" data-target-view="overview"><span>Overview</span><small>健康核心、层级雷达、探针</small></button>
      <button class="view-btn" data-target-view="risk"><span>Risk</span><small>热力、重启、端点、故障</small></button>
      <button class="view-btn" data-target-view="data"><span>Data Flow</span><small>Spark、Kafka、Flink、MinIO</small></button>
      <button class="view-btn" data-target-view="services"><span>Services</span><small>服务矩阵、Pod 明细</small></button>
      <button class="view-btn" data-target-view="market"><span>Market Fit</span><small>招聘能力、工具覆盖</small></button>
      <button class="view-btn" data-target-view="evidence"><span>Evidence</span><small>原始证据、审计线索</small></button>
    </nav>
    <section class="cards" id="cards"></section>
    <section class="grid">
      <div class="panel half view-panel" data-view="overview data">
        <div class="panel-head"><div><h2>Layer Health Radar</h2><div class="sub">平台按 cluster、DevOps、data、observability、application 分层评分。</div></div><div class="panel-actions"><button class="mini-btn active">radar</button></div></div>
        <svg id="layerChart"></svg>
      </div>
      <div class="panel half view-panel" data-view="overview risk">
        <div class="panel-head"><div><h2>Risk Event Heat</h2><div class="sub">风险块越亮，越需要优先查看。</div></div><div class="panel-actions"><button class="mini-btn active" data-risk-mode="all">all</button><button class="mini-btn" data-risk-mode="critical">critical</button></div></div>
        <svg id="riskChart"></svg>
      </div>
      <div class="panel half view-panel" data-view="overview services">
        <div class="panel-head"><div><h2>Namespace Readiness</h2><div class="sub">命名空间 Pod 就绪与重启负载。</div></div></div>
        <svg id="namespaceChart"></svg>
      </div>
      <div class="panel half view-panel" data-view="overview services">
        <div class="panel-head"><div><h2>Probe Group Status</h2><div class="sub">服务探针按组展示成功和失败。</div></div></div>
        <svg id="probeChart"></svg>
      </div>
      <div class="panel two-third view-panel" data-view="data overview">
        <div class="panel-head"><div><h2>Data Lineage Live Map</h2><div class="sub">Jenkins 日志、Kafka、Flink、Spark、MinIO、Trino、Superset、Kibana/Grafana 的链路感知视图。</div></div></div>
        <div class="flow-lane" id="lineageFlow"></div>
      </div>
      <div class="panel third view-panel" data-view="data overview">
        <div class="panel-head"><div><h2>Spark Components</h2><div class="sub">Spark operator、webhook、pod、probe 证据。</div></div></div>
        <div id="sparkPanel"></div>
      </div>
      <div class="panel third view-panel" data-view="risk services"><div class="panel-head"><div><h2>Restart Hotspots</h2><div class="sub">重启次数 Top 组件。</div></div></div><svg id="restartChart"></svg></div>
      <div class="panel third view-panel" data-view="overview"><div class="panel-head"><div><h2>Coverage Rings</h2><div class="sub">覆盖、Pod、Service、Spark 核心比例。</div></div></div><svg id="ringChart"></svg></div>
      <div class="panel third view-panel" data-view="risk"><div class="panel-head"><div><h2>Risk Timeline</h2><div class="sub">按严重度生成的处理队列。</div></div></div><svg id="timelineChart"></svg></div>
      <div class="panel half view-panel" data-view="market data"><div class="panel-head"><div><h2>Recruitment Capability Fit</h2><div class="sub">高频 DevOps/SRE/data-platform 能力与平台覆盖匹配度。</div></div></div><svg id="marketChart"></svg></div>
      <div class="panel half view-panel" data-view="data evidence"><div class="panel-head"><div><h2>Data Lineage Ledger</h2><div class="sub">链路目的和当前覆盖状态。</div></div></div><div class="table-wrap"><table id="lineageTable"></table></div></div>
      <div class="panel half view-panel" data-view="market evidence"><div class="panel-head"><div><h2>Capability Gaps</h2><div class="sub">只保留必要工具，避免冗余安装。</div></div></div><div class="table-wrap"><table id="gapTable"></table></div></div>
      <div class="panel half view-panel" data-view="risk services"><div class="panel-head"><div><h2>No Endpoint Watchlist</h2><div class="sub">没有 ready endpoint 的服务。</div></div></div><div class="table-wrap"><table id="endpointTable"></table></div></div>
      <div class="panel wide view-panel" data-view="risk evidence"><div class="panel-head"><div><h2>Risk Event Ledger</h2><div class="sub">Pod、探针、端点和重启风险清单。</div></div></div><div class="table-wrap"><table id="riskTable"></table></div></div>
      <div class="panel wide view-panel" data-view="services evidence"><div class="panel-head"><div><h2>Service Probe Matrix</h2><div class="sub">Jenkins 采集的所有服务探针结果。</div></div></div><div class="table-wrap"><table id="probeTable"></table></div></div>
      <div class="panel wide view-panel" data-view="services evidence"><div class="panel-head"><div><h2>Pod Evidence Matrix</h2><div class="sub">全 Pod 覆盖证据，包含镜像、节点、重启和覆盖状态。</div></div></div><div class="table-wrap"><table id="podTable"></table></div></div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <script id="evidence-data" type="application/json">${evidenceJson}</script>
  <script>
    let evidence = JSON.parse(document.getElementById('evidence-data').textContent);
    let riskMode = 'all';
    const fmt = new Intl.NumberFormat('en-US');
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    const ratio = (a,b) => b ? Math.round(a * 100 / b) : 0;
    const colors = ['#22d3ee','#34d399','#f59e0b','#f472b6','#60a5fa','#a3e635','#fb7185'];
    function toast(message) {
      const node = el('toast');
      node.textContent = message;
      node.classList.add('show');
      setTimeout(() => node.classList.remove('show'), 2600);
    }
    function clsStatus(value) {
      if (value === true || value === 'ok' || value === 'covered' || value === 'READY' || value === 'SUCCESS') return 'ok';
      if (value === false || value === 'failed' || value === 'FAILURE' || value === 'NOT_READY') return 'bad';
      return 'warn';
    }
    function sparkPath(values, width, height) {
      const max = Math.max(1, ...values);
      return values.map((value, index) => {
        const x = Math.round(index * width / Math.max(1, values.length - 1));
        const y = Math.round(height - (value / max) * (height - 4) - 2);
        return (index ? 'L' : 'M') + x + ' ' + y;
      }).join(' ');
    }
    function renderMiniSpark(id, values, color) {
      const node = el(id);
      if (!node) return;
      node.setAttribute('viewBox', '0 0 180 42');
      node.innerHTML = '<path d="' + sparkPath(values, 180, 42) + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round"><animate attributeName="stroke-dasharray" from="0 300" to="300 0" dur="1s" fill="freeze"/></path>';
    }
    function healthOrb() {
      const s = evidence.summary;
      const score = Number(s.platformHealthScore || 0);
      const dash = Math.max(0, Math.min(100, score)) * 7.54;
      const node = el('healthOrb');
      node.setAttribute('viewBox', '0 0 360 360');
      const orbitRows = (evidence.layerSummary || []).slice(0, 6);
      const orbit = orbitRows.map((row, index) => {
        const angle = -90 + index * 360 / Math.max(1, orbitRows.length);
        const rad = angle * Math.PI / 180;
        const x = 180 + Math.cos(rad) * 132;
        const y = 180 + Math.sin(rad) * 132;
        const c = row.healthScore >= 90 ? '#34d399' : row.healthScore >= 75 ? '#f59e0b' : '#fb7185';
        return '<circle cx="' + x + '" cy="' + y + '" r="8" fill="' + c + '"><animate attributeName="r" values="6;10;6" dur="' + (2 + index * .2) + 's" repeatCount="indefinite"/></circle><text x="' + x + '" y="' + (y + 24) + '" text-anchor="middle" fill="#9fb2c9" font-size="10">' + esc(row.layer) + '</text>';
      }).join('');
      node.innerHTML = '<defs><linearGradient id="healthGrad" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#22d3ee"/><stop offset=".45" stop-color="#34d399"/><stop offset=".72" stop-color="#f59e0b"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs><circle cx="180" cy="180" r="120" fill="none" stroke="rgba(255,255,255,.11)" stroke-width="18"/><circle cx="180" cy="180" r="120" fill="none" stroke="url(#healthGrad)" stroke-width="18" stroke-linecap="round" stroke-dasharray="' + dash + ' 754" transform="rotate(-90 180 180)"><animate attributeName="stroke-dasharray" from="0 754" to="' + dash + ' 754" dur="1.2s" fill="freeze"/></circle><circle cx="180" cy="180" r="86" fill="none" stroke="rgba(34,211,238,.22)" stroke-width="1"/><circle cx="180" cy="180" r="150" fill="none" stroke="rgba(255,255,255,.08)" stroke-dasharray="4 10"/>' + orbit;
    }
    function renderCards() {
      const s = evidence.summary;
      const cards = [
        [s.platformHealthScore, 'Platform health', '#34d399', [40,58,72,86,s.platformHealthScore]],
        [s.podCoverageRecordTotal + '/' + s.podCoverageLiveTotal, 'Pods covered', '#22d3ee', [20,42,65,80,s.podCoverageRatio]],
        [s.podCoverageRatio + '%', 'Coverage ratio', '#a3e635', [30,50,70,90,s.podCoverageRatio]],
        [s.podReady + '/' + s.podTotal, 'Pods ready', '#60a5fa', [s.podReady, s.podTotal, s.podReady]],
        [s.serviceEndpointReady + '/' + s.serviceTotal, 'Services ready', '#f59e0b', [s.serviceEndpointReady, s.serviceTotal, s.serviceEndpointReady]],
        [s.workloadReady + '/' + s.workloadTotal, 'Workloads ready', '#f472b6', [s.workloadReady, s.workloadTotal, s.workloadReady]],
        [s.serviceProbeOk + '/' + s.serviceProbeTotal, 'Probes OK', '#34d399', [s.serviceProbeOk, s.serviceProbeTotal, s.serviceProbeOk]],
        [s.sparkPodsReady + '/' + s.sparkPods, 'Spark ready', '#22d3ee', [s.sparkPodsReady, s.sparkPods || 1, s.sparkPodsReady]],
        [s.nodeReady + '/' + s.nodeTotal, 'Nodes ready', '#a3e635', [s.nodeReady, s.nodeTotal, s.nodeReady]],
        [s.riskEventTotal, 'Risk events', '#fb7185', [1,3,6,s.riskEventTotal || 1]],
        [fmt.format(s.restartTotal), 'Total restarts', '#f59e0b', [1,2,4,Math.max(1,s.restartTotal)]],
      ];
      el('cards').innerHTML = cards.map((c, index) => '<div class="card" style="--accent:' + c[2] + '"><div class="metric">' + esc(c[0]) + '</div><div class="label">' + esc(c[1]) + '</div><svg class="sparkline" viewBox="0 0 180 34"><path d="' + sparkPath(c[3], 180, 34) + '" fill="none" stroke="' + c[2] + '" stroke-width="3" stroke-linecap="round"><animate attributeName="stroke-dasharray" from="0 300" to="300 0" dur="' + (0.7 + index * .05) + 's" fill="freeze"/></path></svg></div>').join('');
    }
    function barChart(node, rows, labelKey, valueKey, maxValue, color) {
      const width = 860, rowH = 28, top = 16, left = 190, height = Math.max(220, top + rows.length * rowH + 20);
      const max = Math.max(1, maxValue || Math.max(1, ...rows.map((row) => row[valueKey] || 0)));
      const body = rows.map((row, index) => {
        const y = top + index * rowH;
        const value = Number(row[valueKey] || 0);
        const w = Math.round((width - left - 30) * value / max);
        const c = row.color || colors[index % colors.length] || color;
        return '<text x="0" y="' + (y + 17) + '" fill="#c6d9ea" font-size="12">' + esc(row[labelKey]) + '</text><rect x="' + left + '" y="' + (y + 4) + '" width="' + (width - left - 30) + '" height="16" rx="4" fill="rgba(255,255,255,.07)"></rect><rect x="' + left + '" y="' + (y + 4) + '" width="' + w + '" height="16" rx="4" fill="' + c + '"><animate attributeName="width" from="0" to="' + w + '" dur=".7s" fill="freeze"/></rect><text x="' + (left + w + 8) + '" y="' + (y + 17) + '" fill="#9fb2c9" font-size="12">' + value + '</text>';
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
        return '<circle cx="' + x + '" cy="92" r="42" fill="none" stroke="rgba(219,228,239,.16)" stroke-width="14"></circle><circle cx="' + x + '" cy="92" r="42" fill="none" stroke="' + r[3] + '" stroke-width="14" stroke-dasharray="' + dash + ' 264" transform="rotate(-90 ' + x + ' 92)"><animate attributeName="stroke-dasharray" from="0 264" to="' + dash + ' 264" dur=".9s" fill="freeze"/></circle><text x="' + x + '" y="98" text-anchor="middle" font-size="20" font-weight="900" fill="#ecf7ff">' + pct + '%</text><text x="' + x + '" y="158" text-anchor="middle" font-size="13" fill="#9fb2c9">' + r[0] + '</text>';
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
      const rows = (riskMode === 'critical' ? evidence.riskEvents.filter((risk) => risk.severity >= 85) : evidence.riskEvents).slice(0, 18);
      const width = 860, cellW = 92, cellH = 42;
      el('riskChart').setAttribute('viewBox', '0 0 ' + width + ' 250');
      el('riskChart').innerHTML = rows.map((risk, i) => {
        const x = (i % 9) * (cellW + 3), y = Math.floor(i / 9) * (cellH + 38) + 20;
        const color = risk.severity >= 85 ? '#ef4444' : risk.severity >= 70 ? '#f59e0b' : '#60a5fa';
        return '<rect x="' + x + '" y="' + y + '" width="' + cellW + '" height="' + cellH + '" rx="6" fill="' + color + '" opacity=".86"><animate attributeName="opacity" values=".55;.95;.70" dur="' + (1.8 + i * .08) + 's" repeatCount="indefinite"/></rect><text x="' + (x + 8) + '" y="' + (y + 17) + '" fill="#06101d" font-size="11" font-weight="900">' + risk.severity + '</text><text x="' + (x + 8) + '" y="' + (y + 32) + '" fill="#06101d" font-size="9">' + esc(risk.category.slice(0,12)) + '</text><text x="' + x + '" y="' + (y + cellH + 15) + '" fill="#9fb2c9" font-size="9">' + esc((risk.namespace + '/' + risk.name).slice(0,18)) + '</text>';
      }).join('') || '<text x="20" y="80" fill="#34d399" font-size="20">No active risk events</text>';
    }
    function timelineChart() {
      const rows = evidence.riskEvents.slice(0, 8);
      const width = 520, height = 260;
      el('timelineChart').setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      el('timelineChart').innerHTML = rows.map((risk, index) => {
        const y = 26 + index * 28;
        const color = risk.severity >= 85 ? '#fb7185' : risk.severity >= 70 ? '#f59e0b' : '#60a5fa';
        return '<circle cx="22" cy="' + y + '" r="7" fill="' + color + '"></circle><line x1="22" y1="' + (y + 9) + '" x2="22" y2="' + (y + 24) + '" stroke="rgba(255,255,255,.18)"></line><text x="42" y="' + (y + 5) + '" fill="#eef8ff" font-size="12" font-weight="800">' + esc(risk.category) + '</text><text x="42" y="' + (y + 20) + '" fill="#9fb2c9" font-size="10">' + esc((risk.namespace || '') + '/' + (risk.name || '')) + '</text><text x="456" y="' + (y + 9) + '" fill="' + color + '" font-size="12" font-weight="900">' + risk.severity + '</text>';
      }).join('') || '<text x="20" y="80" fill="#34d399" font-size="18">Risk queue is empty</text>';
    }
    function lineageFlow() {
      const rows = evidence.dataLineage.slice(0, 9);
      const host = el('lineageFlow');
      const width = host.clientWidth || 760;
      const columns = Math.min(3, Math.max(1, Math.floor(width / 230)));
      const nodes = rows.map((row, index) => {
        const col = index % columns;
        const lane = Math.floor(index / columns);
        const x = 4 + col * Math.max(180, (width - 40) / columns);
        const y = 10 + lane * 92;
        return { row, x, y, w: 150, h: 66 };
      });
      const lines = nodes.slice(0, -1).map((node, index) => {
        const next = nodes[index + 1];
        const x1 = node.x + node.w;
        const y1 = node.y + 32;
        const x2 = next.x;
        const y2 = next.y + 32;
        const len = Math.max(36, Math.hypot(x2 - x1, y2 - y1));
        const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        return '<div class="flow-line" style="left:' + x1 + 'px;top:' + y1 + 'px;width:' + len + 'px;transform:rotate(' + angle + 'deg)"></div>';
      }).join('');
      const boxes = nodes.map((node, index) => '<div class="flow-node" style="left:' + node.x + 'px;top:' + node.y + 'px;border-color:' + colors[index % colors.length] + '"><strong>' + esc(node.row.from) + ' → ' + esc(node.row.to) + '</strong><span>' + esc(node.row.purpose) + '</span><br><span class="' + clsStatus(node.row.status) + '"><span class="status-dot"></span>' + esc(node.row.status) + '</span></div>').join('');
      host.innerHTML = lines + boxes;
    }
    function sparkPanel() {
      const pods = evidence.spark.pods;
      const services = evidence.spark.services;
      const probes = evidence.spark.probes;
      const podRows = pods.map((pod) => '<tr><td>' + esc(pod.namespace) + '</td><td>' + esc(pod.name) + '</td><td class="' + (pod.ready ? 'ok' : 'bad') + '"><span class="status-dot"></span>' + (pod.ready ? 'READY' : 'CHECK') + '</td><td>' + pod.restarts + '</td></tr>').join('');
      const serviceRows = services.map((svc) => '<tr><td>' + esc(svc.namespace) + '</td><td>' + esc(svc.name) + '</td><td class="' + (svc.endpointReady ? 'ok' : 'bad') + '">' + svc.endpointReady + '/' + svc.endpointTotal + '</td><td>' + esc(svc.ports) + '</td></tr>').join('');
      const probeRows = probes.map((probe) => '<tr><td>' + esc(probe.group) + '</td><td>' + esc(probe.name) + '</td><td class="' + (probe.status === 'ok' ? 'ok' : 'bad') + '"><span class="status-dot"></span>' + esc(probe.status) + '</td><td>' + esc(probe.http_status || '') + '</td></tr>').join('');
      el('sparkPanel').innerHTML = '<div class="table-wrap" style="max-height:332px"><table><thead><tr><th>Scope</th><th>Name</th><th>Status</th><th>Extra</th></tr></thead><tbody>' + (podRows + serviceRows + probeRows || '<tr><td colspan="4">No Spark evidence in this build.</td></tr>') + '</tbody></table></div>';
    }
    function table(node, headers, rows) {
      node.innerHTML = '<thead><tr>' + headers.map((h) => '<th>' + esc(h[0]) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + headers.map((h) => {
        const value = row[h[1]];
        const klass = h[1] === 'status' || h[1] === 'ready' || h[1] === 'coverageStatus' ? clsStatus(value) : '';
        return '<td class="' + klass + '">' + esc(Array.isArray(value) ? value.join(', ') : value) + '</td>';
      }).join('') + '</tr>').join('') + '</tbody>';
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
    function ambient() {
      const canvas = el('ambientCanvas');
      if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const ctx = canvas.getContext('2d');
      const points = Array.from({ length: 62 }, (_, index) => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - .5) * .00045, vy: (Math.random() - .5) * .00035, hue: index % colors.length }));
      function size() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
      addEventListener('resize', size);
      size();
      function frame() {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0,0,w,h);
        points.forEach((p) => {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > 1) p.vx *= -1;
          if (p.y < 0 || p.y > 1) p.vy *= -1;
        });
        for (let i = 0; i < points.length; i++) {
          for (let j = i + 1; j < points.length; j++) {
            const a = points[i], b = points[j];
            const dx = (a.x - b.x) * w, dy = (a.y - b.y) * h;
            const d = Math.hypot(dx, dy);
            if (d < 180 * devicePixelRatio) {
              ctx.strokeStyle = 'rgba(34,211,238,' + (0.11 * (1 - d / (180 * devicePixelRatio))) + ')';
              ctx.beginPath(); ctx.moveTo(a.x*w, a.y*h); ctx.lineTo(b.x*w, b.y*h); ctx.stroke();
            }
          }
        }
        points.forEach((p) => {
          ctx.fillStyle = colors[p.hue];
          ctx.globalAlpha = .42;
          ctx.beginPath(); ctx.arc(p.x*w, p.y*h, 1.8 * devicePixelRatio, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = 1;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }
    async function refreshEvidence() {
      try {
        const response = await fetch('evidence.json?ts=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        evidence = await response.json();
        renderAll();
        el('syncStatus').textContent = 'synced ' + new Date().toLocaleTimeString();
      } catch (err) {
        el('syncStatus').textContent = 'local snapshot';
      }
    }
    function renderAll() {
      renderCards();
      healthOrb();
      renderMiniSpark('heroProbeSpark', [1,3,5,Number(evidence.summary.serviceProbeOk || 0),Number(evidence.summary.serviceProbeTotal || 1)], '#34d399');
      renderMiniSpark('heroCoverageSpark', [1,20,50,Number(evidence.summary.podCoverageRatio || 0)], '#22d3ee');
      barChart(el('namespaceChart'), evidence.namespaceSummary.slice(0, 18).map((row, index) => ({ namespace: row.namespace, ready: row.ready, color: colors[index % colors.length] })), 'namespace', 'ready', null, '#34d399');
      stackedProbeChart();
      barChart(el('restartChart'), evidence.restartHotspots.slice(0, 12).map((pod, index) => ({ name: pod.namespace + '/' + pod.name, restarts: pod.restarts, color: colors[(index + 2) % colors.length] })), 'name', 'restarts', null, '#f59e0b');
      barChart(el('marketChart'), evidence.jobMarketFit.map((row, index) => ({ capability: row.capability, score: row.score, color: colors[index % colors.length] })), 'capability', 'score', 100, '#60a5fa');
      layerChart();
      riskChart();
      timelineChart();
      ringChart();
      lineageFlow();
      sparkPanel();
      applyFilter();
    }
    function boot() {
      ambient();
      renderAll();
      setInterval(() => { el('clock').textContent = 'browser time ' + new Date().toLocaleString(); }, 1000);
      setInterval(refreshEvidence, 60000);
      el('filter').addEventListener('input', applyFilter);
      document.querySelectorAll('.view-btn').forEach((button) => button.addEventListener('click', () => setView(button.dataset.targetView)));
      document.querySelectorAll('[data-jump-view]').forEach((button) => button.addEventListener('click', () => {
        setView(button.dataset.jumpView);
        document.querySelector('.control-strip').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      document.querySelectorAll('[data-risk-mode]').forEach((button) => button.addEventListener('click', () => {
        riskMode = button.dataset.riskMode;
        document.querySelectorAll('[data-risk-mode]').forEach((node) => node.classList.toggle('active', node.dataset.riskMode === riskMode));
        riskChart();
      }));
      el('copyEvidence').addEventListener('click', async () => {
        const url = location.origin + location.pathname.replace(/\\/$/, '') + '/evidence.json';
        try { await navigator.clipboard.writeText(url); toast('已复制 evidence.json 地址：' + url); } catch (err) { toast(url); }
      });
      addEventListener('resize', () => lineageFlow());
      const initialView = ['overview','risk','data','services','market','evidence'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
      setView(initialView);
    }
    boot();
  </script>
</body>
</html>`;

write('reports/v13-portal/index.html', html);
