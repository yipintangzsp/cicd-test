import fs from 'node:fs';

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const build = process.env.BUILD_NUMBER || 'unknown';
const semver = process.env.SEMVER || 'unknown';
const commit = process.env.GIT_COMMIT_ID || 'unknown';
const job = process.env.JOB_NAME || 'jenkins';
const portalNodePort = process.env.V11_PORTAL_NODEPORT || '30087';
const publicHost = process.env.CLOUDFLARE_PUBLIC_HOSTNAME || 'platform.heil.ccwu.cc';
const grafanaTitle = process.env.V11_GRAFANA_DASHBOARD_TITLE || 'Jenkins V11 Platform Evidence';
const kibanaIndexPrefix = process.env.V11_KIBANA_INDEX_PREFIX || 'jenkins-v11-platform';

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
const serviceProbes = readLines('reports/v11-service-probes.ndjson').map((line) => JSON.parse(line));

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
  owner: pod.metadata?.ownerReferences?.[0]?.kind ? `${pod.metadata.ownerReferences[0].kind}/${pod.metadata.ownerReferences[0].name}` : '',
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

const summary = {
  timestamp: now,
  job,
  build,
  semver,
  commit,
  pipelineVersion: 'v11',
  publicUrl: `https://${publicHost}/`,
  portalUrl: `http://192.168.1.58:${portalNodePort}/`,
  podTotal: podRows.length,
  podReady: podRows.filter((pod) => pod.ready).length,
  podAttention: podRows.filter((pod) => !pod.ready && pod.phase !== 'Succeeded').length,
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
};

const evidence = {
  summary,
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
};

ensureDir('reports/v11-portal');
write('reports/v11-platform-services.json', JSON.stringify(evidence, null, 2));
write('reports/v11-portal/evidence.json', JSON.stringify(evidence, null, 2));

const ndjson = [];
for (const row of podRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'pod', pipeline_version: 'v11', pipeline_result_key: 'RUNNING', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, ...row }));
for (const row of svcRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service', pipeline_version: 'v11', pipeline_result_key: row.endpointReady > 0 || row.type === 'ExternalName' ? 'READY' : 'NO_ENDPOINT', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, ...row }));
for (const row of serviceProbes) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'service_probe', pipeline_version: 'v11', pipeline_result_key: row.status === 'ok' ? 'SUCCESS' : 'FAILURE', pipeline_job_key: job, pipeline_build_number: Number(build) || 0, build, ...row }));
for (const row of namespaceSummary) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'namespace_summary', pipeline_version: 'v11', pipeline_job_key: job, build, ...row }));
for (const row of nodeRows) ndjson.push(JSON.stringify({ '@timestamp': now, type: 'node', pipeline_version: 'v11', pipeline_result_key: row.ready ? 'READY' : 'NOT_READY', pipeline_job_key: job, build, ...row }));
write('reports/v11-observability.ndjson', ndjson.join('\n') + '\n');

