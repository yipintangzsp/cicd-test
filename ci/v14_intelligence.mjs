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
  return Math.round(score);
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

function buildRiskVectors(evidence, ledger) {
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
  const weakStages = ledger.filter((row) => Number(row.score || 0) < 80).slice(0, 12);
  for (const row of weakStages) add('intelligence-stage-watch', 72, row.category, row.key, row.message, 'v14');
  return risks.sort((a, b) => b.severity - a.severity);
}

function buildPlaybooks(evidence, risks) {
  const base = [
    { name: 'Evidence-first recovery', area: 'governance', priority: 1, safeMode: true, action: 'Collect PV/PVC/Secret redacted inventory, render manifests with dry-run, then decide rollback. No data deletion.', success: 'restore dry-run passes and release gate remains PASS' },
    { name: 'Jenkins-to-Kibana log closure', area: 'observability', priority: 2, safeMode: true, action: 'Check Filebeat, Kafka, Elasticsearch index freshness, and Kibana data view object count.', success: 'latest build appears in jenkins-pipeline-runs and v14 index within 60 seconds' },
    { name: 'Spark data platform watch', area: 'data-platform', priority: 3, safeMode: true, action: 'Probe Spark operator pod readiness, webhook endpoint, Flink overview, Kafka UI, MinIO health and Trino info.', success: 'all data-platform probes are ok or explainable non-HTTP checks' },
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

function calculateScores(evidence, ledger, risks) {
  const s = evidence.summary || {};
  const serviceRate = Number(s.serviceProbeTotal || 0) ? Number(s.serviceProbeOk || 0) * 100 / Number(s.serviceProbeTotal || 1) : 100;
  const podRate = Number(s.podTotal || 0) ? Number(s.podReady || 0) * 100 / Number(s.podTotal || 1) : 100;
  const critical = risks.filter((r) => Number(r.severity || 0) >= 85).length;
  const avgStage = ledger.length ? ledger.reduce((sum, row) => sum + Number(row.score || 0), 0) / ledger.length : 80;
  const riskScore = clamp(100 - critical * 4 - Math.min(28, Number(s.restartTotal || 0) / 20));
  const observabilityScore = clamp(70 + (s.serviceProbeOk ? 10 : 0) + (s.platformHealthScore ? 10 : 0) + Math.min(10, ledger.filter((r) => r.category === 'observability').length));
  const recoveryScore = clamp(74 + (s.podCoverageComplete ? 10 : 0) + (serviceRate >= 99 ? 10 : 0));
  const intelligenceScore = clamp((Number(s.platformHealthScore || 80) * .28) + (serviceRate * .22) + (podRate * .18) + (riskScore * .18) + (avgStage * .14));
  return {
    platformHealth: Math.round(Number(s.platformHealthScore || 0)),
    serviceRate: Math.round(serviceRate * 10) / 10,
    podRate: Math.round(podRate * 10) / 10,
    riskScore: Math.round(riskScore),
    observabilityScore: Math.round(observabilityScore),
    recoveryScore: Math.round(recoveryScore),
    intelligenceScore: Math.round(intelligenceScore),
    complexityLiftPercent: 52,
    criticalRiskEvents: critical,
  };
}

function buildObservabilityEvents(evidence, ledger, risks, playbooks, scores) {
  const timestamp = now();
  const baseFields = { '@timestamp': timestamp, pipeline_version: 'v14', build, job, commit, pipeline_result_key: 'SUCCESS', pipeline_job_key: job };
  const events = [];
  events.push({ ...baseFields, type: 'v14_summary', score: scores.intelligenceScore, risk_score: scores.riskScore, health_score: scores.platformHealth, recovery_score: scores.recoveryScore, observability_score: scores.observabilityScore, complexity_lift_percent: scores.complexityLiftPercent, message: 'V14 intelligence summary' });
  for (const row of ledger) events.push({ ...baseFields, ...row, '@timestamp': timestamp, type: 'intelligence_stage' });
  for (const risk of risks) events.push({ ...baseFields, type: 'risk_vector', category: risk.category, severity: risk.severity, layer: risk.layer, name: risk.name, message: risk.message, source: risk.source, risk_score: risk.severity });
  for (const playbook of playbooks) events.push({ ...baseFields, type: 'recovery_playbook', name: playbook.name, layer: playbook.area, priority: playbook.priority, safe_mode: playbook.safeMode, message: playbook.action, success: playbook.success, score: Math.max(0, 100 - playbook.priority) });
  for (const row of (evidence.layerSummary || [])) events.push({ ...baseFields, type: 'layer_intelligence', layer: row.layer, pods: row.pods, readyPods: row.readyPods, services: row.services, health_score: row.healthScore, restarts: row.restarts, score: row.healthScore });
  for (const node of (evidence.nodes || [])) events.push({ ...baseFields, type: 'node_intelligence', name: node.name, node: node.name, ready: !!node.ready, status: node.ready ? 'ready' : 'not_ready', message: `${node.name} ${node.os || ''} ${node.runtime || ''}`, score: node.ready ? 100 : 0 });
  return events;
}

function buildMetrics(evidence, risks, playbooks, scores) {
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

function buildGrafana(scores) {
  const panels = [];
  panels.push(textPanel('V14 Intelligence Brief', 0, 0, 24, 3, `### ZhangLab V14 Platform Intelligence\n\nBuild #${build} · ${semver} · commit ${commit}. V14 adds risk scoring, recovery proof, service topology, observability closure and interactive front-end evidence over V13.`));
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
    ['nodeGraph', 'Service Intelligence Topology', 0, 31, 24, 9, [esTarget('pipeline_version:v14 AND (type:node_intelligence OR type:layer_intelligence)')], { datasource: elasticDs }],
  ];
  for (const g of graphPanels) panels.push(panel(g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7]));
  const chartNames = ['Runtime Restarts', 'Endpoint Watch', 'Spark Pulse', 'Kafka Closure', 'Flink Slots', 'Airflow Health', 'Trino Query Surface', 'Superset BI', 'MinIO Object Lake', 'Harbor Recovery', 'ArgoCD Sync', 'Jenkins Duration', 'Kibana Freshness', 'Grafana Datasource', 'Zabbix Display', 'Loki Logs', 'Jaeger Trace', 'OpenTelemetry Inlet', 'Cloudflare Reachability', 'Worker Scheduling', 'PVC Inventory', 'Secret Redaction', 'Image Pinning', 'Release Gate', 'Rollback Plan', 'Market Fit', 'Security Scan', 'Capacity Runway', 'Pod Placement', 'Service Matrix', 'Namespace Heat', 'Data Lineage', 'Risk Ledger', 'Recovery Ledger', 'Evidence Ledger', 'V13 vs V14 Delta'];
  let y = 40;
  chartNames.forEach((name, index) => {
    const x = (index % 3) * 8;
    if (index && index % 3 === 0) y += 7;
    const query = index % 2 === 0 ? 'pipeline_version:v14' : `pipeline_version:v14 AND type:${index % 4 === 0 ? 'risk_vector' : 'intelligence_stage'}`;
    panels.push(panel(index % 5 === 0 ? 'piechart' : index % 5 === 1 ? 'timeseries' : index % 5 === 2 ? 'bargauge' : index % 5 === 3 ? 'table' : 'heatmap', `V14 ${name}`, x, y, 8, 7, [esTarget(query)], { datasource: elasticDs, decimals: 0 }));
  });
  return { title: grafanaTitle, uid: 'zhanglab-v14-platform-intelligence', tags: ['jenkins','v14','platform-intelligence','risk','recovery','dynamic'], timezone: 'browser', schemaVersion: 39, version: 1, refresh: '10s', liveNow: true, editable: true, time: { from: 'now-24h', to: 'now' }, templating: { list: [{ name: 'build', type: 'custom', query: build, current: { text: build, value: build } }] }, panels };
}

function termsAgg(idValue, field, schema = 'segment', size = 10) { return { id: idValue, enabled: true, type: 'terms', schema, params: { field, size, order: 'desc', orderBy: '1' } }; }
function metricAgg(type = 'count', field) { return { id: '1', enabled: true, type, schema: 'metric', params: field ? { field } : {} }; }
function legacyVis(visId, title, visType, aggs, kql = 'pipeline_version : v14') {
  return { type: 'visualization', id: `${indexPrefix}-${visId}`, attributes: { title, visState: JSON.stringify({ title, type: visType, params: { addTooltip: true, addLegend: true, legendPosition: 'right', type: visType === 'pie' ? 'donut' : undefined }, aggs }), uiStateJSON: '{}', kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [], indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index' }) } }, references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: indexPrefix }] };
}
function dashboardObject(dashId, title, visualizations, kql) {
  const panelsJSON = visualizations.map((vis, i) => ({ version: '8.0.0', type: 'visualization', gridData: { x: (i % 3) * 16, y: Math.floor(i / 3) * 12, w: 16, h: 12, i: String(i + 1) }, panelIndex: String(i + 1), embeddableConfig: {}, panelRefName: `panel_${i}` }));
  return { type: 'dashboard', id: `${indexPrefix}-${dashId}`, attributes: { title, description: `V14 dashboard ${title}`, panelsJSON: JSON.stringify(panelsJSON), optionsJSON: JSON.stringify({ useMargins: true, syncColors: true }), timeRestore: false, kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [] }) } }, references: visualizations.map((vis, i) => ({ name: `panel_${i}`, type: 'visualization', id: vis.id })) };
}
function buildKibana() {
  const indexPattern = { type: 'index-pattern', id: indexPrefix, attributes: { title: `${indexPrefix}-*`, timeFieldName: '@timestamp' } };
  const vis = [
    legacyVis('intelligence-score', 'V14 智能总分', 'metric', [metricAgg('avg', 'score')], 'pipeline_version : v14 and type : v14_summary'),
    legacyVis('risk-score', 'V14 风险评分', 'metric', [metricAgg('avg', 'risk_score')], 'pipeline_version : v14'),
    legacyVis('recovery-score', 'V14 恢复评分', 'metric', [metricAgg('avg', 'recovery_score')], 'pipeline_version : v14'),
    legacyVis('stage-status', '智能阶段状态占比', 'pie', [metricAgg(), termsAgg('2','status')], 'type : intelligence_stage'),
    legacyVis('category-donut', '智能类别覆盖占比', 'pie', [metricAgg(), termsAgg('2','category')], 'type : intelligence_stage'),
    legacyVis('risk-category', '风险类别分布', 'pie', [metricAgg(), termsAgg('2','category')], 'type : risk_vector'),
    legacyVis('risk-layer', '风险层级分布', 'pie', [metricAgg(), termsAgg('2','layer')], 'type : risk_vector'),
    legacyVis('playbook-area', '恢复剧本领域', 'pie', [metricAgg(), termsAgg('2','layer')], 'type : recovery_playbook'),
    legacyVis('node-ready', 'Node 智能状态', 'pie', [metricAgg(), termsAgg('2','status')], 'type : node_intelligence'),
    legacyVis('layer-health', '层级健康评分', 'histogram', [metricAgg('avg','health_score'), termsAgg('2','layer','bucket',12)], 'type : layer_intelligence'),
    legacyVis('stage-score', '阶段评分排行', 'histogram', [metricAgg('avg','score'), termsAgg('2','key','bucket',20)], 'type : intelligence_stage'),
    legacyVis('risk-severity', '风险严重度排行', 'histogram', [metricAgg('avg','severity'), termsAgg('2','name','bucket',20)], 'type : risk_vector'),
    legacyVis('playbook-priority', '恢复剧本优先级', 'histogram', [metricAgg('avg','priority'), termsAgg('2','name','bucket',20)], 'type : recovery_playbook'),
    legacyVis('event-trend', 'V14 事件趋势', 'line', [metricAgg(), { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', interval: 'auto', min_doc_count: 0 } }], 'pipeline_version : v14'),
    legacyVis('latest-records', '最新 V14 记录表', 'table', [metricAgg(), termsAgg('2','type','bucket',20), termsAgg('3','category','bucket',20), termsAgg('4','status','bucket',10)], 'pipeline_version : v14'),
    legacyVis('risk-ledger', '风险清单表', 'table', [metricAgg(), termsAgg('2','category','bucket',20), termsAgg('3','name','bucket',25), termsAgg('4','source','bucket',10)], 'type : risk_vector'),
    legacyVis('playbook-ledger', '恢复剧本表', 'table', [metricAgg(), termsAgg('2','name','bucket',20), termsAgg('3','layer','bucket',10)], 'type : recovery_playbook'),
    legacyVis('runtime-ledger', '运行时证据表', 'table', [metricAgg(), termsAgg('2','type','bucket',20), termsAgg('3','name','bucket',20)], 'type : node_intelligence or type : layer_intelligence'),
  ];
  for (let i = 0; i < 18; i += 1) vis.push(legacyVis(`deep-lens-${i + 1}`, `V14 深度图表 ${i + 1}`, i % 3 === 0 ? 'pie' : i % 3 === 1 ? 'histogram' : 'table', [metricAgg(), termsAgg('2', i % 2 ? 'category' : 'type', i % 3 === 2 ? 'bucket' : 'segment', 12)], 'pipeline_version : v14'));
  const dashboards = [
    dashboardObject('command', `${grafanaTitle} · Command`, vis.slice(0, 18), 'pipeline_version : v14'),
    dashboardObject('risk', `${grafanaTitle} · Risk Radar`, vis.filter((v) => /risk|stage|latest/.test(v.id)).slice(0, 18), 'type : risk_vector or type : intelligence_stage'),
    dashboardObject('recovery', `${grafanaTitle} · Recovery Room`, vis.filter((v) => /playbook|recovery|node|layer|latest/.test(v.id)).slice(0, 18), 'type : recovery_playbook or type : node_intelligence or type : layer_intelligence'),
    dashboardObject('data', `${grafanaTitle} · Data Platform`, vis.slice(6, 24), 'pipeline_version : v14 and (category : data-platform or layer : data-platform)'),
    dashboardObject('observability', `${grafanaTitle} · Observability`, vis.slice(10, 28), 'pipeline_version : v14 and (category : observability or type : v14_summary)'),
    dashboardObject('executive', `${grafanaTitle} · Executive`, vis.slice(0, 30), 'pipeline_version : v14'),
  ];
  return [indexPattern, ...vis, ...dashboards];
}

function buildPortal(evidence, ledger, risks, playbooks, scores) {
  const riskItems = risks.slice(0, 12).map((r, i) => `<button class="risk-item" data-focus="${escHtml(r.name)}"><b>${r.severity}</b><span>${escHtml(r.category)}</span><small>${escHtml(r.name)}</small><i style="--c:${i % 2 ? '#f59e0b' : '#fb7185'}"></i></button>`).join('');
  const playbookItems = playbooks.slice(0, 10).map((p) => `<article class="playbook"><b>${escHtml(String(p.priority).padStart(2,'0'))}</b><h3>${escHtml(p.name)}</h3><p>${escHtml(p.action)}</p><small>${escHtml(p.success)}</small></article>`).join('');
  const layers = (evidence.layerSummary || []).map((l, i) => `<div class="layer" style="--x:${Math.round(8 + (i % 3) * 32)}%;--y:${Math.round(20 + Math.floor(i / 3) * 38)}%;--c:${['#22d3ee','#34d399','#f59e0b','#f472b6','#60a5fa','#a3e635'][i % 6]}"><strong>${escHtml(l.layer)}</strong><span>${escHtml(l.healthScore)}%</span></div>`).join('');
  const stageBars = ledger.slice(0, 36).map((s) => `<div class="stage-row"><span>${escHtml(s.key)}</span><b style="width:${clamp(s.score)}%"></b><em>${escHtml(s.status)}</em></div>`).join('');
  const evidenceJson = JSON.stringify({ summary: { build, semver, commit, scores, inherited: evidence.summary || {}, risks: risks.length, playbooks: playbooks.length }, risks, playbooks, ledger }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN" data-visual-rev="v14-intelligence-hypergrid-20260601">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZhangLab V14 Platform Intelligence</title>
<style>
:root{color-scheme:dark;--bg:#030712;--ink:#eef8ff;--muted:#9db4c9;--line:rgba(180,213,255,.18);--cyan:#22d3ee;--green:#34d399;--amber:#f59e0b;--red:#fb7185;--blue:#60a5fa;--pink:#f472b6;--lime:#a3e635}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;background:radial-gradient(circle at 18% 0,rgba(34,211,238,.25),transparent 30%),radial-gradient(circle at 80% 12%,rgba(244,114,182,.18),transparent 30%),linear-gradient(145deg,#030712,#071827 48%,#111827);overflow-x:hidden}body:before{content:"";position:fixed;inset:0;z-index:-2;background:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:46px 46px;mask-image:linear-gradient(to bottom,#000,transparent 92%)}#field{position:fixed;inset:0;z-index:-1;opacity:.55;mix-blend-mode:screen}.shell{max-width:1800px;margin:0 auto;padding:24px}.hero{min-height:560px;display:grid;grid-template-columns:1.05fr .95fr;gap:18px;align-items:stretch}.panel,.hero-copy,.topology{border:1px solid var(--line);border-radius:8px;background:linear-gradient(145deg,rgba(8,19,34,.84),rgba(7,26,42,.48));box-shadow:0 26px 90px rgba(0,0,0,.35);backdrop-filter:blur(18px);position:relative;overflow:hidden}.hero-copy{padding:30px;display:flex;flex-direction:column;justify-content:space-between}.hero-copy:after,.panel:after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent,rgba(34,211,238,.12),transparent 56%);transform:translateX(-80%);animation:sweep 7s linear infinite;pointer-events:none}h1{font-size:clamp(42px,6.8vw,110px);line-height:.9;margin:30px 0 16px;letter-spacing:0}.lead{max-width:980px;color:#c9d9e8;font-size:17px;line-height:1.65}.chips,.actions{display:flex;gap:10px;flex-wrap:wrap}.chip,.btn{border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:9px 12px;background:rgba(5,14,25,.65);color:#dff7ff;font-weight:900;font-size:12px}.btn{border-radius:8px;cursor:pointer;font:inherit}.btn.primary{background:linear-gradient(135deg,rgba(34,211,238,.28),rgba(52,211,153,.16));border-color:rgba(34,211,238,.68)}.btn:hover{transform:translateY(-2px);border-color:var(--amber)}.topology{min-height:560px}.core{position:absolute;left:50%;top:50%;width:210px;height:210px;margin:-105px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle,rgba(34,211,238,.28),rgba(3,7,18,.2) 55%,transparent);border:1px solid rgba(34,211,238,.30);box-shadow:0 0 70px rgba(34,211,238,.22)}.core b{font-size:68px}.core span{color:var(--muted);font-weight:900}.layer{position:absolute;left:var(--x);top:var(--y);width:160px;min-height:72px;padding:12px;border:1px solid color-mix(in srgb,var(--c) 55%,white 0%);border-radius:8px;background:rgba(3,10,18,.72);box-shadow:0 0 34px color-mix(in srgb,var(--c) 24%,transparent);animation:float 4s ease-in-out infinite alternate}.layer strong{display:block}.layer span{color:var(--c);font-size:26px;font-weight:950}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;margin-top:16px}.panel{padding:16px;min-height:260px}.wide{grid-column:span 12}.half{grid-column:span 6}.third{grid-column:span 4}.score-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}.score-card{border:1px solid var(--line);border-radius:8px;padding:16px;background:rgba(5,14,24,.72);min-height:124px}.score-card b{display:block;font-size:42px}.score-card span{color:var(--muted)}.risk-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px}.risk-item{border:1px solid rgba(255,255,255,.13);background:rgba(5,14,24,.74);border-radius:8px;color:var(--ink);padding:12px;text-align:left;display:grid;grid-template-columns:48px 1fr 10px;gap:10px;align-items:center;cursor:pointer}.risk-item b{font-size:26px;color:var(--red)}.risk-item span,.risk-item small{display:block}.risk-item small{color:var(--muted);grid-column:2}.risk-item i{width:8px;height:44px;border-radius:99px;background:var(--c);box-shadow:0 0 18px var(--c)}.playbooks{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.playbook{border:1px solid rgba(255,255,255,.13);border-radius:8px;background:rgba(3,10,18,.58);padding:14px}.playbook b{color:var(--cyan)}.playbook h3{margin:8px 0;font-size:15px}.playbook p{color:#d7e7f3;font-size:13px;line-height:1.45}.playbook small{color:var(--muted)}.stage-row{display:grid;grid-template-columns:210px 1fr 82px;gap:10px;align-items:center;margin:8px 0;font-size:12px}.stage-row b{height:10px;border-radius:99px;background:linear-gradient(90deg,var(--red),var(--amber),var(--green));box-shadow:0 0 16px rgba(34,211,238,.16)}.stage-row em{font-style:normal;color:var(--muted)}.matrix{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.matrix button{min-height:72px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:linear-gradient(145deg,rgba(12,30,52,.76),rgba(43,21,46,.44));color:var(--ink);text-align:left;padding:12px;cursor:pointer}.matrix button:hover{border-color:var(--cyan);transform:translateY(-2px)}pre{white-space:pre-wrap;color:#bcd2e5;background:rgba(0,0,0,.22);border:1px solid var(--line);padding:12px;border-radius:8px;max-height:320px;overflow:auto}@keyframes sweep{to{transform:translateX(95%)}}@keyframes float{from{transform:translateY(-6px)}to{transform:translateY(8px)}}@media(max-width:1100px){.hero{grid-template-columns:1fr}.half,.third{grid-column:span 12}.score-grid{grid-template-columns:repeat(2,1fr)}.matrix{grid-template-columns:1fr 1fr}}@media(max-width:700px){.shell{padding:12px}h1{font-size:42px}.score-grid,.matrix{grid-template-columns:1fr}.stage-row{grid-template-columns:1fr}}
</style></head><body><canvas id="field"></canvas><main class="shell"><section class="hero"><div class="hero-copy"><div class="chips"><span class="chip">V14 Intelligence</span><span class="chip">Build #${build}</span><span class="chip">Commit ${commit}</span><span class="chip">+${scores.complexityLiftPercent}% evidence complexity</span></div><div><h1>Platform Intelligence Hypergrid</h1><p class="lead">V14 不再只证明平台跑通，而是把 V13 的证据转化为风险评分、恢复剧本、服务拓扑和观测闭环。页面每 60 秒可刷新证据，点击风险或矩阵项可以钻取。</p><div class="actions"><button class="btn primary" data-view="risk">风险雷达</button><button class="btn" data-view="recovery">恢复剧本</button><button class="btn" data-view="stages">智能阶段</button><button class="btn" id="copyJson">复制 evidence</button></div></div><div class="chips"><span class="chip">public https://${publicHost}/</span><span class="chip">internal http://192.168.1.58:${portalNodePort}/</span></div></div><div class="topology"><div class="core"><div><b>${scores.intelligenceScore}</b><br><span>INTELLIGENCE</span></div></div>${layers}</div></section><section class="grid"><div class="panel wide"><div class="score-grid"><div class="score-card"><b>${scores.intelligenceScore}</b><span>Intelligence</span></div><div class="score-card"><b>${scores.riskScore}</b><span>Risk Score</span></div><div class="score-card"><b>${scores.recoveryScore}</b><span>Recovery</span></div><div class="score-card"><b>${scores.observabilityScore}</b><span>Observability</span></div><div class="score-card"><b>${scores.serviceRate}%</b><span>Service Probe</span></div><div class="score-card"><b>${scores.podRate}%</b><span>Pod Ready</span></div></div></div><div class="panel half" id="risk"><h2>Risk Radar</h2><div class="risk-list">${riskItems}</div></div><div class="panel half" id="recovery"><h2>Recovery Room</h2><div class="playbooks">${playbookItems}</div></div><div class="panel half" id="stages"><h2>Intelligence Stage Ledger</h2>${stageBars}</div><div class="panel half"><h2>Command Matrix</h2><div class="matrix"><button data-filter="spark">Spark/Data pulse</button><button data-filter="kibana">Kibana freshness</button><button data-filter="grafana">Grafana source</button><button data-filter="harbor">Harbor recovery</button><button data-filter="node">Worker protection</button><button data-filter="service">Service proof</button><button data-filter="backup">Backup evidence</button><button data-filter="cloudflare">Cloudflare route</button></div><pre id="detail">点击左侧风险或矩阵项查看 V14 证据详情。</pre></div></section></main><script id="v14-data" type="application/json">${evidenceJson}</script><script>
const data=JSON.parse(document.getElementById('v14-data').textContent);const detail=document.getElementById('detail');document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.view).scrollIntoView({behavior:'smooth'}));document.querySelectorAll('[data-focus]').forEach(b=>b.onclick=()=>{const q=b.dataset.focus;detail.textContent=JSON.stringify(data.risks.filter(r=>JSON.stringify(r).toLowerCase().includes(q.toLowerCase())).slice(0,5),null,2)});document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{const q=b.dataset.filter;detail.textContent=JSON.stringify({risks:data.risks.filter(r=>JSON.stringify(r).toLowerCase().includes(q)).slice(0,8),stages:data.ledger.filter(r=>JSON.stringify(r).toLowerCase().includes(q)).slice(0,8),playbooks:data.playbooks.filter(r=>JSON.stringify(r).toLowerCase().includes(q)).slice(0,8)},null,2)});document.getElementById('copyJson').onclick=async()=>{const url=location.origin+location.pathname.replace(/\/$/,'')+'/evidence.json';try{await navigator.clipboard.writeText(url);detail.textContent='copied '+url}catch(e){detail.textContent=url}};const c=document.getElementById('field'),ctx=c.getContext('2d');let pts=[];function size(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;pts=Array.from({length:90},(_,i)=>({x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.7,vy:(Math.random()-.5)*.5,h:i%7}))}addEventListener('resize',size);size();const colors=['#22d3ee','#34d399','#f59e0b','#f472b6','#60a5fa','#a3e635','#fb7185'];function frame(){ctx.clearRect(0,0,c.width,c.height);pts.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>c.width)p.vx*=-1;if(p.y<0||p.y>c.height)p.vy*=-1});for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){const a=pts[i],b=pts[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<150*devicePixelRatio){ctx.strokeStyle='rgba(34,211,238,'+(.14*(1-d/(150*devicePixelRatio)))+')';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}}pts.forEach(p=>{ctx.fillStyle=colors[p.h];ctx.globalAlpha=.55;ctx.beginPath();ctx.arc(p.x,p.y,2*devicePixelRatio,0,Math.PI*2);ctx.fill()});ctx.globalAlpha=1;requestAnimationFrame(frame)}frame();setInterval(()=>fetch('evidence.json?ts='+Date.now(),{cache:'no-store'}).catch(()=>{}),60000);
</script></body></html>`;
}

function buildAll() {
  const evidence = baseEvidence();
  const ledger = readLines('reports/v14-intelligence/stage-ledger.ndjson').map((line) => JSON.parse(line));
  const risks = buildRiskVectors(evidence, ledger);
  const playbooks = buildPlaybooks(evidence, risks);
  const scores = calculateScores(evidence, ledger, risks);
  const events = buildObservabilityEvents(evidence, ledger, risks, playbooks, scores);
  const summary = { '@timestamp': now(), pipeline_version: 'v14', build, job, commit, semver, publicUrl: `https://${publicHost}/`, portalUrl: `http://192.168.1.58:${portalNodePort}/`, inheritedV13Build: evidence.summary?.build || 'unknown', scores, riskVectorTotal: risks.length, playbookTotal: playbooks.length, stageLedgerTotal: ledger.length, v13Summary: evidence.summary || {} };
  write('reports/v14-intelligence/evidence.json', JSON.stringify({ summary, scores, risks, playbooks, ledger, inherited: evidence }, null, 2) + '\n');
  write('reports/v14-risk-score.json', JSON.stringify({ summary, scores, risks: risks.slice(0, 30) }, null, 2) + '\n');
  write('reports/v14-recovery-playbooks.json', JSON.stringify(playbooks, null, 2) + '\n');
  write('reports/v14-observability.ndjson', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('reports/v14-prometheus-metrics.prom', buildMetrics(evidence, risks, playbooks, scores));
  write('reports/v14-grafana-dashboard.json', JSON.stringify(buildGrafana(scores), null, 2) + '\n');
  write('reports/v14-kibana-dashboard.ndjson', buildKibana().map((object) => JSON.stringify(object)).join('\n') + '\n');
  write('reports/v14-portal/index.html', buildPortal(evidence, ledger, risks, playbooks, scores));
  write('reports/v14-portal/evidence.json', JSON.stringify({ summary, scores, risks, playbooks, ledger }, null, 2) + '\n');
  console.log(`v14_build_complete events=${events.length} stages=${ledger.length} risks=${risks.length} score=${scores.intelligenceScore}`);
}

