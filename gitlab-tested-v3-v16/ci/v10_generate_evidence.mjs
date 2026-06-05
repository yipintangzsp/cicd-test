import fs from 'node:fs';
import path from 'node:path';

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const build = process.env.BUILD_NUMBER || 'unknown';
const semver = process.env.SEMVER || 'unknown';
const commit = process.env.GIT_COMMIT_ID || 'unknown';
const job = process.env.JOB_NAME || 'jenkins';
const portalNodePort = process.env.V10_PORTAL_NODEPORT || '30087';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pods = readJson('meta/k8s-pods.json').items || [];
const services = readJson('meta/k8s-services.json').items || [];
const workloads = readJson('meta/k8s-workloads.json').items || [];
const endpointSlices = readJson('meta/k8s-endpointslices.json').items || [];
const serviceProbes = fs.existsSync('reports/v10-service-probes.ndjson')
  ? fs.readFileSync('reports/v10-service-probes.ndjson', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];

const text = (value) => value == null ? '' : String(value);
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const write = (file, body) => fs.writeFileSync(file, body, 'utf8');

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

function metricLabel(value) {
  return text(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

const podRows = pods.map((pod) => ({
  namespace: pod.metadata.namespace,
  name: pod.metadata.name,
  phase: pod.status?.phase || 'Unknown',
  ready: podReady(pod),
  restarts: restarts(pod),
  podIP: pod.status?.podIP || '',
  node: pod.spec?.nodeName || '',
}));

const svcRows = services.map((svc) => {
  const namespace = svc.metadata.namespace;
  const name = svc.metadata.name;
  const endpoints = serviceEndpointCount(namespace, name);
  const ports = (svc.spec?.ports || []).map((port) => {
    let item = text(port.port);
    if (port.nodePort) item += `:${port.nodePort}`;
    return item;
  }).filter(Boolean);
  return {
    namespace,
    name,
    type: svc.spec?.type || 'ClusterIP',
    clusterIP: svc.spec?.clusterIP || '',
    ports: ports.join(','),
    endpointTotal: endpoints.total,
    endpointReady: endpoints.ready,
  };
});

const wlRows = workloads.map((workload) => {
  const status = workload.status || {};
  return {
    namespace: workload.metadata.namespace,
    kind: workload.kind || '',
    name: workload.metadata.name,
    desired: status.replicas || status.desiredNumberScheduled || 0,
    ready: status.readyReplicas || status.numberReady || 0,
  };
});

const summary = {
  timestamp: now,
  job,
  build,
  semver,
  commit,
  podTotal: podRows.length,
  podReady: podRows.filter((pod) => pod.ready).length,
  podNotReady: podRows.filter((pod) => !pod.ready && pod.phase !== 'Succeeded'),
  serviceTotal: svcRows.length,
  workloadTotal: wlRows.length,
  serviceProbeTotal: serviceProbes.length,
  serviceProbeOk: serviceProbes.filter((probe) => probe.status === 'ok').length,
  serviceProbeFailed: serviceProbes.filter((probe) => probe.status !== 'ok'),
  portalUrl: `http://192.168.1.58:${portalNodePort}/`,
};

const evidence = { summary, pods: podRows, services: svcRows, workloads: wlRows, serviceProbes };
ensureDir('reports/v10-portal');
write('reports/v10-platform-services.json', JSON.stringify(evidence, null, 2));

const ndjson = [];
for (const row of podRows) {
  ndjson.push(JSON.stringify({ '@timestamp': now, type: 'pod', pipeline_version: 'v10', build, ...row }));
}
for (const row of svcRows) {
  const status = row.endpointReady > 0 || row.type === 'ExternalName' ? 'ready' : 'no_endpoint';
  ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service', pipeline_version: 'v10', build, status, ...row }));
}
for (const row of serviceProbes) {
  ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service_probe', pipeline_version: 'v10', build, ...row }));
}
write('reports/v10-observability.ndjson', ndjson.join('\n') + '\n');

const metrics = [
  '# HELP cicd_v10_pod_ready Kubernetes pod readiness captured by Jenkins v10.',
  '# TYPE cicd_v10_pod_ready gauge',
];
for (const row of podRows) {
  metrics.push(`cicd_v10_pod_ready{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
}
metrics.push('# HELP cicd_v10_service_endpoint_ready Ready endpoints captured by Jenkins v10.');
metrics.push('# TYPE cicd_v10_service_endpoint_ready gauge');
for (const row of svcRows) {
  metrics.push(`cicd_v10_service_endpoint_ready{namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.endpointReady}`);
}
metrics.push('# HELP cicd_v10_service_probe_ok Platform service probe status captured by Jenkins v10.');
metrics.push('# TYPE cicd_v10_service_probe_ok gauge');
for (const row of serviceProbes) {
  metrics.push(`cicd_v10_service_probe_ok{group="${metricLabel(row.group)}",namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.status === 'ok' ? 1 : 0}`);
}
write('reports/v10-prometheus-metrics.prom', metrics.join('\n') + '\n');

const grafana = {
  title: 'Jenkins V10 Platform Evidence',
  tags: ['jenkins', 'v10', 'platform'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '30s',
  panels: [
    { type: 'stat', title: 'Ready Pods', gridPos: { x: 0, y: 0, w: 6, h: 4 }, targets: [{ expr: 'sum(cicd_v10_pod_ready)' }] },
    { type: 'stat', title: 'Service Ready Endpoints', gridPos: { x: 6, y: 0, w: 6, h: 4 }, targets: [{ expr: 'sum(cicd_v10_service_endpoint_ready)' }] },
    { type: 'timeseries', title: 'Pod Readiness By Namespace', gridPos: { x: 0, y: 4, w: 12, h: 8 }, targets: [{ expr: 'sum by(namespace) (cicd_v10_pod_ready)' }] },
    { type: 'timeseries', title: 'V10 Service Probe OK By Group', gridPos: { x: 12, y: 4, w: 12, h: 8 }, targets: [{ expr: 'sum by(group) (cicd_v10_service_probe_ok)' }] },
  ],
};
write('reports/v10-grafana-dashboard.json', JSON.stringify(grafana, null, 2));

const kibanaDashboard = {
  type: 'dashboard',
  id: 'jenkins-v10-platform-evidence',
  attributes: {
    title: 'Jenkins V10 Platform Evidence',
    description: 'Import reports/v10-observability.ndjson into Elasticsearch, then use this dashboard as a base.',
    panelsJSON: '[]',
    optionsJSON: '{"useMargins":true,"syncColors":false,"hidePanelTitles":false}',
    version: 1,
    timeRestore: false,
    kibanaSavedObjectMeta: { searchSourceJSON: '{"query":{"language":"kuery","query":"pipeline_version : v10"},"filter":[]}' },
  },
};
write('reports/v10-kibana-dashboard.ndjson', JSON.stringify(kibanaDashboard) + '\n');

const topPods = [...podRows].sort((a, b) => {
  const left = `${a.ready ? 1 : 0}:${a.namespace}:${a.name}`;
  const right = `${b.ready ? 1 : 0}:${b.namespace}:${b.name}`;
  return left.localeCompare(right);
});

const escapeHtml = (value) => text(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const rows = topPods.map((pod) => (
  `<tr><td>${escapeHtml(pod.namespace)}</td><td>${escapeHtml(pod.name)}</td><td>${escapeHtml(pod.phase)}</td><td>${pod.ready ? 'READY' : 'CHECK'}</td><td>${pod.restarts}</td></tr>`
)).join('');

const probeRows = serviceProbes.map((probe) => (
  `<tr><td>${escapeHtml(probe.group)}</td><td>${escapeHtml(probe.namespace)}</td><td>${escapeHtml(probe.kind)}/${escapeHtml(probe.name)}</td><td>${escapeHtml(probe.status)}</td><td>${escapeHtml(probe.http_status)}</td></tr>`
)).join('');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jenkins V10 Platform Evidence</title>
  <style>
    body { margin:0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f7f9fc; color:#172033; }
    header { background:#f38020; color:white; padding:28px 36px; }
    main { padding:28px 36px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:22px; }
    .card { background:white; border:1px solid #dde5ef; border-radius:8px; padding:16px; box-shadow:0 1px 2px rgba(20,30,50,.04); }
    .num { font-size:30px; font-weight:700; }
    table { width:100%; border-collapse:collapse; background:white; border:1px solid #dde5ef; border-radius:8px; overflow:hidden; }
    th,td { padding:10px 12px; border-bottom:1px solid #edf1f7; text-align:left; font-size:13px; }
    th { background:#eef4fb; }
    code { background:#fff3e8; padding:2px 5px; border-radius:4px; }
  </style>
</head>
<body>
  <header>
    <h1>Jenkins V10 Platform Evidence</h1>
    <p>Build #${build} · ${semver} · commit ${commit} · Cloudflare-ready preview</p>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="num">${summary.podReady}/${summary.podTotal}</div><div>Pods Ready</div></div>
      <div class="card"><div class="num">${summary.serviceTotal}</div><div>Services Covered</div></div>
      <div class="card"><div class="num">${summary.workloadTotal}</div><div>Workloads Covered</div></div>
      <div class="card"><div class="num">${summary.podNotReady.length}</div><div>Pods Need Attention</div></div>
      <div class="card"><div class="num">${summary.serviceProbeOk}/${summary.serviceProbeTotal}</div><div>Service Probes OK</div></div>
    </section>
    <section class="card">
      <h2>成果入口</h2>
      <p>内部访问地址：<code>${summary.portalUrl}</code></p>
      <p>日志与图表素材：<code>v10-observability.ndjson</code>、<code>v10-prometheus-metrics.prom</code>、<code>v10-grafana-dashboard.json</code>、<code>v10-kibana-dashboard.ndjson</code></p>
    </section>
    <h2>Service Probe Matrix</h2>
    <table><thead><tr><th>Group</th><th>Namespace</th><th>Object</th><th>Status</th><th>HTTP</th></tr></thead><tbody>${probeRows}</tbody></table>
    <h2>Pod Evidence Matrix</h2>
    <table><thead><tr><th>Namespace</th><th>Pod</th><th>Phase</th><th>Ready</th><th>Restarts</th></tr></thead><tbody>${rows}</tbody></table>
  </main>
</body>
</html>`;

write('reports/v10-portal/index.html', html);
write('reports/v10-portal/evidence.json', JSON.stringify(evidence, null, 2));
