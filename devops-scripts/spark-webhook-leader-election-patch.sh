#!/usr/bin/env bash
set -eu

namespace="${SPARK_OPERATOR_NAMESPACE:-ns-bigdata}"
deployment="${SPARK_WEBHOOK_DEPLOYMENT:-spark-operator-webhook}"
backup_root="${BACKUP_ROOT:-/home/zhang/platform-safe-backups}"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${backup_root}/v13-spark-webhook-${timestamp}"

mkdir -p "${backup_dir}"
kubectl -n "${namespace}" get deploy "${deployment}" -o yaml > "${backup_dir}/deploy-${deployment}.before.yaml"

ensure_arg() {
  arg="$1"
  if kubectl -n "${namespace}" get deploy "${deployment}" \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -F -- "${arg}" >/dev/null; then
    return 0
  fi
  kubectl -n "${namespace}" patch deploy "${deployment}" --type=json \
    -p="[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"${arg}\"}]"
}

ensure_arg '--leader-election-lease-duration=90s'
ensure_arg '--leader-election-renew-deadline=60s'
ensure_arg '--leader-election-retry-period=10s'

kubectl -n "${namespace}" patch deploy "${deployment}" --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/timeoutSeconds","value":10},
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/timeoutSeconds","value":10},
  {"op":"replace","path":"/spec/template/spec/containers/0/startupProbe/timeoutSeconds","value":10},
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/failureThreshold","value":12},
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/failureThreshold","value":12},
  {"op":"replace","path":"/spec/template/spec/containers/0/startupProbe/failureThreshold","value":60}
]'

kubectl -n "${namespace}" annotate deploy "${deployment}" \
  "v13.zhanglab.ccwu.cc/leader-election-tuned=${timestamp}" --overwrite
kubectl -n "${namespace}" annotate deploy "${deployment}" \
  "v13.zhanglab.ccwu.cc/probe-tuned=${timestamp}" --overwrite
kubectl -n "${namespace}" rollout status "deploy/${deployment}" --timeout=180s
kubectl -n "${namespace}" get endpointslice \
  -l kubernetes.io/service-name=spark-operator-webhook-svc \
  -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.name}{" ready="}{.conditions.ready}{" serving="}{.conditions.serving}{"\n"}{end}'

echo "backup=${backup_dir}/deploy-${deployment}.before.yaml"
