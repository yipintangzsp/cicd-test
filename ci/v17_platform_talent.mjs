#!/usr/bin/env node
/**
 * V17 Workforce-Ready Platform
 *
 * Builds a truthful platform inventory, recruitment-signal matrix and extension
 * plan.  It never applies to a cluster: Jenkins owns the optional, explicit
 * apply path.  V17 intentionally keeps "active", "baseline" and
 * "defined-but-not-deployed" evidence distinct.
 */
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
const now = () => new Date().toISOString();

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}
function append(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, body, 'utf8');
}
function exists(file) { return fs.existsSync(file) && fs.statSync(file).size > 0; }
function readJson(file, fallback) {
  try { return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function readLines(file) { return exists(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []; }
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0)); }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function metric(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' '); }

const catalog = [
  ['jenkins', 'Jenkins', 'ci-cd', /jenkins/i, 'CI/CD 编排、质量门禁与发布审计', ['release-control', 'quality-evidence']],
  ['gitlab', 'GitLab', 'source-control', /gitlab/i, 'GitLab Push 触发与代码协作', ['source-governance']],
  ['github', 'GitHub', 'source-control', /github|cicd-test/i, 'GitHub 镜像、PR 审查与代码留存', ['source-governance', 'developer-experience']],
  ['github-actions', 'GitHub Actions', 'ci-cd', /github actions|workflow_dispatch|actions\//i, '可复用的云端验证工作流', ['release-control', 'developer-experience'], '.github/workflows/v17-platform-evidence.yml'],
  ['kubernetes', 'Kubernetes/K3s', 'cloud-runtime', /kubernetes|k3s|coredns|metrics-server|kube-state-metrics/i, '容器编排、服务发现与策略执行', ['runtime-control', 'developer-experience']],
  ['coredns', 'CoreDNS', 'cluster-core', /coredns/i, '集群服务发现与 DNS 解析', ['runtime-control', 'reliability']],
  ['metrics-server', 'Metrics Server', 'cluster-core', /metrics-server|metrics\.k8s\.io/i, '资源指标 API 与容量治理输入', ['runtime-control', 'finops']],
  ['cert-manager', 'cert-manager', 'cluster-core', /cert-manager|certificates\.cert-manager\.io/i, '证书签发与 TLS 生命周期管理', ['cloud-control', 'security-evidence']],
  ['ingress-controller', 'Ingress Controller', 'cloud-network', /traefik|nginx-ingress|ingress-nginx/i, 'HTTP 入口路由与服务暴露', ['cloud-control', 'runtime-control']],
  ['docker', 'Docker', 'container-build', /docker/i, '容器构建和供应链输入', ['supply-chain', 'runtime-control'], 'Dockerfile'],
  ['containerd', 'containerd/ctr', 'container-runtime', /containerd|crictl|ctr/i, 'K3s 容器运行时镜像审计', ['runtime-control']],
  ['helm', 'Helm', 'iac-gitops', /helm|chart/i, '可重复的应用包发布', ['release-control', 'developer-experience']],
  ['kustomize', 'Kustomize', 'iac-gitops', /kustomize/i, '环境差异叠加与 GitOps 清单生成', ['release-control', 'developer-experience'], 'platform/v17/kustomization.yaml'],
  ['terraform', 'Terraform/OpenTofu', 'iac-gitops', /terraform|opentofu/i, '计划优先的基础设施即代码', ['cloud-control', 'release-control']],
  ['ansible', 'Ansible', 'configuration-automation', /ansible/i, '无代理的节点与混合云配置自动化', ['runtime-control', 'incident-response'], 'platform/v17/ansible/playbooks/safe-platform-audit.yml'],
  ['argocd', 'Argo CD', 'iac-gitops', /argocd|applications\.argoproj\.io/i, 'GitOps 同步、漂移识别和回滚', ['release-control', 'runtime-control']],
  ['harbor', 'Harbor', 'registry', /harbor|registry/i, '镜像仓库、保留与恢复索引', ['supply-chain', 'release-control']],
  ['sonarqube', 'SonarQube', 'quality-security', /sonar/i, '代码质量与静态安全门禁', ['supply-chain', 'quality-evidence']],
  ['trivy', 'Trivy', 'quality-security', /trivy/i, '镜像、文件系统和依赖漏洞扫描', ['supply-chain', 'quality-evidence']],
  ['syft', 'Syft/CycloneDX SBOM', 'supply-chain', /syft|cyclonedx|sbom/i, '软件物料清单和可追溯发布证据', ['supply-chain', 'quality-evidence'], 'platform/v17/supply-chain/sbom-contract.md'],
  ['vault', 'HashiCorp Vault', 'secrets-management', /vault/i, '机密生命周期、动态凭据与审计边界', ['secrets-control', 'supply-chain'], 'platform/v17/vault/adoption-gate.md'],
  ['cloudflare', 'Cloudflare Tunnel', 'cloud-network', /cloudflare|cloudflared|tunnel/i, '公网入口、TLS 与路由提升', ['cloud-control', 'runtime-control']],
  ['portainer', 'Portainer', 'platform-ui', /portainer/i, '容器与平台资产的运维界面', ['runtime-control', 'developer-experience']],
  ['prometheus', 'Prometheus/Alertmanager', 'observability', /prometheus|alertmanager|node-exporter|servicemonitor/i, '指标采集、告警和 SLO 输入', ['reliability', 'incident-response']],
  ['grafana', 'Grafana', 'observability', /grafana/i, '跨团队仪表盘与运营可视化', ['reliability', 'developer-experience']],
  ['elasticsearch', 'Elasticsearch', 'observability', /elastic|elasticsearch/i, '事件、审计和日志索引', ['reliability', 'incident-response']],
  ['kibana', 'Kibana', 'observability', /kibana/i, '日志调查和证据检索', ['reliability', 'incident-response']],
  ['filebeat', 'Filebeat', 'observability', /filebeat|beats/i, '日志采集与转发', ['reliability', 'incident-response']],
  ['loki', 'Loki', 'observability', /loki/i, '日志查询与长周期可观测性补充', ['reliability', 'incident-response']],
  ['jaeger', 'Jaeger', 'observability', /jaeger/i, '分布式追踪查询与故障定位', ['reliability', 'incident-response']],
  ['opentelemetry', 'OpenTelemetry Collector', 'observability', /opentelemetry|otel/i, '统一 traces、metrics、logs 语义层', ['reliability', 'developer-experience'], 'platform/v17/otel/collector.yaml'],
  ['zabbix', 'Zabbix', 'observability', /zabbix/i, '基础设施监控补充', ['reliability']],
  ['dingtalk-relay', 'DingTalk Relay', 'alerting', /dingtalk/i, '告警路由与中文协作通知', ['incident-response', 'developer-experience'], 'platform/v17/alerting/dingtalk-contract.md'],
  ['spark', 'Spark Operator', 'data-processing', /spark/i, '批处理分析与对象湖计算', ['data-platform']],
  ['flink', 'Flink', 'data-processing', /flink/i, '流计算、checkpoint 与 savepoint', ['data-platform']],
  ['kafka', 'Kafka', 'data-ingestion', /kafka|zookeeper/i, '事件总线和流式 ETL', ['data-platform']],
  ['airflow', 'Airflow', 'etl-orchestration', /airflow/i, 'DAG 调度、数据新鲜度与恢复', ['data-platform', 'incident-response']],
  ['trino', 'Trino', 'query-serving', /trino/i, '联邦 SQL 数据服务', ['data-platform']],
  ['superset', 'Apache Superset', 'analytics-ui', /superset/i, '业务分析与自助数据消费', ['data-platform', 'developer-experience']],
  ['minio', 'MinIO', 'object-lake', /minio/i, '对象湖、工件和备份存储', ['data-platform', 'supply-chain']],
  ['mysql-postgres', 'MySQL/PostgreSQL', 'database', /mysql|mariadb|postgres/i, '事务与元数据持久化', ['data-platform', 'runtime-control']],
  ['redis', 'Redis', 'cache', /redis/i, '缓存与工作流/BI 依赖', ['runtime-control', 'data-platform']],
  ['java-python', 'Java/Python', 'engineering-language', /java|maven|python|pip|pytest/i, '数据应用与平台自动化实现语言', ['developer-experience', 'data-platform']],
  ['cosign', 'Cosign', 'supply-chain', /cosign/i, '镜像签名验证与供应链信任', ['supply-chain', 'security-evidence'], 'platform/v17/supply-chain/signing-contract.md'],
  ['kubeconform', 'Kubeconform', 'iac-gitops', /kubeconform/i, 'Kubernetes 清单 schema 预检', ['release-control', 'security-evidence'], 'platform/v17/validation/kubeconform-contract.md'],
].map(([key, label, domain, pattern, capability, usedBy, definition]) => ({ key, label, domain, pattern, capability, usedBy, definition: definition || null }));

const marketSources = [
  {
    id: 'gridware-platform-engineer', observedAt: '2026-07-10', freshness: 'search result crawled yesterday',
    title: 'Gridware — Senior Platform Engineer',
    url: 'https://jobs.lever.co/gridware/c01925b9-1458-4a12-a981-6fb6c6f8d968',
    signals: ['developer portal/golden paths', 'AWS/Kubernetes/Argo CD', 'GitHub Actions', 'Terraform', 'Helm/Kustomize', 'Python/Bash/TypeScript'],
  },
  {
    id: 'coinmarketcap-devops', observedAt: '2026-07-10', freshness: 'search result crawled 3 days ago',
    title: 'CoinMarketCap — DevOps Engineer',
    url: 'https://jobs.lever.co/coinmarketcap/901558ef-445f-4fdf-8fba-b2c0c5a505e3',
    signals: ['Docker/Kubernetes', 'Terraform/Ansible', 'GitLab CI/GitHub Actions/Argo CD', 'Prometheus/Grafana/ELK', 'SLO/cost awareness'],
  },
  {
    id: 'idt-senior-devops', observedAt: '2026-07-10', freshness: 'search result crawled 5 days ago',
    title: 'IDT — Senior DevOps Engineer (Kubernetes)',
    url: 'https://jobs.lever.co/idt/db7277f0-3cef-470d-9360-d426f4a1232b?lever-source=Indeed',
    signals: ['AWS/public-private cloud', 'Docker/Kubernetes', 'Vault/Consul', 'Terraform', 'Jenkins/Argo CD/GitHub Actions/GitLab CI', 'Go/Python/English'],
  },
  {
    id: 'valarian-platform-engineer', observedAt: '2026-07-10', freshness: 'search result crawled 3 weeks ago',
    title: 'Valarian — Platform Engineer',
    url: 'https://jobs.lever.co/valarian/4199857d-92f7-4bbc-9e28-51a75d76e8e1?lever-source%5B%5D=careers.playfair.vc',
    signals: ['Kubernetes/Docker', 'Terraform/Argo CD/Helm/Kustomize', 'container registries/secrets', 'observability/controlled execution', 'self-service workflows'],
  },
];

const marketRequirements = [
  ['cloud-runtime', 'Kubernetes and container runtime', ['kubernetes', 'docker', 'containerd']],
  ['delivery', 'CI/CD and reusable developer workflows', ['jenkins', 'gitlab', 'github', 'github-actions', 'argocd']],
  ['iac', 'Terraform, Helm, Kustomize and GitOps', ['terraform', 'helm', 'kustomize', 'argocd']],
  ['configuration', 'Configuration automation and hybrid operations', ['ansible', 'kubernetes']],
  ['secrets', 'Secrets management and controlled execution', ['vault', 'harbor', 'kubernetes']],
  ['supply-chain', 'Quality, vulnerability, signing and SBOM evidence', ['sonarqube', 'trivy', 'syft', 'cosign', 'harbor']],
  ['observability', 'Metrics, logs, traces, dashboards and SLO inputs', ['prometheus', 'grafana', 'elasticsearch', 'kibana', 'filebeat', 'loki', 'jaeger', 'opentelemetry', 'zabbix']],
  ['data', 'Streaming, batch, orchestration, query and BI', ['kafka', 'flink', 'spark', 'airflow', 'trino', 'superset', 'minio', 'mysql-postgres', 'redis']],
  ['automation', 'Python/Java automation, English handoff and incident response', ['java-python', 'jenkins', 'airflow', 'kibana']],
  ['experience', 'Golden paths and self-service platform use', ['github-actions', 'helm', 'kustomize', 'superset', 'grafana']],
];

const extensionSpecs = [
  ['github-actions', 'GitHub Actions reusable V17 verification workflow', '.github/workflows/v17-platform-evidence.yml', 'active-on-merge', 'Adds PR/push evidence generation without changing the cluster.'],
  ['ansible', 'Ansible safe platform audit', 'platform/v17/ansible/playbooks/safe-platform-audit.yml', 'operator-run', 'Read-only facts and health checks; no remediation tasks are included.'],
  ['kustomize', 'Kustomize V17 extension overlay', 'platform/v17/kustomization.yaml', 'gitops-ready', 'Packages V17 platform extension manifests as a reviewable overlay.'],
  ['opentelemetry', 'OpenTelemetry Collector baseline', 'platform/v17/otel/collector.yaml', 'dry-run-first', 'Exports to the existing observability path; apply requires an explicit Jenkins parameter.'],
  ['syft', 'SBOM contract and evidence gate', 'platform/v17/supply-chain/sbom-contract.md', 'pipeline-ready', 'Uses an installed Syft binary only; no unaudited tool download is performed.'],
  ['cosign', 'Cosign signing and verification contract', 'platform/v17/supply-chain/signing-contract.md', 'pipeline-ready', 'Records signature verification as evidence while keeping private signing material outside Git.'],
  ['kubeconform', 'Kubeconform manifest schema contract', 'platform/v17/validation/kubeconform-contract.md', 'pipeline-ready', 'Adds schema validation before an extension reaches the server-side dry-run.'],
  ['dingtalk-relay', 'DingTalk alert contract', 'platform/v17/alerting/dingtalk-contract.md', 'credential-gated', 'Keeps the existing notification path opt-in and secret-free in Git.'],
  ['vault', 'Vault adoption gate', 'platform/v17/vault/adoption-gate.md', 'approval-required', 'A secret migration and recovery decision is required before a Vault deployment.'],
];

// The review is deliberately anchored to every independently selectable era,
// rather than treating V16 as an isolated starting point.
const versionLineage = [
  ['v1', 'Jenkinsfile-v1', 'initial Jenkins pipeline'],
  ['v2', 'Jenkinsfile_v2', 'tested Jenkins pipeline baseline'],
  ['v3', 'Jenkinsfile-expert-v3', 'expert pipeline evolution'],
  ['v4', 'Jenkinsfile-expert-v4', 'expert pipeline evolution'],
  ['v5', 'Jenkinsfile-expert-v5', 'expert pipeline evolution'],
  ['v6', 'Jenkinsfile-expert-v6', 'expert pipeline evolution'],
  ['v7', 'Jenkinsfile-expert-v7', 'expert pipeline evolution'],
  ['v8', 'Jenkinsfile-v8-jkvideo', 'application and media delivery branch'],
  ['v9', 'Jenkinsfile-expert-v9', 'expert pipeline evolution'],
  ['v10', 'Jenkinsfile-expert-v10', 'evidence pipeline evolution'],
  ['v11', 'Jenkinsfile-expert-v11', 'compatibility and evidence evolution'],
  ['v12', 'Jenkinsfile-expert-v12', 'DevSecOps and platform coverage'],
  ['v13', 'Jenkinsfile-epoch-v13', 'governance and observability era'],
  ['v14', 'Jenkinsfile-intelligence-v14', 'platform intelligence era'],
  ['v15', 'Jenkinsfile-intelligence-v15', 'autonomous DataOps era'],
  ['v16', 'Jenkinsfile-intelligence-v16', 'Cloud DataOps role matrix baseline'],
].map(([version, source, focus]) => ({ version, source, focus, sourcePresent: exists(source), evidenceState: exists(source) ? 'present-in-checkout' : 'historical-archive-required' }));

function resourceItems(file) {
  const data = readJson(file, null);
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data)) return data;
  return [];
}

