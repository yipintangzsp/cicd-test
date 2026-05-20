import json, os, time
from pathlib import Path

now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
build = os.environ.get('BUILD_NUMBER', 'unknown')
semver = os.environ.get('SEMVER', 'unknown')
commit = os.environ.get('GIT_COMMIT_ID', 'unknown')
job = os.environ.get('JOB_NAME', 'jenkins')
portal_node_port = os.environ.get('V10_PORTAL_NODEPORT', '30087')

pods = json.load(open('meta/k8s-pods.json')).get('items', [])
services = json.load(open('meta/k8s-services.json')).get('items', [])
workloads = json.load(open('meta/k8s-workloads.json')).get('items', [])
endpoint_slices = json.load(open('meta/k8s-endpointslices.json')).get('items', [])

def pod_ready(p):
    statuses = p.get('status', {}).get('containerStatuses', [])
    return bool(statuses) and all(c.get('ready') for c in statuses)

def restarts(p):
    return sum(c.get('restartCount', 0) for c in p.get('status', {}).get('containerStatuses', []))

def service_endpoint_count(ns, name):
    total = 0
    ready = 0
    for es in endpoint_slices:
        labels = es.get('metadata', {}).get('labels', {})
        if es.get('metadata', {}).get('namespace') != ns:
            continue
        if labels.get('kubernetes.io/service-name') != name:
            continue
        for ep in (es.get('endpoints') or []):
            total += 1
            if ep.get('conditions', {}).get('ready') is True:
                ready += 1
    return total, ready

pod_rows = []
for p in pods:
    ns = p['metadata']['namespace']
    name = p['metadata']['name']
    phase = p.get('status', {}).get('phase', 'Unknown')
    ready = pod_ready(p)
    pod_rows.append({
        'namespace': ns,
        'name': name,
        'phase': phase,
        'ready': ready,
        'restarts': restarts(p),
        'podIP': p.get('status', {}).get('podIP', ''),
        'node': p.get('spec', {}).get('nodeName', ''),
    })

svc_rows = []
for s in services:
    ns = s['metadata']['namespace']
    name = s['metadata']['name']
    total, ready = service_endpoint_count(ns, name)
    ports = []
    for port in s.get('spec', {}).get('ports', []):
        item = str(port.get('port', ''))
        if port.get('nodePort'):
            item += ':' + str(port['nodePort'])
        if item:
            ports.append(item)
    svc_rows.append({
        'namespace': ns,
        'name': name,
        'type': s.get('spec', {}).get('type', 'ClusterIP'),
        'clusterIP': s.get('spec', {}).get('clusterIP', ''),
        'ports': ','.join(ports),
        'endpointTotal': total,
        'endpointReady': ready,
    })

wl_rows = []
for w in workloads:
    kind = w.get('kind', '')
    status = w.get('status', {})
    wl_rows.append({
        'namespace': w['metadata']['namespace'],
        'kind': kind,
        'name': w['metadata']['name'],
        'desired': status.get('replicas') or status.get('desiredNumberScheduled') or 0,
        'ready': status.get('readyReplicas') or status.get('numberReady') or 0,
    })

summary = {
    'timestamp': now,
    'job': job,
    'build': build,
    'semver': semver,
    'commit': commit,
    'podTotal': len(pod_rows),
    'podReady': sum(1 for p in pod_rows if p['ready']),
    'podNotReady': [p for p in pod_rows if not p['ready'] and p['phase'] != 'Succeeded'],
    'serviceTotal': len(svc_rows),
    'workloadTotal': len(wl_rows),
    'portalUrl': f'http://192.168.1.58:{portal_node_port}/',
}

evidence = {'summary': summary, 'pods': pod_rows, 'services': svc_rows, 'workloads': wl_rows}
Path('reports/v10-platform-services.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')

with open('reports/v10-observability.ndjson', 'w', encoding='utf-8') as f:
    for row in pod_rows:
        f.write(json.dumps({'@timestamp': now, 'type': 'pod', 'pipeline_version': 'v10', 'build': build, **row}, ensure_ascii=False) + '\n')
    for row in svc_rows:
        status = 'ready' if row['endpointReady'] > 0 or row['type'] == 'ExternalName' else 'no_endpoint'
        f.write(json.dumps({'@timestamp': now, 'type': 'service', 'pipeline_version': 'v10', 'build': build, 'status': status, **row}, ensure_ascii=False) + '\n')

with open('reports/v10-prometheus-metrics.prom', 'w', encoding='utf-8') as f:
    f.write('# HELP cicd_v10_pod_ready Kubernetes pod readiness captured by Jenkins v10.\n')
    f.write('# TYPE cicd_v10_pod_ready gauge\n')
    for row in pod_rows:
        val = 1 if row['ready'] else 0
        f.write(f'cicd_v10_pod_ready{{namespace="{row["namespace"]}",pod="{row["name"]}",build="{build}"}} {val}\n')
    f.write('# HELP cicd_v10_service_endpoint_ready Ready endpoints captured by Jenkins v10.\n')
    f.write('# TYPE cicd_v10_service_endpoint_ready gauge\n')
    for row in svc_rows:
        f.write(f'cicd_v10_service_endpoint_ready{{namespace="{row["namespace"]}",service="{row["name"]}",build="{build}"}} {row["endpointReady"]}\n')

