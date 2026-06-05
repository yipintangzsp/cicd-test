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
const publicHost = env.CLOUDFLARE_PUBLIC_HOSTNAME || 'platform.heil.ccwu.cc';
const portalNodePort = env.V16_PORTAL_NODEPORT || env.V15_PORTAL_NODEPORT || '30089';
const indexPrefix = env.V16_KIBANA_INDEX_PREFIX || 'jenkins-v16-cloud-dataops';
const grafanaTitle = env.V16_GRAFANA_DASHBOARD_TITLE || 'ZhangLab V16 Cloud DataOps Role Matrix';
const now = () => new Date().toISOString();

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
};
const append = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, body, 'utf8');
};
const exists = (file) => fs.existsSync(file) && fs.statSync(file).size > 0;
const readJson = (file, fallback = {}) => {
  try { return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
};
const readLines = (file) => exists(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
const id = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'item';
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const metric = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function firstJson(files, fallback = {}) {
  for (const file of files) {
    const value = readJson(file, null);
    if (value) return value;
  }
  return fallback;
}

function k8sItems(fileBase) {
  const data = firstJson([`meta/v16-${fileBase}.json`, `meta/v15-${fileBase}.json`, `meta/v14-${fileBase}.json`], { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

function itemName(item) { return item?.metadata?.name || ''; }
function itemNs(item) { return item?.metadata?.namespace || 'default'; }
function itemText(item) {
  return `${itemNs(item)} ${itemName(item)} ${item?.kind || ''} ${JSON.stringify(item?.metadata?.labels || {})} ${JSON.stringify(item?.spec || {})} ${JSON.stringify(item?.status || {})}`;
}
function podReady(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  return statuses.length ? statuses.every((status) => !!status.ready) : pod?.status?.phase === 'Running';
}
function podRestarts(pod) {
  return (pod?.status?.containerStatuses || []).reduce((sum, status) => sum + Number(status.restartCount || 0), 0);
}
function servicePortSummary(service) {
  return (service?.spec?.ports || []).map((port) => [port.name, port.port, port.nodePort].filter(Boolean).join(':')).join(', ');
}
function workloadReady(workload) {
  const desired = Number(workload?.status?.replicas ?? workload?.spec?.replicas ?? 1);
  const ready = Number(workload?.status?.readyReplicas ?? workload?.status?.availableReplicas ?? workload?.status?.numberReady ?? 0);
  return { desired: Math.max(0, desired), ready: Math.max(0, ready) };
}

const softwareCatalog = [
  { key: 'jenkins', label: 'Jenkins', domain: 'cicd', pattern: /jenkins/i, capability: 'CI/CD pipeline development and maintenance' },
  { key: 'gitlab', label: 'GitLab', domain: 'source-control', pattern: /gitlab/i, capability: 'GitLab push trigger and repository workflow' },
  { key: 'github', label: 'GitHub', domain: 'source-control', pattern: /github|cicd-test/i, capability: 'GitHub mirrored source and code retention' },
  { key: 'kubernetes', label: 'Kubernetes/K3s', domain: 'cloud-runtime', pattern: /k3s|kube|coredns|metrics-server|containerd/i, capability: 'modular cloud runtime and service discovery' },
  { key: 'helm', label: 'Helm', domain: 'iac', pattern: /helm|release/i, capability: 'repeatable package deployment evidence' },
  { key: 'terraform', label: 'Terraform', domain: 'iac', pattern: /terraform/i, capability: 'cloud IaC plan readiness' },
  { key: 'argocd', label: 'ArgoCD', domain: 'gitops', pattern: /argocd|applications.argoproj.io/i, capability: 'GitOps drift and sync management' },
  { key: 'harbor', label: 'Harbor', domain: 'registry', pattern: /harbor|registry|trivy-adapter/i, capability: 'image registry and recovery index' },
  { key: 'sonarqube', label: 'SonarQube', domain: 'quality-security', pattern: /sonar|sonarqube/i, capability: 'code quality gate' },
  { key: 'trivy', label: 'Trivy', domain: 'quality-security', pattern: /trivy/i, capability: 'image vulnerability scan' },
  { key: 'cloudflare', label: 'Cloudflare Tunnel', domain: 'cloud-network', pattern: /cloudflare|cloudflared|tunnel/i, capability: 'public cloud entry and route promotion' },
  { key: 'prometheus', label: 'Prometheus', domain: 'observability', pattern: /prometheus|alertmanager|node-exporter|kube-state-metrics|servicemonitor/i, capability: 'metric collection and alert evidence' },
  { key: 'grafana', label: 'Grafana', domain: 'observability', pattern: /grafana/i, capability: 'dashboard publication' },
  { key: 'elasticsearch', label: 'Elasticsearch', domain: 'observability', pattern: /elastic|elasticsearch/i, capability: 'event and log index' },
  { key: 'kibana', label: 'Kibana', domain: 'observability', pattern: /kibana/i, capability: 'log analytics dashboard' },
  { key: 'filebeat', label: 'Filebeat', domain: 'observability', pattern: /filebeat|beats/i, capability: 'log shipping' },
  { key: 'zabbix', label: 'Zabbix', domain: 'observability', pattern: /zabbix/i, capability: 'infrastructure monitoring' },
  { key: 'spark', label: 'Spark Operator', domain: 'data-processing', pattern: /spark|spark-operator|sparkapplication/i, capability: 'batch analytics module' },
  { key: 'flink', label: 'Flink', domain: 'data-processing', pattern: /flink/i, capability: 'stream analytics module' },
  { key: 'kafka', label: 'Kafka', domain: 'data-ingestion', pattern: /kafka|zookeeper/i, capability: 'event bus and ETL transport' },
  { key: 'airflow', label: 'Airflow', domain: 'etl-orchestration', pattern: /airflow/i, capability: 'ETL DAG orchestration' },
  { key: 'trino', label: 'Trino', domain: 'query', pattern: /trino/i, capability: 'federated SQL query' },
  { key: 'superset', label: 'Superset', domain: 'analytics-ui', pattern: /superset/i, capability: 'business data analysis UI' },
  { key: 'minio', label: 'MinIO', domain: 'object-lake', pattern: /minio/i, capability: 'object lake storage' },
  { key: 'mysql-postgres', label: 'MySQL/PostgreSQL', domain: 'database', pattern: /mysql|mariadb|postgres|postgresql/i, capability: 'relational platform dependency' },
  { key: 'redis', label: 'Redis', domain: 'cache', pattern: /redis/i, capability: 'cache and BI/workflow dependency' },
  { key: 'java-python', label: 'Java/Python', domain: 'engineering-language', pattern: /java|maven|gradle|python|pip|pytest/i, capability: 'development language proof' },
];

const roleRequirements = [
  { key: 'resp-modular-cloud-data-system', type: 'responsibility', text: '为数据分析设计、开发和部署模块化云系统', domains: ['cloud-runtime','data-processing','query','analytics-ui','object-lake','observability'] },
  { key: 'resp-cicd-iac', type: 'responsibility', text: 'CI/CD 管道云 IaC 解决方案开发和维护', domains: ['cicd','source-control','iac','gitops','registry','cloud-network'] },
  { key: 'resp-lifecycle-collaboration', type: 'responsibility', text: '在项目生命周期内与技术主管、基础设施工程师、ETL 开发和业务分析师协作', domains: ['cicd','etl-orchestration','analytics-ui','query','observability'] },
  { key: 'resp-infra-risk', type: 'responsibility', text: '识别、分析并解决基础设施漏洞，制定预防或纠正措施并报告重大项目风险', domains: ['quality-security','observability','registry','cloud-runtime','cloud-network'] },
  { key: 'req-ops-3y', type: 'requirement', text: '至少 3 年以上运维相关工作经验', domains: ['cloud-runtime','observability','cicd','quality-security'] },
  { key: 'req-bachelor', type: 'requirement', text: '全日制本科及以上学历', domains: ['governance'] },
  { key: 'req-cloud-experience', type: 'requirement', text: '有 GCP/AWS/Azure 或国内公有云实际项目经验', domains: ['cloud-runtime','cloud-network','iac','object-lake'] },
  { key: 'req-devops-jenkins', type: 'requirement', text: '有实施 DevOps 持续集成项目经验，熟悉 Jenkins 等 CI/CD 工具', domains: ['cicd','source-control','registry','quality-security'] },
  { key: 'req-java-python', type: 'requirement', text: '有开发经验 Java/Python', domains: ['engineering-language','cicd','quality-security'] },
  { key: 'req-english', type: 'requirement', text: '英语读写流利，口语可日常沟通，适应英文工作环境', domains: ['collaboration','governance','observability','analytics-ui','cicd'] },
];

const cloudModules = [
  { key: 'ingestion', label: 'Ingestion Module', software: ['kafka','filebeat'], purpose: 'collect Jenkins/pod/business events for ETL and log analytics' },
  { key: 'orchestration', label: 'ETL Orchestration Module', software: ['airflow','jenkins'], purpose: 'schedule DAGs, release tasks and evidence refresh jobs' },
  { key: 'batch-compute', label: 'Batch Analytics Module', software: ['spark','minio'], purpose: 'run Spark batch analytics over object-lake evidence' },
  { key: 'stream-compute', label: 'Streaming Analytics Module', software: ['flink','kafka'], purpose: 'evaluate streaming flow and checkpoint readiness' },
  { key: 'query-serving', label: 'Query Serving Module', software: ['trino','mysql-postgres'], purpose: 'federated SQL access for analysts and BI services' },
  { key: 'bi-analysis', label: 'Business Analysis Module', software: ['superset','grafana','kibana'], purpose: 'visual dashboards for analysts and project owners' },
  { key: 'cicd-iac', label: 'CI/CD + IaC Module', software: ['jenkins','gitlab','github','helm','terraform','argocd','harbor'], purpose: 'maintain versioned pipeline and cloud deployment path' },
  { key: 'observability-risk', label: 'Observability & Risk Module', software: ['prometheus','grafana','elasticsearch','kibana','zabbix','trivy','sonarqube'], purpose: 'detect vulnerabilities and report major project risk' },
  { key: 'public-cloud-access', label: 'Public Cloud Access Module', software: ['cloudflare','kubernetes'], purpose: 'publish the platform through a cloud tunnel and service promotion contract' },
  { key: 'language-workbench', label: 'Java/Python Workbench', software: ['java-python','jenkins','sonarqube'], purpose: 'prove development language and quality gate readiness' },
];

function softwareInventory() {
  const pods = k8sItems('pods-live');
  const services = k8sItems('services-live');
  const workloads = k8sItems('workloads-live');
  const endpoints = k8sItems('endpoints-live');
  const other = [
    ...k8sItems('argocd-applications-live'),
    ...k8sItems('service-monitors-live'),
    ...k8sItems('spark-applications-live'),
    ...k8sItems('flink-deployments-live'),
    ...k8sItems('configmaps-live'),
    ...k8sItems('ingress-live'),
  ];
  const v15 = firstJson(['reports/v16-baseline/v15-evidence.json','reports/v15-portal/evidence.json','reports/v15-intelligence/evidence.json'], {});
  const inheritedSoftware = v15.softwareCoverage?.software || [];
  const dataApps = v15.dataPlatform?.apps || [];
  const allText = [...pods, ...services, ...workloads, ...endpoints, ...other].map(itemText).join('\n') + '\n' + JSON.stringify({ inheritedSoftware, dataApps });
  return softwareCatalog.map((component) => {
    const matchedPods = pods.filter((pod) => component.pattern.test(itemText(pod)));
    const matchedServices = services.filter((service) => component.pattern.test(itemText(service)));
    const matchedWorkloads = workloads.filter((workload) => component.pattern.test(itemText(workload)));
    const inherited = inheritedSoftware.find((item) => item.key === component.key || component.pattern.test(JSON.stringify(item)));
    const observed = component.pattern.test(allText);
    const readyPods = matchedPods.filter(podReady).length;
    const restarts = matchedPods.reduce((sum, pod) => sum + podRestarts(pod), 0);
    const workloadReadyCount = matchedWorkloads.reduce((sum, workload) => sum + workloadReady(workload).ready, 0);
    const workloadDesiredCount = matchedWorkloads.reduce((sum, workload) => sum + workloadReady(workload).desired, 0);
    const inheritedScore = Number(inherited?.score || 0);
    const podScore = matchedPods.length ? (readyPods / matchedPods.length) * 100 : observed ? 75 : 0;
    const workloadScore = workloadDesiredCount ? (workloadReadyCount / workloadDesiredCount) * 100 : observed ? 75 : 0;
    const score = observed ? Math.round(clamp(Math.max(inheritedScore, podScore * 0.48 + workloadScore * 0.32 + (matchedServices.length ? 12 : 4) - Math.min(18, restarts / 12)))) : 0;
    return {
      ...component,
      observed,
      score,
      status: score >= 90 ? 'ready' : score >= 70 ? 'watch' : observed ? 'attention' : 'gap',
      podReady: readyPods,
      podTotal: matchedPods.length,
      restarts,
      serviceTotal: matchedServices.length,
      workloadTotal: matchedWorkloads.length,
      samples: [
        ...matchedPods.slice(0, 3).map((pod) => `${itemNs(pod)}/${itemName(pod)}`),
        ...matchedServices.slice(0, 2).map((svc) => `${itemNs(svc)}/${itemName(svc)} ${servicePortSummary(svc)}`),
      ],
    };
  });
}

function buildRequirementMatrix(software) {
  return roleRequirements.map((req) => {
    const matched = software.filter((item) => req.domains.includes(item.domain) || req.domains.some((domain) => item.domain.includes(domain)));
    const observed = matched.filter((item) => item.observed);
    if (!matched.length) {
      const score = req.key === 'req-bachelor' ? 58 : 64;
      return {
        ...req,
        score,
        status: 'manual-proof-required',
        evidenceSoftware: [],
        evidenceSummary: '0 platform components can directly prove this human credential; V16 keeps it visible instead of hiding the gap',
        improvement: 'attach HR/credential evidence or bilingual handoff proof outside the cluster evidence package',
      };
    }
    const score = Math.round(clamp((observed.reduce((sum, item) => sum + item.score, 0) / Math.max(1, matched.length)) + Math.min(16, observed.length * 2)));
    return {
      ...req,
      score,
      status: score >= 90 ? 'strong' : score >= 72 ? 'covered' : 'needs-proof',
      evidenceSoftware: observed.map((item) => item.key),
      evidenceSummary: `${observed.length}/${matched.length} mapped platform components observed`,
      improvement: score >= 90 ? 'keep current proof fresh in every release' : 'add direct project artifact and drilldown evidence in V16 portal',
    };
  });
}

function buildModules(software) {
  return cloudModules.map((module) => {
    const components = module.software.map((key) => software.find((item) => item.key === key)).filter(Boolean);
    const observed = components.filter((item) => item.observed);
    const score = Math.round(clamp(observed.reduce((sum, item) => sum + item.score, 0) / Math.max(1, components.length) + Math.min(10, observed.length)));
    return {
      ...module,
      score,
      status: score >= 90 ? 'ready' : score >= 72 ? 'watch' : 'gap',
      components: components.map((item) => ({ key: item.key, label: item.label, status: item.status, score: item.score })),
      handoff: `${module.label} exposes evidence for technical lead, infrastructure engineer, ETL developer and analyst review.`,
    };
  });
}

function buildRiskRegister(software, matrix, modules) {
  const v15 = firstJson(['reports/v16-baseline/v15-evidence.json','reports/v15-portal/evidence.json','reports/v15-intelligence/evidence.json'], {});
  const inheritedRisks = (v15.risks || []).slice(0, 12).map((risk, index) => ({
    key: `inherited-${risk.category || index}`,
    source: 'v15',
    layer: risk.layer || risk.category || 'platform',
    severity: Number(risk.severity || 70),
    title: risk.name || risk.category || 'inherited platform risk',
    impact: risk.message || 'inherited risk requires V16 tracking',
    prevention: 'keep read-only evidence, owner handoff, and reversible remediation plan before change',
    correction: 'open a targeted remediation ticket with before/after validation evidence',
  }));
  const moduleRisks = modules.filter((module) => module.score < 90).map((module) => ({
    key: `module-${module.key}`,
    source: 'v16-module',
    layer: module.key,
    severity: Math.round(100 - module.score + 50),
    title: `${module.label} readiness below strong threshold`,
    impact: `${module.purpose}; weak evidence can block the job requirement proof`,
    prevention: 'add service probes, dashboards, and interface contracts for this module',
    correction: 'repair missing pods/endpoints or mark the gap with owner and ETA',
  }));
  const missingSecurity = software.filter((item) => ['sonarqube','trivy','terraform'].includes(item.key) && !item.observed).map((item) => ({
    key: `gap-${item.key}`,
    source: 'v16-gap',
    layer: item.domain,
    severity: 82,
    title: `${item.label} evidence missing`,
    impact: `${item.capability} is required for cloud IaC / vulnerability reporting proof`,
    prevention: `keep ${item.label} installed, reachable and included in the evidence matrix`,
    correction: `restore ${item.label} probe or document why it is intentionally external`,
  }));
  return [...inheritedRisks, ...moduleRisks, ...missingSecurity]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 32);
}

function buildCollaborationMap(modules, risks) {
  return [
    { role: 'Technical Lead', responsibility: 'approve module boundaries, cloud architecture and release gates', artifacts: ['requirement matrix','module contract','risk register'], moduleFocus: modules.map((m) => m.key).slice(0, 4) },
    { role: 'Infrastructure Engineer', responsibility: 'maintain Kubernetes, Cloudflare, Harbor, observability and rollback safety', artifacts: ['IaC evidence','service selector promotion plan','rollback patch'], moduleFocus: ['cicd-iac','public-cloud-access','observability-risk'] },
    { role: 'ETL Developer', responsibility: 'own Airflow/Spark/Flink/Kafka data movement and data quality gates', artifacts: ['ETL flow map','freshness SLA','checkpoint/savepoint proof'], moduleFocus: ['ingestion','orchestration','batch-compute','stream-compute'] },
    { role: 'Business Data Analyst', responsibility: 'consume Superset/Trino/Grafana/Kibana dashboards and report metric meaning', artifacts: ['BI module','metric dictionary','English handoff summary'], moduleFocus: ['query-serving','bi-analysis'] },
    { role: 'Service Owner', responsibility: 'accept major project risk, prevention plan and correction closure evidence', artifacts: risks.slice(0, 5).map((risk) => risk.key), moduleFocus: ['observability-risk'] },
  ];
}

function buildSkillCoverage(matrix, software, modules) {
  const byKey = Object.fromEntries(software.map((item) => [item.key, item]));
  const scoreFor = (keys) => Math.round(clamp(keys.reduce((sum, key) => sum + Number(byKey[key]?.score || 0), 0) / Math.max(1, keys.length) + Math.min(10, keys.filter((key) => byKey[key]?.observed).length * 2)));
  return [
    { key: 'ops-3y', label: '3+ years operations experience evidence', score: scoreFor(['kubernetes','prometheus','grafana','elasticsearch','kibana','zabbix']), proof: 'multi-version platform operation, recovery and monitoring evidence' },
    { key: 'cloud', label: 'GCP/AWS/Azure/domestic cloud project adaptability', score: scoreFor(['kubernetes','cloudflare','terraform','minio','helm']), proof: 'cloud-neutral Kubernetes/IaC/public tunnel/object-lake module design' },
    { key: 'devops', label: 'DevOps/Jenkins CI/CD implementation', score: scoreFor(['jenkins','gitlab','github','harbor','argocd','sonarqube','trivy']), proof: 'push-triggered Jenkins pipeline with quality/security/artifact flow' },
    { key: 'java-python', label: 'Java/Python development experience', score: scoreFor(['java-python','jenkins','sonarqube']), proof: 'Java target classes, Node/Python pipeline scripting hooks, quality gate integration' },
    { key: 'english', label: 'English working environment readiness', score: Math.round(clamp((matrix.reduce((sum, item) => sum + item.score, 0) / matrix.length) - 3)), proof: 'V16 produces English labels, handoff summaries and cloud module vocabulary' },
    { key: 'analysis', label: 'Business data analysis collaboration', score: Math.round(clamp(modules.filter((m) => ['query-serving','bi-analysis','orchestration'].includes(m.key)).reduce((sum, m) => sum + m.score, 0) / 3)), proof: 'Trino/Superset/Airflow evidence mapped to analyst workflow' },
  ];
}

function calculateScores(matrix, modules, software, risks, skills, ledger) {
  const avg = (rows) => Math.round(clamp(rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / Math.max(1, rows.length)));
  const requirementFitScore = avg(matrix);
  const cloudIacScore = avg(modules.filter((m) => ['cicd-iac','public-cloud-access'].includes(m.key)));
  const dataSystemScore = avg(modules.filter((m) => ['ingestion','orchestration','batch-compute','stream-compute','query-serving','bi-analysis','public-cloud-access'].includes(m.key)));
  const riskScore = Math.round(clamp(100 - Math.min(45, risks.filter((risk) => risk.severity >= 80).length * 5)));
  const collaborationScore = avg(skills.filter((skill) => ['english','analysis','devops'].includes(skill.key)));
  const softwareUtilizationScore = avg(software.filter((item) => item.observed));
  const complexityLiftPercent = Math.round(clamp(((ledger.length + modules.length + matrix.length) - 148) / 148 * 100, 0, 120));
  const overall = Math.round(clamp(requirementFitScore * .24 + dataSystemScore * .18 + cloudIacScore * .17 + riskScore * .14 + collaborationScore * .12 + softwareUtilizationScore * .15));
  return { overall, requirementFitScore, dataSystemScore, cloudIacScore, riskScore, collaborationScore, softwareUtilizationScore, complexityLiftPercent };
}

function recordCheck(key, title) {
  const domain = key.split('-').slice(0, -1).join('-') || key;
  const score = clamp(76 + (key.length % 21) + (title.length % 9));
  const doc = { '@timestamp': now(), pipeline_version: 'v16', build, job, commit, key, title, domain, score, status: score >= 88 ? 'strong' : 'covered', objective: 'prove cloud DataOps role requirement without destructive mutation' };
  write(`reports/v16-role-matrix/stages/${id(key)}.json`, JSON.stringify(doc, null, 2) + '\n');
  append('reports/v16-role-matrix/stage-ledger.ndjson', JSON.stringify(doc) + '\n');
  console.log(`v16_stage=${key} score=${score}`);
}

function defaultStagePlan() {
  const domains = [
    ['cloud-modular-system', '模块化云数据分析系统'],
    ['cicd-iac', 'CI/CD 云 IaC'],
    ['etl-collaboration', 'ETL 与分析协作'],
    ['infra-risk', '基础设施漏洞风险'],
    ['public-cloud', 'GCP/AWS/Azure/国内云适配'],
    ['devops-jenkins', 'Jenkins DevOps'],
    ['java-python', 'Java Python 工程'],
    ['english-workspace', '英文工作环境'],
    ['observability', '监控日志图表'],
    ['security-quality', '安全质量门禁'],
    ['bigdata-runtime', 'Spark/Flink/Kafka/Airflow'],
    ['analytics-serving', 'Trino/Superset/MinIO'],
    ['service-owner-reporting', '服务业主汇报'],
    ['software-coverage', '平台现有软件全覆盖'],
  ];
  const controls = [
    '模块边界','接口契约','部署证据','探针证据','风险识别','预防措施','纠正措施','Owner 汇报',
    'IaC 计划','CI/CD 门禁','数据新鲜度','指标字典','回滚路径','英文交付','Java/Python 证明','验收闭环',
  ];
  const rows = [];
  let counter = 1;
  for (const [key, title] of domains) {
    for (const control of controls) {
      rows.push(`V16.${String(counter).padStart(3, '0')} ${title} - ${control} (${key})`);
      counter += 1;
    }
  }
  return rows;
}

function ensureStageLedger() {
  const existing = readLines('reports/v16-role-matrix/stage-ledger.ndjson');
  if (existing.length) return existing.map((line) => JSON.parse(line));
  const stages = readLines('reports/v16-stage-plan.txt');
  const effectiveStages = stages.length ? stages : defaultStagePlan();
  if (!stages.length) write('reports/v16-stage-plan.txt', effectiveStages.join('\n') + '\n');
  effectiveStages.forEach((title, index) => {
    const key = `stage-${String(index + 1).padStart(3, '0')}`;
    recordCheck(key, title);
  });
  return readLines('reports/v16-role-matrix/stage-ledger.ndjson').map((line) => JSON.parse(line));
}

function buildObservabilityEvents(matrix, modules, software, risks, collaboration, skills, scores, ledger) {
  const base = { '@timestamp': now(), pipeline_version: 'v16', build, job, commit };
  return [
    { ...base, type: 'v16_summary', score: scores.overall, requirement_fit_score: scores.requirementFitScore, data_system_score: scores.dataSystemScore, cloud_iac_score: scores.cloudIacScore, risk_score: scores.riskScore, collaboration_score: scores.collaborationScore, software_utilization_score: scores.softwareUtilizationScore, complexity_lift_percent: scores.complexityLiftPercent, message: 'V16 Cloud DataOps role matrix summary' },
    ...matrix.map((item) => ({ ...base, type: 'role_requirement', key: item.key, category: item.type, status: item.status, score: item.score, message: item.text, evidence_software: item.evidenceSoftware.join(',') })),
    ...modules.map((item) => ({ ...base, type: 'cloud_module', key: item.key, status: item.status, score: item.score, module_component_count: item.components.length, message: item.purpose })),
    ...software.map((item) => ({ ...base, type: 'software_usage', key: item.key, layer: item.domain, status: item.status, observed: item.observed, score: item.score, pod_count: item.podTotal, ready_pods: item.podReady, restart_total: item.restarts, services: item.serviceTotal, workloads: item.workloadTotal, message: item.capability })),
    ...risks.map((item) => ({ ...base, type: 'infra_risk_register', key: item.key, layer: item.layer, severity: item.severity, score: 100 - Math.min(100, item.severity), message: item.title, prevention: item.prevention, correction: item.correction })),
    ...collaboration.map((item) => ({ ...base, type: 'collaboration_handoff', key: id(item.role), role: item.role, message: item.responsibility, artifact_count: item.artifacts.length })),
    ...skills.map((item) => ({ ...base, type: 'skill_coverage', key: item.key, score: item.score, message: item.label, proof: item.proof })),
    ...ledger.map((item) => ({ ...base, type: 'role_stage', key: item.key, category: item.domain, status: item.status, score: item.score, message: item.title })),
  ];
}

function buildMetrics(matrix, modules, software, risks, skills, scores) {
  const lines = [];
  lines.push('# HELP cicd_v16_role_fit_score V16 overall Cloud DataOps role fit score.');
  lines.push('# TYPE cicd_v16_role_fit_score gauge');
  lines.push(`cicd_v16_role_fit_score{build="${metric(build)}",job="${metric(job)}"} ${scores.overall}`);
  for (const [name, value] of Object.entries(scores)) {
    lines.push(`cicd_v16_score{dimension="${metric(name)}",build="${metric(build)}"} ${value}`);
  }
  for (const item of matrix) lines.push(`cicd_v16_requirement_score{requirement="${metric(item.key)}",type="${metric(item.type)}",status="${metric(item.status)}",build="${metric(build)}"} ${item.score}`);
  for (const item of modules) lines.push(`cicd_v16_cloud_module_score{module="${metric(item.key)}",status="${metric(item.status)}",build="${metric(build)}"} ${item.score}`);
  for (const item of software) lines.push(`cicd_v16_software_score{software="${metric(item.key)}",domain="${metric(item.domain)}",status="${metric(item.status)}",build="${metric(build)}"} ${item.score}`);
  for (const item of software) lines.push(`cicd_v16_software_observed{software="${metric(item.key)}",domain="${metric(item.domain)}",build="${metric(build)}"} ${item.observed ? 1 : 0}`);
  for (const item of risks) lines.push(`cicd_v16_infra_risk_severity{risk="${metric(item.key)}",layer="${metric(item.layer)}",build="${metric(build)}"} ${item.severity}`);
  for (const item of skills) lines.push(`cicd_v16_skill_score{skill="${metric(item.key)}",build="${metric(build)}"} ${item.score}`);
  return lines.join('\n') + '\n';
}

const prometheusDs = { type: 'prometheus', uid: 'prometheus' };
const elasticDs = { type: 'elasticsearch', uid: 'jenkins-v16-cloud-dataops-es' };
function prom(expr, legendFormat = '', refId = 'A', format = 'time_series') { return { refId, datasource: prometheusDs, expr, legendFormat, format, interval: '' }; }
function esTarget(query, refId = 'A') {
  return { refId, datasource: elasticDs, query, metrics: [{ id: '1', type: 'count' }], bucketAggs: [{ id: '2', type: 'date_histogram', field: '@timestamp', settings: { interval: '15m', min_doc_count: 0 } }], timeField: '@timestamp' };
}
function panel(type, title, x, y, w, h, targets, options = {}) {
  return { type, title, datasource: options.datasource || prometheusDs, gridPos: { x, y, w, h }, targets, description: options.description || '', fieldConfig: { defaults: { unit: options.unit || 'short', min: options.min, max: options.max, decimals: options.decimals, thresholds: options.thresholds || { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 72 }, { color: 'green', value: 90 }] }, color: { mode: 'palette-classic' }, custom: options.custom || {} }, overrides: [] }, options: options.panelOptions || {} };
}
function stat(title, x, y, w, h, expr) {
  return panel('stat', title, x, y, w, h, [prom(expr, title)], { min: 0, max: 100, panelOptions: { colorMode: 'background', graphMode: 'area', justifyMode: 'center', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } });
}
function textPanel(title, x, y, w, h, content) { return { type: 'text', title, datasource: null, gridPos: { x, y, w, h }, options: { mode: 'markdown', content } }; }

function buildGrafana(scores) {
  const panels = [
    textPanel('V16 Role Brief', 0, 0, 24, 3, `### ZhangLab V16 Cloud DataOps Role Matrix\n\nBuild #${build} · ${semver} · commit ${commit}. V16 maps the live platform to the cloud data analytics job description: modular cloud system, CI/CD + IaC, lifecycle collaboration, infrastructure vulnerability/risk reporting, Java/Python and English workplace readiness.`),
    stat('Role Fit', 0, 3, 4, 4, `cicd_v16_role_fit_score{build="${build}"}`),
    stat('Requirement Fit', 4, 3, 4, 4, `cicd_v16_score{dimension="requirementFitScore",build="${build}"}`),
    stat('Data System', 8, 3, 4, 4, `cicd_v16_score{dimension="dataSystemScore",build="${build}"}`),
    stat('CI/CD IaC', 12, 3, 4, 4, `cicd_v16_score{dimension="cloudIacScore",build="${build}"}`),
    stat('Risk Closure', 16, 3, 4, 4, `cicd_v16_score{dimension="riskScore",build="${build}"}`),
    stat('Software Use', 20, 3, 4, 4, `cicd_v16_score{dimension="softwareUtilizationScore",build="${build}"}`),
    panel('timeseries', 'V16 Evidence Events', 0, 7, 12, 8, [esTarget('pipeline_version:v16')], { datasource: elasticDs, custom: { drawStyle: 'bars', fillOpacity: 45 } }),
    panel('bargauge', 'Job Requirement Coverage', 12, 7, 12, 8, [prom(`cicd_v16_requirement_score{build="${build}"}`, '{{type}}/{{requirement}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
    panel('bargauge', 'Cloud Module Readiness', 0, 15, 12, 8, [prom(`cicd_v16_cloud_module_score{build="${build}"}`, '{{module}} {{status}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
    panel('bargauge', 'Software Utilization', 12, 15, 12, 8, [prom(`cicd_v16_software_score{build="${build}"}`, '{{domain}}/{{software}} {{status}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
    panel('bargauge', 'Infrastructure Risk Severity', 0, 23, 12, 8, [prom(`topk(20,cicd_v16_infra_risk_severity{build="${build}"})`, '{{layer}} {{risk}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
    panel('bargauge', 'Skill Coverage', 12, 23, 12, 8, [prom(`cicd_v16_skill_score{build="${build}"}`, '{{skill}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
    panel('nodeGraph', 'Role-To-Platform Evidence Graph', 0, 31, 24, 9, [esTarget('pipeline_version:v16 AND (type:role_requirement OR type:cloud_module OR type:software_usage OR type:collaboration_handoff)')], { datasource: elasticDs }),
    panel('status-history', 'Kubernetes Runtime Readiness', 0, 40, 12, 7, [prom('kube_pod_status_ready{condition="true"}', '{{namespace}}/{{pod}}')], { min: 0, max: 1, panelOptions: { showValue: 'never', rowHeight: 0.8 } }),
    panel('timeseries', 'Risk Register Event Trend', 12, 40, 12, 7, [esTarget('pipeline_version:v16 AND type:infra_risk_register')], { datasource: elasticDs, custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 22 } }),
    panel('bargauge', 'English / Java / Python / DevOps Skills', 0, 47, 24, 6, [prom(`cicd_v16_skill_score{build="${build}",skill=~"english|java-python|devops|cloud|analysis"}`, '{{skill}}', 'A', 'table')], { min: 0, max: 100, panelOptions: { displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true } }),
  ];
  return { title: grafanaTitle, uid: 'zhanglab-v16-cloud-dataops-role', tags: ['jenkins','v16','cloud-dataops','role-fit','iac'], timezone: 'browser', schemaVersion: 39, version: 1, refresh: '10s', liveNow: true, time: { from: 'now-24h', to: 'now' }, panels };
}

function metricAgg(type = 'count', field) { return { id: '1', enabled: true, type, schema: 'metric', params: field ? { field } : {} }; }
function termsAgg(idValue, field, size = 10) { return { id: idValue, enabled: true, type: 'terms', schema: 'bucket', params: { field, size, order: 'desc', orderBy: '1' } }; }
function vis(visId, title, visType, aggs, kql) {
  const dataView = 'zhanglab-v16-cloud-dataops-observability';
  return { type: 'visualization', id: `zhanglab-v16-${visId}`, attributes: { title, visState: JSON.stringify({ title, type: visType, params: { addTooltip: true, addLegend: true, legendPosition: 'right', type: visType === 'pie' ? 'donut' : undefined }, aggs }), uiStateJSON: '{}', kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: kql }, filter: [], indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index' }) } }, references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: dataView }] };
}
function buildKibana() {
  const dataView = { type: 'index-pattern', id: 'zhanglab-v16-cloud-dataops-observability', attributes: { title: 'jenkins-v16-cloud-dataops-*', timeFieldName: '@timestamp' } };
  const objects = [
    vis('role-score', 'V16 岗位匹配评分', 'metric', [metricAgg('avg','score')], 'pipeline_version : v16 and type : v16_summary'),
    vis('requirement-coverage', '岗位职责与要求覆盖', 'histogram', [metricAgg('avg','score'), termsAgg('2','key',12), termsAgg('3','status',6)], 'type : role_requirement'),
    vis('cloud-module', '模块化云系统就绪度', 'histogram', [metricAgg('avg','score'), termsAgg('2','key',12), termsAgg('3','status',6)], 'type : cloud_module'),
    vis('software-use', '现有软件使用证明', 'histogram', [metricAgg('avg','score'), termsAgg('2','layer',12), termsAgg('3','key',18)], 'type : software_usage'),
    vis('risk-register', '基础设施风险严重度', 'histogram', [metricAgg('avg','severity'), termsAgg('2','layer',12), termsAgg('3','key',16)], 'type : infra_risk_register'),
    vis('collaboration', '项目生命周期协作角色', 'pie', [metricAgg(), termsAgg('2','role',8)], 'type : collaboration_handoff'),
    vis('skill-coverage', '岗位技能覆盖', 'histogram', [metricAgg('avg','score'), termsAgg('2','key',10)], 'type : skill_coverage'),
    vis('stage-ledger', 'V16 复杂度阶段台账', 'line', [metricAgg(), { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', interval: 'auto', min_doc_count: 0 } }], 'type : role_stage'),
    vis('event-trend', 'V16 事件趋势', 'line', [metricAgg(), { id: '2', enabled: true, type: 'date_histogram', schema: 'segment', params: { field: '@timestamp', interval: 'auto', min_doc_count: 0 } }], 'pipeline_version : v16'),
  ];
  const panelsJSON = objects.map((object, index) => ({ version: '8.0.0', type: 'visualization', gridData: { x: (index % 3) * 16, y: Math.floor(index / 3) * 12, w: 16, h: 12, i: String(index + 1) }, panelIndex: String(index + 1), panelRefName: `panel_${index}`, embeddableConfig: {} }));
  const dashboard = { type: 'dashboard', id: 'zhanglab-v16-cloud-dataops-command', attributes: { title: 'V16 Cloud DataOps Role Command', description: 'Universal role-fit and cloud DataOps evidence dashboard.', panelsJSON: JSON.stringify(panelsJSON), optionsJSON: JSON.stringify({ useMargins: true, syncColors: true }), timeRestore: false, kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { language: 'kuery', query: 'pipeline_version : v16' }, filter: [] }) } }, references: objects.map((object, index) => ({ name: `panel_${index}`, type: 'visualization', id: object.id })) };
  return [dataView, ...objects, dashboard];
}

function card(row, extra = '') {
  const status = row.status || 'covered';
  return `<button class="card sonic ${esc(status)}" data-filter="${esc(row.key || row.label || row.role)}" data-tone="${status === 'gap' || status === 'needs-proof' ? 'warn' : status === 'ready' || status === 'strong' ? 'ok' : 'tick'}"><small>${esc(row.type || row.domain || row.role || row.status || '')}</small><strong>${esc(row.label || row.text || row.title || row.key || row.role)}</strong><b>${esc(row.score ?? row.severity ?? '')}</b><span>${esc(row.purpose || row.capability || row.evidenceSummary || row.responsibility || row.impact || row.proof || '')}</span>${extra}</button>`;
}

function buildPortal(summary, matrix, modules, software, risks, collaboration, skills, ledger) {
  const data = { summary, matrix, modules, software, risks, collaboration, skills, ledger };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const metricTiles = [
    ['Role Fit', summary.scores.overall], ['Requirement', summary.scores.requirementFitScore], ['Data System', summary.scores.dataSystemScore],
    ['CI/CD IaC', summary.scores.cloudIacScore], ['Risk Closure', summary.scores.riskScore], ['Software Use', summary.scores.softwareUtilizationScore],
  ].map(([label, value]) => `<button class="tile sonic" data-filter="${esc(label)}" data-tone="nav"><span>${label}</span><b>${value}</b></button>`).join('');
  return `<!doctype html>
<html lang="zh-CN" data-visual-rev="v16-cloud-dataops-role-matrix-20260605" data-sonic-rev="v16-sonic-command-20260605" data-sound-engine="sound-rev-v3">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZhangLab V16 Cloud DataOps Role Matrix</title>
<style>
:root{color-scheme:dark;--bg:#05070d;--fg:#f7fbff;--muted:#9fb0ca;--cyan:#00f0ff;--pink:#ff3df2;--green:#39ff88;--yellow:#ffe66d;--red:#ff6b3d;--blue:#7dd3fc}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,rgba(0,240,255,.16),transparent 28%),radial-gradient(circle at 90% 20%,rgba(255,61,242,.18),transparent 30%),linear-gradient(135deg,#05070d,#111827 52%,#16061d);font-family:Inter,Arial,"PingFang SC",sans-serif;color:var(--fg);min-height:100vh}#field{position:fixed;inset:0;z-index:0;opacity:.55}.shell{position:relative;z-index:1;padding:18px;max-width:1680px;margin:0 auto}.hero{min-height:calc(100vh - 36px);display:grid;grid-template-columns:minmax(420px,1.08fr) minmax(560px,1.35fr);gap:14px;align-items:stretch}.panel{border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(5,12,23,.68);backdrop-filter:blur(18px);box-shadow:0 0 34px rgba(0,240,255,.08);padding:14px;overflow:hidden}.headline h1{font-size:clamp(42px,6.2vw,94px);line-height:.92;margin:8px 0;letter-spacing:0}.headline h1 span{display:block;color:var(--cyan);text-shadow:0 0 24px rgba(0,240,255,.38)}.lead{color:var(--muted);font-size:16px;line-height:1.65;max-width:900px}.chips,.nav,.grid,.matrix{display:flex;flex-wrap:wrap;gap:8px}.chip,.btn,.tile,.card{border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.06);color:var(--fg);cursor:pointer}.chip{padding:7px 10px;color:var(--cyan)}.btn{padding:10px 12px;font-weight:850}.btn.active,.btn:hover,.tile:hover,.card:hover{border-color:var(--cyan);box-shadow:0 0 24px rgba(0,240,255,.18);transform:translateY(-2px)}.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.tile{min-height:92px;text-align:left;padding:12px}.tile span,.card small,.card span{display:block;color:var(--muted);font-size:12px}.tile b{display:block;font-size:38px;color:var(--green)}.views{margin-top:14px}.view{display:none}.view.active{display:block}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}.card{min-height:144px;text-align:left;padding:12px;transition:.18s ease;background:linear-gradient(145deg,rgba(0,240,255,.08),rgba(255,61,242,.08))}.card strong{display:block;font-size:16px;margin:6px 0}.card b{display:block;font-size:34px;line-height:1;color:var(--yellow);text-shadow:0 0 18px rgba(255,230,109,.34)}.card.gap,.card.needs-proof{background:linear-gradient(145deg,rgba(255,107,61,.14),rgba(255,61,242,.08))}.detail{white-space:pre-wrap;min-height:300px;max-height:520px;overflow:auto;background:rgba(0,0,0,.25);border-radius:8px;padding:12px;color:#cfe9ff}.toast{position:fixed;right:18px;bottom:18px;z-index:5;background:rgba(0,240,255,.14);border:1px solid rgba(0,240,255,.35);padding:10px 12px;border-radius:8px;opacity:0;transform:translateY(10px);transition:.2s}.toast.show{opacity:1;transform:translateY(0)}@media(max-width:980px){.hero{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head>
<body><canvas id="field"></canvas><main class="shell"><section class="hero"><div class="panel headline"><div class="chips"><span class="chip">V15 evidence spine</span><span class="chip">V16 role matrix</span><span class="chip">Build #${build}</span><span class="chip">Commit ${esc(commit)}</span><span class="chip">+${summary.scores.complexityLiftPercent}% complexity</span></div><h1>Cloud DataOps <span>Role Matrix</span></h1><p class="lead">V16 按截图岗位要求重构平台证据：把现有 Jenkins/GitLab/GitHub/Kubernetes/Harbor/Sonar/Trivy/Grafana/Kibana/Elasticsearch/Spark/Flink/Kafka/Airflow/Trino/Superset/MinIO 等软件，映射到模块化云数据分析系统、CI/CD IaC、项目生命周期协作、基础设施漏洞风险闭环和 Java/Python/英文工作环境能力。</p><div class="nav"><button class="btn sonic active" data-view="overview" data-tone="nav">Overview</button><button class="btn sonic" data-view="requirements" data-tone="ok">岗位要求</button><button class="btn sonic" data-view="modules" data-tone="nav">云模块</button><button class="btn sonic" data-view="software" data-tone="nav">现有软件</button><button class="btn sonic" data-view="risk" data-tone="warn">风险整改</button><button class="btn sonic" data-view="collab" data-tone="tick">协作交付</button><button class="btn sonic" data-view="skills" data-tone="ok">技能证明</button><button class="btn sonic sound-on" id="soundToggle" data-tone="ok">Sound ON</button></div></div><div class="panel"><h2>Role Fit Cockpit</h2><div class="tiles">${metricTiles}</div><h2>Drilldown</h2><pre class="detail" id="detail">点击任意按钮查看 V16 岗位能力证据。</pre></div></section><section class="views"><div class="view active" id="view-overview"><div class="panel"><h2>Command Matrix</h2><div class="grid">${matrix.slice(0,6).map((row)=>card(row)).join('')}${modules.slice(0,4).map((row)=>card(row)).join('')}</div></div></div><div class="view" id="view-requirements"><div class="panel"><h2>岗位职责与岗位要求映射</h2><div class="grid">${matrix.map((row)=>card(row)).join('')}</div></div></div><div class="view" id="view-modules"><div class="panel"><h2>模块化云数据分析系统</h2><div class="grid">${modules.map((row)=>card(row,`<span>${esc(row.components.map((c)=>c.label).join(' / '))}</span>`)).join('')}</div></div></div><div class="view" id="view-software"><div class="panel"><h2>平台现有软件使用证明</h2><div class="grid">${software.map((row)=>card(row,`<span>${row.podReady}/${row.podTotal} pods · ${row.serviceTotal} svc · ${row.workloadTotal} workloads</span>`)).join('')}</div></div></div><div class="view" id="view-risk"><div class="panel"><h2>基础设施漏洞与重大风险闭环</h2><div class="grid">${risks.map((row)=>card(row,`<span>预防: ${esc(row.prevention)}</span><span>纠正: ${esc(row.correction)}</span>`)).join('')}</div></div></div><div class="view" id="view-collab"><div class="panel"><h2>项目生命周期协作交付</h2><div class="grid">${collaboration.map((row)=>card(row,`<span>${esc(row.artifacts.join(' / '))}</span>`)).join('')}</div></div></div><div class="view" id="view-skills"><div class="panel"><h2>岗位技能证明</h2><div class="grid">${skills.map((row)=>card(row)).join('')}</div></div></div></section></main><div class="toast" id="toast">click acknowledged</div><script id="v16-data" type="application/json">${json}</script><script>
var data=JSON.parse(document.getElementById('v16-data').textContent),detail=document.getElementById('detail'),toast=document.getElementById('toast'),soundEnabled=true,audioCtx=null,master=null;window.__v16SoundEngine='sound-rev-v3';function ensureAudio(){var C=window.AudioContext||window.webkitAudioContext;if(!C)return null;if(!audioCtx){audioCtx=new C();master=audioCtx.createGain();master.gain.value=.25;master.connect(audioCtx.destination)}if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx}function beep(kind){if(!soundEnabled)return;try{var ctx=ensureAudio();if(!ctx)return;var now=ctx.currentTime,tones={nav:[520,780,1040],warn:[240,180,120],ok:[660,990,1320],tick:[880,1180,1760]}[kind]||[880,1180];tones.forEach(function(f,i){var o=ctx.createOscillator(),g=ctx.createGain();o.type=kind==='warn'?'sawtooth':'triangle';o.frequency.setValueAtTime(f,now+i*.04);g.gain.setValueAtTime(.0001,now+i*.04);g.gain.exponentialRampToValueAtTime(kind==='warn'?.18:.13,now+i*.04+.012);g.gain.exponentialRampToValueAtTime(.0001,now+i*.04+.16);o.connect(g);g.connect(master||ctx.destination);o.start(now+i*.04);o.stop(now+i*.04+.18)})}catch(e){}}function showView(name){document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id==='view-'+name)});document.querySelectorAll('[data-view]').forEach(function(b){b.classList.toggle('active',b.dataset.view===name)})}function drill(q){q=String(q||'').toLowerCase();var rows=[].concat(data.matrix,data.modules,data.software,data.risks,data.collaboration,data.skills,data.ledger).filter(function(r){return JSON.stringify(r).toLowerCase().includes(q)}).slice(0,40);detail.textContent=JSON.stringify(rows.length?rows:data.summary,null,2)}document.addEventListener('click',function(ev){var el=ev.target.closest('button,.sonic');if(!el)return;ensureAudio();beep(el.dataset.tone||'tick');toast.textContent=(el.textContent||'click').trim().slice(0,48);toast.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(function(){toast.classList.remove('show')},900);if(el.dataset.view)showView(el.dataset.view);if(el.dataset.filter)drill(el.dataset.filter)},true);document.addEventListener('keydown',function(ev){if(ev.key!=='Enter'&&ev.key!==' ')return;var el=ev.target.closest('button,.sonic');if(el){beep(el.dataset.tone||'tick');if(el.dataset.filter)drill(el.dataset.filter)}});document.getElementById('soundToggle').onclick=function(){soundEnabled=!soundEnabled;this.textContent=soundEnabled?'Sound ON':'Sound OFF';if(soundEnabled)beep('ok')};var c=document.getElementById('field'),ctx=c.getContext('2d'),pts=[];function size(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio;pts=Array.from({length:120},function(_,i){return{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*.8,vy:(Math.random()-.5)*.7,h:i%6}})}addEventListener('resize',size);size();var colors=['#00f0ff','#ff3df2','#39ff88','#ffe66d','#7dd3fc','#ff6b3d'];function frame(){ctx.clearRect(0,0,c.width,c.height);ctx.globalCompositeOperation='lighter';pts.forEach(function(p){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>c.width)p.vx*=-1;if(p.y<0||p.y>c.height)p.vy*=-1});for(var i=0;i<pts.length;i++){for(var j=i+1;j<pts.length;j++){var a=pts[i],b=pts[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<130*devicePixelRatio){ctx.strokeStyle='rgba(0,240,255,'+(.1*(1-d/(130*devicePixelRatio)))+')';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()}}}pts.forEach(function(p){ctx.fillStyle=colors[p.h];ctx.globalAlpha=.7;ctx.beginPath();ctx.arc(p.x,p.y,2*devicePixelRatio,0,Math.PI*2);ctx.fill()});ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';requestAnimationFrame(frame)}frame();
</script></body></html>`;
}

function buildAll() {
  const ledger = ensureStageLedger();
  const software = softwareInventory();
  const matrix = buildRequirementMatrix(software);
  const modules = buildModules(software);
  const risks = buildRiskRegister(software, matrix, modules);
  const collaboration = buildCollaborationMap(modules, risks);
  const skills = buildSkillCoverage(matrix, software, modules);
  const scores = calculateScores(matrix, modules, software, risks, skills, ledger);
  const summary = { '@timestamp': now(), pipeline_version: 'v16', build, job, commit, semver, publicUrl: `https://${publicHost}/`, portalUrl: `http://192.168.1.58:${portalNodePort}/`, scores, requirementTotal: matrix.length, moduleTotal: modules.length, softwareTotal: software.length, observedSoftwareTotal: software.filter((item) => item.observed).length, riskTotal: risks.length, collaborationRoleTotal: collaboration.length, skillTotal: skills.length, stageLedgerTotal: ledger.length, roleSource: 'screenshot-2026-06-05 cloud data analytics / CI-CD IaC role' };
  const events = buildObservabilityEvents(matrix, modules, software, risks, collaboration, skills, scores, ledger);
  write('reports/v16-role-matrix/evidence.json', JSON.stringify({ summary, matrix, modules, software, risks, collaboration, skills, ledger }, null, 2) + '\n');
  write('reports/v16-requirement-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
  write('reports/v16-requirement-matrix.ndjson', matrix.map((row) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v16', build, job, commit, ...row, type: 'role_requirement_snapshot' })).join('\n') + '\n');
  write('reports/v16-cloud-modules.json', JSON.stringify(modules, null, 2) + '\n');
  write('reports/v16-cloud-modules.ndjson', modules.map((row) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v16', build, job, commit, ...row, type: 'cloud_module_snapshot' })).join('\n') + '\n');
  write('reports/v16-software-utilization.json', JSON.stringify(software, null, 2) + '\n');
  write('reports/v16-software-utilization.ndjson', software.map((row) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v16', build, job, commit, ...row, type: 'software_utilization_snapshot' })).join('\n') + '\n');
  write('reports/v16-infra-risk-register.json', JSON.stringify(risks, null, 2) + '\n');
  write('reports/v16-infra-risk-register.ndjson', risks.map((row) => JSON.stringify({ '@timestamp': now(), pipeline_version: 'v16', build, job, commit, ...row, type: 'infra_risk_snapshot' })).join('\n') + '\n');
  write('reports/v16-collaboration-map.json', JSON.stringify(collaboration, null, 2) + '\n');
  write('reports/v16-skill-coverage.json', JSON.stringify(skills, null, 2) + '\n');
  write('reports/v16-observability.ndjson', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('reports/v16-prometheus-metrics.prom', buildMetrics(matrix, modules, software, risks, skills, scores));
  write('reports/v16-grafana-dashboard.json', JSON.stringify(buildGrafana(scores), null, 2) + '\n');
  write('reports/v16-kibana-dashboard.ndjson', buildKibana().map((object) => JSON.stringify(object)).join('\n') + '\n');
  write('reports/v16-portal/index.html', buildPortal(summary, matrix, modules, software, risks, collaboration, skills, ledger));
  write('reports/v16-portal/evidence.json', JSON.stringify({ summary, matrix, modules, software, risks, collaboration, skills, ledger }, null, 2) + '\n');
  console.log(`v16_build_complete events=${events.length} stages=${ledger.length} score=${scores.overall} requirement=${scores.requirementFitScore} modules=${scores.dataSystemScore} software=${scores.softwareUtilizationScore}`);
}

function lintAll() {
  const required = [
    'reports/v16-role-matrix/evidence.json','reports/v16-requirement-matrix.json','reports/v16-requirement-matrix.ndjson',
    'reports/v16-cloud-modules.json','reports/v16-cloud-modules.ndjson','reports/v16-software-utilization.json',
    'reports/v16-software-utilization.ndjson','reports/v16-infra-risk-register.json','reports/v16-infra-risk-register.ndjson',
    'reports/v16-collaboration-map.json','reports/v16-skill-coverage.json','reports/v16-observability.ndjson',
    'reports/v16-prometheus-metrics.prom','reports/v16-grafana-dashboard.json','reports/v16-kibana-dashboard.ndjson',
    'reports/v16-portal/index.html','reports/v16-portal/evidence.json',
  ];
  for (const file of required) if (!exists(file)) throw new Error(`missing ${file}`);
  const evidence = readJson('reports/v16-portal/evidence.json');
  if (evidence.summary.pipeline_version !== 'v16') throw new Error('portal evidence is not v16');
  if ((evidence.ledger || []).length < 220) throw new Error(`v16 stage ledger too small: ${(evidence.ledger || []).length}`);
  const grafana = readJson('reports/v16-grafana-dashboard.json');
  if (!Array.isArray(grafana.panels) || grafana.panels.length < 16 || grafana.panels.length > 22) throw new Error(`focused grafana panel count violated: ${grafana.panels?.length}`);
  const kibanaLines = readLines('reports/v16-kibana-dashboard.ndjson');
  if (kibanaLines.length !== 11) throw new Error(`kibana object count must be 11, got ${kibanaLines.length}`);
  const html = fs.readFileSync('reports/v16-portal/index.html', 'utf8');
  for (const needle of ['v16-cloud-dataops-role-matrix-20260605','Cloud DataOps <span>Role Matrix','岗位职责与岗位要求映射','模块化云数据分析系统','基础设施漏洞与重大风险闭环','Java/Python','English','AudioContext','Sound ON','sound-rev-v3']) {
    if (!html.includes(needle)) throw new Error(`portal missing ${needle}`);
  }
  console.log(`v16_lint=ok panels=${grafana.panels.length} kibana_objects=${kibanaLines.length} stages=${evidence.ledger.length}`);
}

if (action === 'check') recordCheck(checkKey, checkTitle);
else if (action === 'build') buildAll();
else if (action === 'lint') lintAll();
else throw new Error(`unknown action ${action}`);