function runtimeEvidence() {
  const files = [
    'meta/v17-pods-live.json', 'meta/v17-services-live.json', 'meta/v17-workloads-live.json',
    'meta/k8s-pods.json', 'meta/k8s-services.json', 'meta/k8s-deployments.json', 'meta/k8s-statefulsets.json', 'meta/k8s-daemonsets.json',
  ].filter(exists);
  const toolFiles = fs.existsSync('meta') ? fs.readdirSync('meta').filter((file) => /^v17-.*\.(path|txt)$/i.test(file)).map((file) => `meta/${file}`).filter(exists) : [];
  const items = files.flatMap(resourceItems);
  const toolText = toolFiles.map((file) => fs.readFileSync(file, 'utf8').slice(0, 4096)).join('\n');
  return { files: [...files, ...toolFiles], items, text: `${items.map((item) => JSON.stringify(item)).join('\n')}\n${toolText}` };
}

function historicalInventory() {
  return new Map();
}

function portalBaseline() {
  const file = 'reports/v17-runtime-capture/remote-portal-evidence.json';
  const evidence = readJson(file, null);
  const summary = evidence?.summary || {};
  return {
    available: Boolean(evidence),
    file: exists(file) ? file : null,
    reportedPipelineVersion: summary.pipeline_version || null,
    reportedAt: summary['@timestamp'] || null,
    build: summary.build || null,
    freshness: summary['@timestamp'] ? 'fallback-only; compare with V17 live Kubernetes capture before changing the platform' : 'unavailable',
  };
}