grafana = {
    'title': 'Jenkins V10 Platform Evidence',
    'tags': ['jenkins', 'v10', 'platform'],
    'timezone': 'browser',
    'schemaVersion': 39,
    'version': 1,
    'refresh': '30s',
    'panels': [
        {'type': 'stat', 'title': 'Ready Pods', 'gridPos': {'x': 0, 'y': 0, 'w': 6, 'h': 4}, 'targets': [{'expr': 'sum(cicd_v10_pod_ready)'}]},
        {'type': 'stat', 'title': 'Service Ready Endpoints', 'gridPos': {'x': 6, 'y': 0, 'w': 6, 'h': 4}, 'targets': [{'expr': 'sum(cicd_v10_service_endpoint_ready)'}]},
        {'type': 'timeseries', 'title': 'Pod Readiness By Namespace', 'gridPos': {'x': 0, 'y': 4, 'w': 12, 'h': 8}, 'targets': [{'expr': 'sum by(namespace) (cicd_v10_pod_ready)'}]},
    ],
}
Path('reports/v10-grafana-dashboard.json').write_text(json.dumps(grafana, ensure_ascii=False, indent=2), encoding='utf-8')

kibana_dashboard = {
    'type': 'dashboard',
    'id': 'jenkins-v10-platform-evidence',
    'attributes': {
        'title': 'Jenkins V10 Platform Evidence',
        'description': 'Import reports/v10-observability.ndjson into Elasticsearch, then use this dashboard as a base.',
        'panelsJSON': '[]',
        'optionsJSON': '{"useMargins":true,"syncColors":false,"hidePanelTitles":false}',
        'version': 1,
        'timeRestore': False,
        'kibanaSavedObjectMeta': {'searchSourceJSON': '{"query":{"language":"kuery","query":"pipeline_version : v10"},"filter":[]}'},
    },
}
Path('reports/v10-kibana-dashboard.ndjson').write_text(json.dumps(kibana_dashboard, ensure_ascii=False) + '\n', encoding='utf-8')

top_pods = sorted(pod_rows, key=lambda p: (not p['ready'], p['namespace'], p['name']))
cards = ''.join(
    f'<tr><td>{p["namespace"]}</td><td>{p["name"]}</td><td>{p["phase"]}</td><td>{"READY" if p["ready"] else "CHECK"}</td><td>{p["restarts"]}</td></tr>'
    for p in top_pods
)
html = f'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Jenkins V10 Platform Evidence</title>
  <style>
    body {{ margin:0; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f7f9fc; color:#172033; }}
    header {{ background:#f38020; color:white; padding:28px 36px; }}
    main {{ padding:28px 36px; }}
    .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:22px; }}
    .card {{ background:white; border:1px solid #dde5ef; border-radius:8px; padding:16px; box-shadow:0 1px 2px rgba(20,30,50,.04); }}
    .num {{ font-size:30px; font-weight:700; }}
    table {{ width:100%; border-collapse:collapse; background:white; border:1px solid #dde5ef; border-radius:8px; overflow:hidden; }}
    th,td {{ padding:10px 12px; border-bottom:1px solid #edf1f7; text-align:left; font-size:13px; }}
    th {{ background:#eef4fb; }}
    code {{ background:#fff3e8; padding:2px 5px; border-radius:4px; }}
  </style>
</head>
<body>
  <header>
    <h1>Jenkins V10 Platform Evidence</h1>
    <p>Build #{build} · v{semver} · commit {commit} · Cloudflare-ready preview</p>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="num">{summary["podReady"]}/{summary["podTotal"]}</div><div>Pods Ready</div></div>
      <div class="card"><div class="num">{summary["serviceTotal"]}</div><div>Services Covered</div></div>
      <div class="card"><div class="num">{summary["workloadTotal"]}</div><div>Workloads Covered</div></div>
      <div class="card"><div class="num">{len(summary["podNotReady"])}</div><div>Pods Need Attention</div></div>
    </section>
    <section class="card">
      <h2>成果入口</h2>
      <p>内部访问地址：<code>{summary["portalUrl"]}</code></p>
      <p>日志与图表素材：<code>v10-observability.ndjson</code>、<code>v10-prometheus-metrics.prom</code>、<code>v10-grafana-dashboard.json</code>、<code>v10-kibana-dashboard.ndjson</code></p>
    </section>
    <h2>Pod Evidence Matrix</h2>
    <table><thead><tr><th>Namespace</th><th>Pod</th><th>Phase</th><th>Ready</th><th>Restarts</th></tr></thead><tbody>{cards}</tbody></table>
  </main>
</body>
</html>'''
Path('reports/v10-portal/index.html').write_text(html, encoding='utf-8')
Path('reports/v10-portal/evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