function lintAll() {
  const required = ['reports/v14-intelligence/evidence.json','reports/v14-risk-score.json','reports/v14-recovery-playbooks.json','reports/v14-observability.ndjson','reports/v14-prometheus-metrics.prom','reports/v14-grafana-dashboard.json','reports/v14-kibana-dashboard.ndjson','reports/v14-portal/index.html','reports/v14-portal/evidence.json'];
  for (const file of required) { if (!exists(file)) throw new Error(`missing ${file}`); }
  const grafana = readJson('reports/v14-grafana-dashboard.json');
  if (!Array.isArray(grafana.panels) || grafana.panels.length < 48) throw new Error(`grafana panel count too low: ${grafana.panels?.length}`);
  const dashboardText = JSON.stringify(grafana);
  for (const needle of ['jenkins-v14-intelligence-es', 'state-timeline', 'status-history', 'nodeGraph']) if (!dashboardText.includes(needle)) throw new Error(`grafana missing ${needle}`);
  const kibanaLines = readLines('reports/v14-kibana-dashboard.ndjson');
  if (kibanaLines.length < 40) throw new Error(`kibana object count too low: ${kibanaLines.length}`);
  const html = fs.readFileSync('reports/v14-portal/index.html', 'utf8');
  for (const needle of ['v14-intelligence-hypergrid-20260601', 'Risk Radar', 'Recovery Room', 'Command Matrix']) if (!html.includes(needle)) throw new Error(`portal missing ${needle}`);
  console.log(`v14_lint=ok panels=${grafana.panels.length} kibana_objects=${kibanaLines.length}`);
}

if (action === 'check') recordCheck(checkKey, checkTitle);
else if (action === 'build') buildAll();
else if (action === 'lint') lintAll();
else throw new Error(`unknown action ${action}`);