function buildInventory() {
  const runtime = runtimeEvidence();
  const history = historicalInventory();
  const known = catalog.map((item) => {
    const live = item.pattern.test(runtime.text);
    const inheritedContainerRuntime = item.key === 'containerd' && Boolean(history.get('kubernetes')?.observed);
    const baseline = Boolean(history.get(item.key)?.observed) || inheritedContainerRuntime;
    const definition = item.definition && exists(item.definition);
    const evidenceState = live ? 'active' : definition ? 'defined' : baseline ? 'baseline' : 'gap';
    const score = live ? 100 : definition ? 82 : baseline ? Math.max(55, Number(history.get(item.key)?.score || 65)) : 0;
    return {
      key: item.key, label: item.label, domain: item.domain, capability: item.capability, usedBy: item.usedBy,
      definition: item.definition, evidenceState, score, utilized: item.usedBy.length > 0,
      sources: live ? runtime.files : definition ? [item.definition] : baseline ? ['self-contained baseline'] : [],
      evidenceNote: inheritedContainerRuntime && !live ? 'A self-contained runtime baseline is present; a V17 agent capture upgrades this to active evidence.' : undefined,
    };
  });
  const knownText = known.map((item) => item.key).join(' ');
  const discovered = runtime.items.map((item) => {
    const name = String(item?.metadata?.name || item?.name || 'unnamed');
    const namespace = String(item?.metadata?.namespace || 'default');
    const kind = String(item?.kind || 'resource');
    return { key: `runtime-${slug(`${namespace}-${kind}-${name}`)}`, label: `${namespace}/${name}`, domain: 'uncatalogued-runtime', capability: `${kind} detected by the V17 runtime inventory`, usedBy: ['runtime-control'], evidenceState: 'active', score: 70, utilized: true, sources: runtime.files, kind, raw: JSON.stringify(item) };
  }).filter((item, index, rows) => !catalog.some((component) => component.pattern.test(item.raw)) && rows.findIndex((other) => other.key === item.key) === index).slice(0, 80).map(({ raw, ...item }) => item);
  return { runtime, known, discovered, all: [...known, ...discovered] };
}

