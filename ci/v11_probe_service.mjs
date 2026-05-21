#!/usr/bin/env node

import fs from 'fs';
import http from 'http';
import https from 'https';

const specPath = process.argv[2];
if (!specPath) {
  throw new Error('usage: node ci/v11_probe_service.mjs <spec.json>');
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const outPath = spec.outPath;
const ndjsonPath = 'reports/v11-service-probes.ndjson';

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function kindName(kind) {
  const normalized = String(kind || '').toLowerCase();
  if (['deploy', 'deployment', 'deployments'].includes(normalized)) return 'Deployment';
  if (['statefulset', 'statefulsets', 'sts'].includes(normalized)) return 'StatefulSet';
  if (['daemonset', 'daemonsets', 'ds'].includes(normalized)) return 'DaemonSet';
  if (['service', 'services', 'svc'].includes(normalized)) return 'Service';
  return kind;
}

function findK8sObject(namespace, kind, name) {
  const wantedKind = kindName(kind);
  const workloadItems = readJson('meta/k8s-workloads.json', { items: [] }).items || [];
  const serviceItems = readJson('meta/k8s-services.json', { items: [] }).items || [];
  return [...workloadItems, ...serviceItems].find((item) => (
    item?.kind === wantedKind &&
    item?.metadata?.namespace === namespace &&
    item?.metadata?.name === name
  ));
}

function replicaStatus(item) {
  if (!item) return { ready: 'unknown', desired: 'unknown' };
  if (item.kind === 'Deployment' || item.kind === 'StatefulSet') {
    return {
      ready: String(item.status?.readyReplicas ?? 0),
      desired: String(item.spec?.replicas ?? 1),
    };
  }
  if (item.kind === 'DaemonSet') {
    return {
      ready: String(item.status?.numberReady ?? 0),
      desired: String(item.status?.desiredNumberScheduled ?? 0),
    };
  }
  return { ready: 'unknown', desired: 'unknown' };
}

function serviceForHost(hostname) {
  const match = String(hostname || '').match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?$/i);
  if (!match) return null;
  const [, serviceName, namespace] = match;
  const services = readJson('meta/k8s-services.json', { items: [] }).items || [];
  return services.find((svc) => (
    svc?.metadata?.namespace === namespace &&
    svc?.metadata?.name === serviceName &&
    svc?.spec?.clusterIP &&
    svc.spec.clusterIP !== 'None'
  ));
}

function requestUrl(target, timeoutSeconds, hostHeader) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (error) {
      resolve({ status: '000', error: `bad_url:${error.message}` });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: Number(timeoutSeconds) * 1000,
      rejectUnauthorized: false,
      headers: hostHeader ? { Host: hostHeader } : {},
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: String(response.statusCode || '000') }));
    });

    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (error) => {
      resolve({ status: '000', error: error.message });
    });
    request.end();
  });
}

async function probeHttp(url, timeoutSeconds, logLines) {
  if (!url) return { status: 'not_checked', effectiveUrl: '' };

  const original = await requestUrl(url, timeoutSeconds);
  logLines.push(`http_probe url=${url} status=${original.status}${original.error ? ` error=${original.error}` : ''}`);
  if (original.status !== '000') return { status: original.status, effectiveUrl: url };

  const parsed = new URL(url);
  const service = serviceForHost(parsed.hostname);
  if (!service) return { status: '000', effectiveUrl: url };

  const fallback = new URL(url);
  fallback.hostname = service.spec.clusterIP;
  const fallbackResult = await requestUrl(fallback.toString(), timeoutSeconds, parsed.host);
  logLines.push(`http_probe_fallback url=${fallback.toString()} host=${parsed.host} status=${fallbackResult.status}${fallbackResult.error ? ` error=${fallbackResult.error}` : ''}`);
  return { status: fallbackResult.status, effectiveUrl: fallback.toString() };
}

async function main() {
  const logLines = [
    `group=${spec.group} namespace=${spec.namespace} kind=${spec.kind} name=${spec.name}`,
    'source=meta-cache',
  ];

  const item = findK8sObject(spec.namespace, spec.kind, spec.name);
  let status = item ? 'ok' : 'missing_k8s_object';
  const replicas = replicaStatus(item);
  if (item && replicas.ready !== 'unknown' && replicas.desired !== 'unknown' && Number(replicas.ready) < Number(replicas.desired)) {
    status = 'not_ready';
  }

  const httpResult = await probeHttp(spec.url, spec.timeoutSeconds, logLines);
  if (httpResult.status === '000' && spec.url) {
    status = 'http_unreachable';
  }

  const row = {
    pipeline_version: 'v11',
    build: String(spec.build),
    group: spec.group,
    namespace: spec.namespace,
    kind: spec.kind,
    name: spec.name,
    status,
    http_status: httpResult.status,
    ready_replicas: replicas.ready,
    desired_replicas: replicas.desired,
    url: spec.url || '',
    effective_url: httpResult.effectiveUrl || '',
  };

  fs.mkdirSync('reports/v11-checks', { recursive: true });
  fs.appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`);
  fs.writeFileSync(outPath, `${logLines.join('\n')}\n${JSON.stringify(row, null, 2)}\n`);

  if (String(spec.strictReady) === 'true' && status !== 'ok') {
    console.error(`STRICT_SERVICE_READY=true and probe failed for ${spec.namespace}/${spec.kind}/${spec.name}: ${status}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