const metrics = [
  '# HELP cicd_v11_pod_ready Kubernetes pod readiness captured by Jenkins v11.',
  '# TYPE cicd_v11_pod_ready gauge',
];
for (const row of podRows) metrics.push(`cicd_v11_pod_ready{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
metrics.push('# HELP cicd_v11_pod_restarts Kubernetes pod restart count captured by Jenkins v11.');
metrics.push('# TYPE cicd_v11_pod_restarts gauge');
for (const row of podRows) metrics.push(`cicd_v11_pod_restarts{namespace="${metricLabel(row.namespace)}",pod="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.restarts}`);
metrics.push('# HELP cicd_v11_service_endpoint_ready Ready endpoints captured by Jenkins v11.');
metrics.push('# TYPE cicd_v11_service_endpoint_ready gauge');
for (const row of svcRows) metrics.push(`cicd_v11_service_endpoint_ready{namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.endpointReady}`);
metrics.push('# HELP cicd_v11_service_probe_ok Platform service probe status captured by Jenkins v11.');
metrics.push('# TYPE cicd_v11_service_probe_ok gauge');
for (const row of serviceProbes) metrics.push(`cicd_v11_service_probe_ok{group="${metricLabel(row.group)}",namespace="${metricLabel(row.namespace)}",service="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.status === 'ok' ? 1 : 0}`);
metrics.push('# HELP cicd_v11_spark_component_ready Spark component readiness captured by Jenkins v11.');
metrics.push('# TYPE cicd_v11_spark_component_ready gauge');
for (const row of sparkPods) metrics.push(`cicd_v11_spark_component_ready{namespace="${metricLabel(row.namespace)}",component="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
metrics.push('# HELP cicd_v11_node_ready Kubernetes node readiness captured by Jenkins v11.');
metrics.push('# TYPE cicd_v11_node_ready gauge');
for (const row of nodeRows) metrics.push(`cicd_v11_node_ready{node="${metricLabel(row.name)}",build="${metricLabel(build)}"} ${row.ready ? 1 : 0}`);
write('reports/v11-prometheus-metrics.prom', metrics.join('\n') + '\n');

const grafana = {
  title: grafanaTitle,
  tags: ['jenkins', 'v11', 'platform', 'spark'],
  timezone: 'browser',
  schemaVersion: 39,
  version: 1,
  refresh: '30s',
  panels: [
    { type: 'stat', title: 'Ready Pods', gridPos: { x: 0, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v11_pod_ready)' }] },
    { type: 'stat', title: 'Pod Restarts', gridPos: { x: 4, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v11_pod_restarts)' }] },
    { type: 'stat', title: 'Spark Ready', gridPos: { x: 8, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v11_spark_component_ready)' }] },
    { type: 'stat', title: 'Ready Nodes', gridPos: { x: 12, y: 0, w: 4, h: 4 }, targets: [{ expr: 'sum(cicd_v11_node_ready)' }] },
    { type: 'timeseries', title: 'Pod Readiness By Namespace', gridPos: { x: 0, y: 4, w: 12, h: 8 }, targets: [{ expr: 'sum by(namespace) (cicd_v11_pod_ready)' }] },
    { type: 'timeseries', title: 'Service Probe OK By Group', gridPos: { x: 12, y: 4, w: 12, h: 8 }, targets: [{ expr: 'sum by(group) (cicd_v11_service_probe_ok)' }] },
    { type: 'barchart', title: 'Restart Hotspots', gridPos: { x: 0, y: 12, w: 12, h: 8 }, targets: [{ expr: 'topk(20, cicd_v11_pod_restarts)' }] },
    { type: 'table', title: 'Spark Components', gridPos: { x: 12, y: 12, w: 12, h: 8 }, targets: [{ expr: 'cicd_v11_spark_component_ready' }] },
  ],
};
write('reports/v11-grafana-dashboard.json', JSON.stringify(grafana, null, 2));

const kibanaObjects = [
  {
    type: 'index-pattern',
    id: kibanaIndexPrefix,
    attributes: { title: `${kibanaIndexPrefix}*,jenkins-logs`, timeFieldName: '@timestamp' },
  },
  {
    type: 'dashboard',
    id: `${kibanaIndexPrefix}-evidence`,
    attributes: {
      title: grafanaTitle,
      description: 'V11 pipeline, Spark, Kubernetes, service probes, and Jenkins build evidence.',
      panelsJSON: '[]',
      optionsJSON: '{"useMargins":true,"syncColors":false,"hidePanelTitles":false}',
      version: 1,
      timeRestore: false,
      kibanaSavedObjectMeta: { searchSourceJSON: '{"query":{"language":"kuery","query":"pipeline_version : v11"},"filter":[]}' },
    },
  },
];
write('reports/v11-kibana-dashboard.ndjson', kibanaObjects.map((object) => JSON.stringify(object)).join('\n') + '\n');

const evidenceJson = JSON.stringify(evidence).replace(/</g, '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZhangLab DevOps V11 Control Surface</title>
  <style>
    :root { color-scheme: light; --ink:#142034; --muted:#5d6b82; --line:#dbe4ef; --bg:#f3f6fb; --panel:#ffffff; --teal:#0f9f9a; --amber:#d9822b; --red:#c2413b; --blue:#2e6bd7; --green:#16875f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { min-height:250px; padding:32px 34px 26px; background:linear-gradient(135deg,#172033 0%,#243b55 52%,#0f9f9a 100%); color:white; display:flex; flex-direction:column; justify-content:flex-end; gap:16px; }
    header h1 { margin:0; font-size:42px; line-height:1.05; letter-spacing:0; }
    header p { margin:0; color:#d9eef2; font-size:16px; }
    main { padding:24px 34px 36px; max-width:1680px; margin:0 auto; }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:18px; }
    .pill { border:1px solid var(--line); background:var(--panel); border-radius:999px; padding:8px 12px; color:var(--muted); font-size:13px; }
    .search { min-width:280px; flex:1; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:inherit; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(185px,1fr)); gap:14px; margin-bottom:18px; }
    .card, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:0 1px 2px rgba(20,32,52,.05); }
    .card { padding:16px; min-height:112px; }
    .metric { font-size:34px; line-height:1; font-weight:800; }
    .label { color:var(--muted); margin-top:8px; font-size:14px; }
    .grid { display:grid; grid-template-columns:repeat(12,1fr); gap:14px; align-items:start; }
    .panel { padding:16px; min-height:280px; }
    .wide { grid-column:span 12; }
    .half { grid-column:span 6; }
    .third { grid-column:span 4; }
    h2 { margin:0 0 12px; font-size:18px; }
    svg { width:100%; min-height:210px; display:block; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th, td { padding:9px 10px; border-bottom:1px solid #edf1f7; text-align:left; vertical-align:top; }
    th { background:#eef4fb; color:#35445b; position:sticky; top:0; }
    .table-wrap { max-height:430px; overflow:auto; border:1px solid var(--line); border-radius:8px; }
    .ok { color:var(--green); font-weight:700; }
    .warn { color:var(--amber); font-weight:700; }
    .bad { color:var(--red); font-weight:700; }
    .legend { display:flex; gap:12px; flex-wrap:wrap; color:var(--muted); font-size:12px; margin-top:8px; }
    code { background:#fff2e5; padding:2px 5px; border-radius:4px; }
    @media (max-width: 980px) { header h1 { font-size:32px; } main { padding:18px; } .half,.third { grid-column:span 12; } }
  </style>
</head>
<body>
  <header>
    <h1>ZhangLab DevOps V11 Control Surface</h1>
    <p>Build #${build} · ${semver} · commit ${commit} · Spark-aware full-platform evidence · ${publicHost}</p>
  </header>
  <main>
    <div class="toolbar">
      <span class="pill">public <code>https://${publicHost}/</code></span>
      <span class="pill">internal <code>http://192.168.1.58:${portalNodePort}/</code></span>
      <span class="pill" id="clock">refreshing</span>
      <input class="search" id="filter" placeholder="Filter services, pods, namespaces, Spark components">
    </div>
    <section class="cards" id="cards"></section>
    <section class="grid">
      <div class="panel half"><h2>Namespace Readiness</h2><svg id="namespaceChart"></svg><div class="legend">Pod readiness and restart load by namespace.</div></div>
      <div class="panel half"><h2>Probe Group Status</h2><svg id="probeChart"></svg><div class="legend">HTTP/DNS/service checks grouped by platform layer.</div></div>
      <div class="panel third"><h2>Spark Components</h2><div id="sparkPanel"></div></div>
      <div class="panel third"><h2>Restart Hotspots</h2><svg id="restartChart"></svg></div>
      <div class="panel third"><h2>Coverage Rings</h2><svg id="ringChart"></svg></div>
      <div class="panel wide"><h2>Service Probe Matrix</h2><div class="table-wrap"><table id="probeTable"></table></div></div>
      <div class="panel wide"><h2>Pod Evidence Matrix</h2><div class="table-wrap"><table id="podTable"></table></div></div>
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
        [s.podReady + '/' + s.podTotal, 'Pods ready'],
        [s.serviceEndpointReady + '/' + s.serviceTotal, 'Services with endpoints'],
        [s.workloadReady + '/' + s.workloadTotal, 'Workloads ready'],
        [s.serviceProbeOk + '/' + s.serviceProbeTotal, 'Service probes OK'],
        [s.sparkPodsReady + '/' + s.sparkPods, 'Spark pods ready'],
        [s.nodeReady + '/' + s.nodeTotal, 'Nodes ready'],
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
        return '<text x="0" y="' + (y + 17) + '" fill="#35445b" font-size="12">' + esc(row[labelKey]) + '</text><rect x="' + left + '" y="' + (y + 4) + '" width="' + w + '" height="16" rx="4" fill="' + color + '"><animate attributeName="width" from="0" to="' + w + '" dur=".7s" fill="freeze"/></rect><text x="' + (left + w + 8) + '" y="' + (y + 17) + '" fill="#5d6b82" font-size="12">' + value + '</text>';
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
        return '<text x="0" y="' + (y + 15) + '" fill="#35445b" font-size="12">' + esc(row.group) + '</text><rect x="' + left + '" y="' + (y + 2) + '" width="' + okW + '" height="17" rx="4" fill="#16875f"></rect><rect x="' + (left + okW + 2) + '" y="' + (y + 2) + '" width="' + badW + '" height="17" rx="4" fill="#c2413b"></rect><text x="' + (left + okW + badW + 10) + '" y="' + (y + 15) + '" fill="#5d6b82" font-size="12">' + row.ok + '/' + row.total + '</text>';
      }).join('');
    }
    function ringChart() {
      const s = evidence.summary;
      const rings = [
        ['Pods', s.podReady, s.podTotal, '#0f9f9a'],
        ['Services', s.serviceEndpointReady, s.serviceTotal, '#2e6bd7'],
        ['Spark', s.sparkPodsReady, s.sparkPods || 1, '#d9822b'],
      ];
      el('ringChart').setAttribute('viewBox', '0 0 520 240');
      el('ringChart').innerHTML = rings.map((r, i) => {
        const x = 85 + i * 170, pct = ratio(r[1], r[2]), dash = pct * 2.64;
        return '<circle cx="' + x + '" cy="92" r="42" fill="none" stroke="#e5edf5" stroke-width="14"></circle><circle cx="' + x + '" cy="92" r="42" fill="none" stroke="' + r[3] + '" stroke-width="14" stroke-dasharray="' + dash + ' 264" transform="rotate(-90 ' + x + ' 92)"></circle><text x="' + x + '" y="98" text-anchor="middle" font-size="20" font-weight="800" fill="#142034">' + pct + '%</text><text x="' + x + '" y="158" text-anchor="middle" font-size="13" fill="#5d6b82">' + r[0] + '</text>';
      }).join('');
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
    function applyFilter() {
      const q = el('filter').value.trim().toLowerCase();
      const probes = evidence.serviceProbes.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q));
      const pods = evidence.pods.filter((row) => !q || JSON.stringify(row).toLowerCase().includes(q));
      table(el('probeTable'), [['Group','group'],['Namespace','namespace'],['Object','name'],['Status','status'],['HTTP','http_status']], probes);
      table(el('podTable'), [['Namespace','namespace'],['Pod','name'],['Phase','phase'],['Ready','ready'],['Restarts','restarts'],['Node','node']], pods);
    }
    function boot() {
      renderCards();
      barChart(el('namespaceChart'), evidence.namespaceSummary.slice(0, 18), 'namespace', 'ready', null, '#0f9f9a');
      stackedProbeChart();
      barChart(el('restartChart'), evidence.restartHotspots.slice(0, 12).map((pod) => ({ name: pod.namespace + '/' + pod.name, restarts: pod.restarts })), 'name', 'restarts', null, '#d9822b');
      ringChart();
      sparkPanel();
      applyFilter();
      setInterval(() => { el('clock').textContent = 'browser time ' + new Date().toLocaleString(); }, 1000);
      el('filter').addEventListener('input', applyFilter);
    }
    boot();
  </script>
</body>
</html>`;

write('reports/v11-portal/index.html', html);