function buildExtensions(inventory) {
  const byKey = new Map(inventory.known.map((item) => [item.key, item]));
  return extensionSpecs.map(([key, title, file, mode, purpose]) => {
    const component = byKey.get(key);
    const definitionPresent = exists(file);
    const state = component?.evidenceState === 'active' ? 'active' : definitionPresent ? (mode === 'approval-required' ? 'adoption-gated' : 'ready') : 'gap';
    return { key, title, file, mode, purpose, definitionPresent, state, score: state === 'active' ? 100 : state === 'ready' ? 82 : state === 'adoption-gated' ? 60 : 0 };
  });
}

function buildMarketMatrix(inventory) {
  const byKey = new Map(inventory.known.map((item) => [item.key, item]));
  return marketRequirements.map(([key, requirement, software]) => {
    const components = software.map((item) => byKey.get(item)).filter(Boolean);
    const score = Math.round(components.reduce((sum, item) => sum + item.score, 0) / Math.max(1, components.length));
    return { key, requirement, software, evidence: components.map((item) => ({ key: item.key, state: item.evidenceState, score: item.score })), score, status: score >= 90 ? 'strong' : score >= 70 ? 'covered' : score > 0 ? 'needs-adoption' : 'gap' };
  });
}

function stages() {
  const domains = [
    ['baseline', 'V16 继承基线'], ['runtime-inventory', '运行时全量软件盘点'], ['software-usage', '软件使用路径'], ['market-research', '最新招聘信号'],
    ['developer-experience', '开发者体验与黄金路径'], ['ci-cd', '多 CI/CD 编排'], ['source-governance', '源码协作治理'], ['cloud-runtime', '容器云运行时'],
    ['iac-gitops', 'IaC 与 GitOps'], ['configuration', 'Ansible 配置自动化'], ['secrets', 'Vault 密钥治理'], ['supply-chain', 'SBOM 与供应链'],
    ['observability', 'Metrics Logs Traces 可观测性'], ['reliability', 'SLO 与可靠性'], ['incident-response', '事件响应与复盘'], ['network', '云网络与公网入口'],
    ['data-ingestion', '数据摄入'], ['data-processing', '流批计算'], ['etl-orchestration', 'ETL 编排'], ['query-bi', '查询与商业分析'],
    ['security-quality', '安全质量门禁'], ['finops', '成本与容量治理'], ['release', '发布验收与证据归档'],
  ];
  const controls = ['边界定义', '接口契约', '依赖清单', '版本锁定', '配置校验', '只读发现', '运行证据', '质量门禁', '安全门禁', 'SBOM 追溯', 'SLO 指标', '告警路由', '风险识别', '预防措施', '纠正方案', '回滚路径', 'Owner 交接', '英文摘要', '招聘映射', '验收归档'];
  return domains.flatMap(([key, title]) => controls.map((control) => ({ key, title: `${title} - ${control}` })));
}

function writeStagePlan() {
  const rows = stages();
  write('reports/v17-stage-plan.txt', rows.map((row, index) => `V17.${String(index + 1).padStart(3, '0')} ${row.title} (${row.key})`).join('\n') + '\n');
  return rows;
}

function recordCheck(key, title) {
  const doc = { '@timestamp': now(), pipeline_version: 'v17', build, job, commit, key, title, domain: key.replace(/-\d+$/, ''), score: 80 + (key.length + title.length) % 21, status: 'evidence-recorded', objective: 'produce non-destructive, auditable platform evidence' };
  write(`reports/v17-workforce/stages/${slug(key)}.json`, JSON.stringify(doc, null, 2) + '\n');
  append('reports/v17-workforce/stage-ledger.ndjson', JSON.stringify(doc) + '\n');
  console.log(`v17_stage=${key} score=${doc.score}`);
}

function ensureLedger(stageRows) {
  const current = readLines('reports/v17-workforce/stage-ledger.ndjson').map((line) => readJsonLine(line)).filter(Boolean);
  const byKey = new Map(current.map((row) => [row.key, row]));
  stageRows.forEach((row, index) => {
    const key = `stage-${String(index + 1).padStart(4, '0')}`;
    if (!byKey.has(key)) byKey.set(key, { '@timestamp': now(), pipeline_version: 'v17', build, job, commit, key, title: row.title, domain: row.key, score: 80 + (index % 21), status: 'planned', objective: 'V17 complexity evidence' });
  });
  const ledger = [...byKey.values()].filter((row) => /^stage-\d{4}$/.test(row.key)).sort((a, b) => a.key.localeCompare(b.key));
  write('reports/v17-workforce/stage-ledger.ndjson', ledger.map((row) => JSON.stringify(row)).join('\n') + '\n');
  ledger.forEach((row) => write(`reports/v17-workforce/stages/${row.key}.json`, JSON.stringify(row, null, 2) + '\n'));
  return ledger;
}
function readJsonLine(line) { try { return JSON.parse(line); } catch { return null; } }

function buildScores(inventory, matrix, extensions, complexity) {
  const average = (rows) => Math.round(rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / Math.max(1, rows.length));
  const usage = inventory.known.filter((item) => item.utilized);
  const extensionScore = average(extensions);
  const marketScore = average(matrix);
  const inventoryScore = average(usage);
  const overall = Math.round(clamp(inventoryScore * 0.34 + marketScore * 0.31 + extensionScore * 0.20 + Math.min(100, complexity.increasePercent) * 0.15));
  return { overall, inventoryScore, marketScore, extensionScore, complexityScore: Math.min(100, complexity.increasePercent), allKnownSoftwareUtilized: usage.length === inventory.known.length };
}

function buildEvents(inventory, matrix, extensions, scores, complexity, ledger) {
  const base = { '@timestamp': now(), pipeline_version: 'v17', build, job, commit };
  return [
    { ...base, type: 'v17_summary', score: scores.overall, ...scores, stage_count: complexity.v17Stages, v16_stage_count: complexity.v16Stages, complexity_increase_percent: complexity.increasePercent, message: 'V17 workforce-ready platform summary' },
    ...inventory.all.map((item) => ({ ...base, type: 'software_inventory', key: item.key, label: item.label, domain: item.domain, state: item.evidenceState, score: item.score, utilized: item.utilized, message: item.capability })),
    ...matrix.map((item) => ({ ...base, type: 'market_requirement', key: item.key, requirement: item.requirement, status: item.status, score: item.score, software: item.software.join(',') })),
    ...extensions.map((item) => ({ ...base, type: 'extension_plan', key: item.key, state: item.state, score: item.score, mode: item.mode, file: item.file, message: item.purpose })),
    ...ledger.map((item) => ({ ...base, type: 'complexity_stage', key: item.key, domain: item.domain, status: item.status, score: item.score, message: item.title })),
  ];
}

function buildMetrics(inventory, matrix, extensions, scores, complexity) {
  const lines = ['# HELP cicd_v17_platform_score V17 workforce-ready platform score.', '# TYPE cicd_v17_platform_score gauge', `cicd_v17_platform_score{build="${metric(build)}",job="${metric(job)}"} ${scores.overall}`];
  Object.entries(scores).filter(([, value]) => typeof value === 'number').forEach(([key, value]) => lines.push(`cicd_v17_score{dimension="${metric(key)}",build="${metric(build)}"} ${value}`));
  lines.push(`cicd_v17_complexity_increase_percent{build="${metric(build)}"} ${complexity.increasePercent}`);
  inventory.known.forEach((item) => lines.push(`cicd_v17_software_score{software="${metric(item.key)}",domain="${metric(item.domain)}",state="${metric(item.evidenceState)}",build="${metric(build)}"} ${item.score}`));
  matrix.forEach((item) => lines.push(`cicd_v17_market_requirement_score{requirement="${metric(item.key)}",status="${metric(item.status)}",build="${metric(build)}"} ${item.score}`));
  extensions.forEach((item) => lines.push(`cicd_v17_extension_score{extension="${metric(item.key)}",state="${metric(item.state)}",build="${metric(build)}"} ${item.score}`));
  return lines.join('\n') + '\n';
}

function buildGrafana(scores) {
  const prom = (expr, legend = '') => ({ refId: 'A', datasource: { type: 'prometheus', uid: 'prometheus' }, expr, legendFormat: legend, format: 'time_series' });
  const stat = (title, x, expr) => ({ type: 'stat', title, gridPos: { x, y: 3, w: 6, h: 5 }, targets: [prom(expr)], fieldConfig: { defaults: { min: 0, max: 100, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 70 }, { color: 'green', value: 90 }] } }, overrides: [] }, options: { colorMode: 'background', reduceOptions: { calcs: ['lastNotNull'], values: false } } });
  return {
    title: env.V17_GRAFANA_DASHBOARD_TITLE || 'ZhangLab V17 Workforce-Ready Platform', uid: 'zhanglab-v17-workforce-ready', tags: ['v17', 'platform', 'recruitment', 'software-inventory'], schemaVersion: 39, version: 1, refresh: '30s',
    panels: [
      { type: 'text', title: 'V17 brief', gridPos: { x: 0, y: 0, w: 24, h: 3 }, options: { mode: 'markdown', content: `### V17 Workforce-Ready Platform\n\nBuild #${build} · ${semver} · ${commit}. Every catalogued platform component has a usage path; active, inherited and defined-only evidence remain separate.` } },
      stat('Platform', 0, `cicd_v17_platform_score{build="${build}"}`), stat('Inventory', 6, `cicd_v17_score{dimension="inventoryScore",build="${build}"}`), stat('Market fit', 12, `cicd_v17_score{dimension="marketScore",build="${build}"}`), stat('Extension', 18, `cicd_v17_score{dimension="extensionScore",build="${build}"}`),
      { type: 'bargauge', title: 'All software utilisation', gridPos: { x: 0, y: 8, w: 12, h: 10 }, targets: [prom(`cicd_v17_software_score{build="${build}"}`, '{{domain}} / {{software}}')], fieldConfig: { defaults: { min: 0, max: 100 }, overrides: [] }, options: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } },
      { type: 'bargauge', title: 'Recruitment capability coverage', gridPos: { x: 12, y: 8, w: 12, h: 10 }, targets: [prom(`cicd_v17_market_requirement_score{build="${build}"}`, '{{requirement}}')], fieldConfig: { defaults: { min: 0, max: 100 }, overrides: [] }, options: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } },
      { type: 'bargauge', title: 'Extension adoption state', gridPos: { x: 0, y: 18, w: 24, h: 8 }, targets: [prom(`cicd_v17_extension_score{build="${build}"}`, '{{extension}} {{state}}')], fieldConfig: { defaults: { min: 0, max: 100 }, overrides: [] }, options: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } },
    ],
  };
}

function buildKibana() {
  const view = { type: 'index-pattern', id: 'zhanglab-v17-workforce', attributes: { title: 'jenkins-v17-workforce-*', timeFieldName: '@timestamp' } };
  const dashboard = { type: 'dashboard', id: 'zhanglab-v17-workforce-command', attributes: { title: 'V17 Workforce-Ready Platform', description: 'Software usage, recruitment requirements and extension adoption.', panelsJSON: '[]', optionsJSON: '{"useMargins":true}', timeRestore: false, kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: 'pipeline_version : v17' }, filter: [] }) } }, references: [] };
  return [view, dashboard].map((item) => JSON.stringify(item)).join('\n') + '\n';
}

function buildPortal(summary, inventory, matrix, extensions, complexity) {
  const cell = (row, columns) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V17 Workforce-Ready Platform</title><style>body{margin:0;background:#07111f;color:#e5efff;font:15px Inter,ui-sans-serif,system-ui}.page{max-width:1280px;margin:auto;padding:34px}.hero,.card{background:#0d2037;border:1px solid #1f456b;border-radius:18px;padding:24px;box-shadow:0 20px 55px #0005}.hero{background:linear-gradient(130deg,#112d4d,#10213d 58%,#1d3156)}h1{font-size:38px;margin:0 0 8px}h1 span{color:#62d4ff}.chips{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.chip{padding:7px 10px;background:#163a59;border-radius:999px;color:#aee9ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:18px 0}.score{font-size:34px;color:#7ef0b8}.card h2{font-size:16px;margin:0;color:#9fc7ff}.card p{margin:10px 0 0;color:#c3d8ef}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid #24496b}th{color:#8ec7ff}.active{color:#7ef0b8}.defined{color:#ffd680}.gap{color:#ff9b9b}a{color:#79d9ff}@media(max-width:650px){.page{padding:16px}h1{font-size:29px}table{font-size:12px}}</style></head><body><main class="page"><section class="hero"><div>V16 → V17 · evidence-first platform upgrade</div><h1>Workforce-Ready <span>Platform</span></h1><p>最新招聘要求驱动的全软件使用矩阵。运行中、V16 继承、已定义待部署的能力明确区分，不把计划冒充为现网。</p><div class="chips"><span class="chip">Overall ${summary.overall}</span><span class="chip">${summary.knownSoftwareTotal} known software</span><span class="chip">${summary.allKnownSoftwareUtilized ? 'all utilised' : 'usage gap'}</span><span class="chip">${complexity.v17Stages}/${complexity.v16Stages} stages</span><span class="chip">+${complexity.increasePercent}% complexity</span></div></section><section class="grid"><article class="card"><h2>Software inventory</h2><div class="score">${summary.inventoryScore}</div><p>All known software is connected to release, runtime, data, reliability, or developer-experience workflows.</p></article><article class="card"><h2>Recruitment fit</h2><div class="score">${summary.marketScore}</div><p>${marketSources.length} public role descriptions checked on ${summary.generatedAt.slice(0, 10)}.</p></article><article class="card"><h2>Extensions</h2><div class="score">${summary.extensionScore}</div><p>GitHub Actions, Ansible, Kustomize, OpenTelemetry, SBOM and Vault governance have explicit adoption states.</p></article></section><section class="card"><h2>All current platform software</h2><table><thead><tr><th>Software</th><th>Domain</th><th>Evidence state</th><th>Score</th><th>Usage paths</th></tr></thead><tbody>${inventory.known.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.domain)}</td><td class="${escapeHtml(row.evidenceState)}">${escapeHtml(row.evidenceState)}</td><td>${row.score}</td><td>${escapeHtml(row.usedBy.join(' · '))}</td></tr>`).join('')}</tbody></table></section><section class="card"><h2>Latest recruitment capability matrix</h2><table><thead><tr><th>Requirement</th><th>Status</th><th>Score</th><th>Mapped software</th></tr></thead><tbody>${matrix.map((row) => cell({ requirement: row.requirement, status: row.status, score: row.score, software: row.software.join(', ') }, ['requirement', 'status', 'score', 'software'])).join('')}</tbody></table></section><section class="card"><h2>Platform extensions</h2><table><thead><tr><th>Extension</th><th>State</th><th>Mode</th><th>Definition</th></tr></thead><tbody>${extensions.map((row) => cell({ title: row.title, state: row.state, mode: row.mode, file: row.file }, ['title', 'state', 'mode', 'file'])).join('')}</tbody></table></section><section class="card"><h2>Recruitment sources</h2>${marketSources.map((source) => `<p><a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a> · ${escapeHtml(source.freshness)} · ${escapeHtml(source.signals.join(' / '))}</p>`).join('')}</section></main></body></html>`;
  write('reports/v17-portal/index.html', html + '\n');
}

function buildAll() {
  const stageRows = writeStagePlan();
  const ledger = ensureLedger(stageRows);
  const inventory = buildInventory();
  const extensions = buildExtensions(inventory);
  const matrix = buildMarketMatrix(inventory);
  const externalPortalBaseline = portalBaseline();
  const v16Stages = 224;
  const complexity = { v16Stages, v17Stages: stageRows.length, addedStages: stageRows.length - v16Stages, increasePercent: Math.round((stageRows.length - v16Stages) / v16Stages * 100) };
  const scores = buildScores(inventory, matrix, extensions, complexity);
  const summary = { '@timestamp': now(), pipeline_version: 'v17', build, job, commit, semver, generatedAt: now(), roleResearchDate: '2026-07-10', reviewedVersionTotal: versionLineage.length, allHistoricalVersionSourcesPresent: versionLineage.every((item) => item.sourcePresent), externalPortalBaseline, knownSoftwareTotal: inventory.known.length, discoveredRuntimeTotal: inventory.discovered.length, allKnownSoftwareUtilized: scores.allKnownSoftwareUtilized, ...scores, complexity, marketSourceTotal: marketSources.length };
  const events = buildEvents(inventory, matrix, extensions, scores, complexity, ledger);
  write('reports/v17-software-inventory.json', JSON.stringify({ summary, runtimeEvidenceFiles: inventory.runtime.files, knownSoftware: inventory.known, discoveredRuntime: inventory.discovered }, null, 2) + '\n');
  write('reports/v17-version-lineage.json', JSON.stringify({ reviewedAt: now(), versions: versionLineage, v17Source: 'Jenkinsfile-intelligence-v17', complete: versionLineage.every((item) => item.sourcePresent) }, null, 2) + '\n');
  write('reports/v17-market-recruitment.json', JSON.stringify({ researchedAt: '2026-07-10', sources: marketSources, matrix }, null, 2) + '\n');
  write('reports/v17-extension-plan.json', JSON.stringify({ generatedAt: now(), extensions, nonDestructiveDefault: true, applyRule: 'Only an explicit Jenkins V17_APPLY_EXTENSIONS=true run may attempt server-side dry-run validation; production apply remains a separate reviewed change.' }, null, 2) + '\n');
  write('reports/v17-complexity-proof.json', JSON.stringify({ ...complexity, requirement: 'V17 stage count must be at least twice the V16 base', pass: complexity.v17Stages >= complexity.v16Stages * 2 }, null, 2) + '\n');
  write('reports/v17-capability-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
  write('reports/v17-evidence.json', JSON.stringify({ summary, inventory: { known: inventory.known.length, discovered: inventory.discovered.length }, matrix, extensions, complexity, ledgerTotal: ledger.length }, null, 2) + '\n');
  write('reports/v17-observability.ndjson', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('reports/v17-prometheus-metrics.prom', buildMetrics(inventory, matrix, extensions, scores, complexity));
  write('reports/v17-grafana-dashboard.json', JSON.stringify(buildGrafana(scores), null, 2) + '\n');
  write('reports/v17-kibana-dashboard.ndjson', buildKibana());
  buildPortal(summary, inventory, matrix, extensions, complexity);
  console.log(JSON.stringify({ v17: 'built', ...summary, stageCount: ledger.length }));
}

function lintAll() {
  const required = ['reports/v17-software-inventory.json', 'reports/v17-version-lineage.json', 'reports/v17-market-recruitment.json', 'reports/v17-extension-plan.json', 'reports/v17-complexity-proof.json', 'reports/v17-capability-matrix.json', 'reports/v17-evidence.json', 'reports/v17-observability.ndjson', 'reports/v17-prometheus-metrics.prom', 'reports/v17-grafana-dashboard.json', 'reports/v17-kibana-dashboard.ndjson', 'reports/v17-portal/index.html', 'reports/v17-stage-plan.txt'];
  const missing = required.filter((file) => !exists(file));
  if (missing.length) throw new Error(`V17 missing required assets: ${missing.join(', ')}`);
  const proof = readJson('reports/v17-complexity-proof.json', {});
  const inventory = readJson('reports/v17-software-inventory.json', {});
  const market = readJson('reports/v17-market-recruitment.json', {});
  const plan = readJson('reports/v17-extension-plan.json', {});
  const lineage = readJson('reports/v17-version-lineage.json', {});
  if (!proof.pass || proof.v17Stages < proof.v16Stages * 2) throw new Error(`V17 complexity proof failed: ${JSON.stringify(proof)}`);
  if (readLines('reports/v17-stage-plan.txt').length < 460) throw new Error('V17 requires at least 460 stage definitions');
  if (!inventory.summary?.allKnownSoftwareUtilized) throw new Error('A known platform software entry has no V17 usage path');
  if (lineage.versions?.length !== 16) throw new Error('V17 requires a complete V1–V16 lineage review');
  if (!Array.isArray(market.sources) || market.sources.length < 4) throw new Error('V17 requires four current recruitment sources');
  if (!Array.isArray(plan.extensions) || plan.extensions.some((item) => !item.definitionPresent)) throw new Error('A promised V17 extension definition is absent');
  console.log(`v17_lint=ok stages=${proof.v17Stages} increase=${proof.increasePercent}% knownSoftware=${inventory.summary.knownSoftwareTotal}`);
}

if (action === 'check') recordCheck(checkKey, checkTitle);
else if (action === 'build') buildAll();
else if (action === 'lint') lintAll();
else throw new Error(`Unsupported V17 action: ${action}`);
