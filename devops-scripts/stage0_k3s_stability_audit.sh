#!/bin/bash
# ============================================================
# 第零阶段：K3s 稳定性护栏审计脚本
# 版本：v1.0  生产环境专用 | 只读，绝不修改任何配置
# 用法：bash stage0_k3s_stability_audit.sh
# 目标：
#   1. 先看清开机自启、CrashLoop、重启次数、Ingress 可达性
#   2. 只给保守建议，不自动修
# ============================================================
set -uo pipefail

TS=$(date +%F_%H%M%S)
OUT="/tmp/k3s_stability_${TS}"
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"

log()     { echo "[$(date '+%H:%M:%S')] $*"; }
section() { echo; printf '═%.0s' {1..70}; echo; echo "▶  $*"; printf '═%.0s' {1..70}; echo; }

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
KUBECTL_OK=0

log "审计输出目录：$OUT"
log "开始执行 K3s 稳定性只读巡检..."

command -v kubectl >/dev/null 2>&1 || echo "kubectl_not_found" > "$OUT/kubectl_status.txt"
if command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1; then
  KUBECTL_OK=1
  echo "kubectl_ok" > "$OUT/kubectl_status.txt"
fi

# ────────────────────────────────────────────────────────────
# 00 基础信息
# ────────────────────────────────────────────────────────────
{
  echo "hostname  : $(hostname)"
  echo "date      : $(date)"
  echo "uptime    : $(uptime)"
  echo "loadavg   : $(cat /proc/loadavg 2>/dev/null)"
  echo "nproc     : $(nproc 2>/dev/null || echo unknown)"
  echo "host_ip   : ${HOST_IP:-unknown}"
  echo
  free -h 2>/dev/null || true
  echo
  df -hT 2>/dev/null || true
} > "$OUT/00_basic.txt" 2>&1

# ────────────────────────────────────────────────────────────
# 01 关键服务：只查 enabled/active，不修改
# ────────────────────────────────────────────────────────────
{
  printf "%-18s %-12s %-12s\n" "SERVICE" "ENABLED" "ACTIVE"
  printf '─%.0s' {1..46}; echo
  for svc in ssh sshd k3s k3s-agent containerd; do
    en=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    ac=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
    printf "%-18s %-12s %-12s\n" "$svc" "$en" "$ac"
  done
} > "$OUT/01_services.txt" 2>&1

# ────────────────────────────────────────────────────────────
# 02 Kubernetes 状态
# ────────────────────────────────────────────────────────────
if [ "$KUBECTL_OK" -eq 1 ]; then
  kubectl get nodes -o wide > "$OUT/10_nodes.txt" 2>&1
  kubectl get pods -A -o wide > "$OUT/11_pods.txt" 2>&1
  kubectl get svc -A > "$OUT/12_services.txt" 2>&1
  kubectl get ingress -A > "$OUT/13_ingress.txt" 2>&1
  kubectl get events -A --sort-by=.lastTimestamp | tail -n 200 > "$OUT/14_events_tail.txt" 2>&1
else
  echo "kubectl not available or cluster unreachable" > "$OUT/10_nodes.txt"
fi

# 02a 明显异常 Pod
if [ "$KUBECTL_OK" -eq 1 ]; then
  kubectl get pods -A --no-headers 2>/dev/null \
    | awk '$4 ~ /CrashLoopBackOff|ImagePullBackOff|CreateContainerConfigError|CreateContainerError|Error|Pending|Evicted/ {print}' \
    > "$OUT/15_bad_pods.txt"
else
  echo "kubectl unavailable" > "$OUT/15_bad_pods.txt"
fi

# 02b 重启次数告警
if [ "$KUBECTL_OK" -eq 1 ] && command -v python3 >/dev/null 2>&1; then
  kubectl get pods -A -o json > "$OUT/pods.json" 2>/dev/null
  python3 - "$OUT/pods.json" > "$OUT/16_restart_watchlist.txt" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

rows = []
for item in data.get("items", []):
    ns = item["metadata"]["namespace"]
    name = item["metadata"]["name"]
    phase = item.get("status", {}).get("phase", "")
    statuses = item.get("status", {}).get("containerStatuses", []) or []
    total = sum(cs.get("restartCount", 0) for cs in statuses)
    reasons = []
    for cs in statuses:
      state = cs.get("state", {}) or {}
      waiting = state.get("waiting") or {}
      if waiting.get("reason"):
          reasons.append(waiting["reason"])
    if total >= 5 or reasons:
        rows.append((total, ns, name, phase, ",".join(sorted(set(reasons))) or "-"))

print("TOTAL_RESTARTS\tNAMESPACE\tPOD\tPHASE\tWAITING_REASONS")
for total, ns, name, phase, reasons in sorted(rows, reverse=True):
    print(f"{total}\t{ns}\t{name}\t{phase}\t{reasons}")
PY
else
  echo "python3 unavailable, skip restart watchlist" > "$OUT/16_restart_watchlist.txt"
fi

# 02c 资源约束审计
if [ "$KUBECTL_OK" -eq 1 ] && command -v python3 >/dev/null 2>&1; then
  kubectl get deploy,statefulset -A -o json > "$OUT/workloads.json" 2>/dev/null
  python3 - "$OUT/workloads.json" > "$OUT/17_resource_guardrails.txt" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

print("KIND\tNAMESPACE\tWORKLOAD\tCONTAINER\tMISSING")
for item in data.get("items", []):
    kind = item.get("kind", "")
    ns = item["metadata"]["namespace"]
    name = item["metadata"]["name"]
    containers = item.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []) or []
    for c in containers:
        res = c.get("resources", {}) or {}
        req = res.get("requests", {}) or {}
        lim = res.get("limits", {}) or {}
        missing = []
        if "cpu" not in req:
            missing.append("requests.cpu")
        if "memory" not in req:
            missing.append("requests.memory")
        if "memory" not in lim:
            missing.append("limits.memory")
        if missing:
            print(f"{kind}\t{ns}\t{name}\t{c.get('name','-')}\t{','.join(missing)}")
PY
else
  echo "python3 unavailable, skip resource guardrails" > "$OUT/17_resource_guardrails.txt"
fi

# 02d 资源热区
if [ "$KUBECTL_OK" -eq 1 ] && kubectl top pods -A >/dev/null 2>&1; then
  kubectl top pods -A --sort-by=cpu > "$OUT/18_top_cpu.txt" 2>&1
  kubectl top pods -A --sort-by=memory > "$OUT/19_top_mem.txt" 2>&1
else
  echo "metrics-server unavailable or kubectl top failed" > "$OUT/18_top_cpu.txt"
  echo "metrics-server unavailable or kubectl top failed" > "$OUT/19_top_mem.txt"
fi

# 02e 失败 Pod 日志快照
if [ "$KUBECTL_OK" -eq 1 ] && [ -s "$OUT/15_bad_pods.txt" ]; then
  while read -r ns pod _; do
    [ -n "$ns" ] || continue
    kubectl logs -n "$ns" "$pod" --previous --tail=80 > "$OUT/log_${ns}_${pod}.txt" 2>&1 || \
      kubectl logs -n "$ns" "$pod" --tail=80 > "$OUT/log_${ns}_${pod}.txt" 2>&1 || true
  done < "$OUT/15_bad_pods.txt"
fi

# ────────────────────────────────────────────────────────────
# 03 本机入口探针
# ────────────────────────────────────────────────────────────
{
  printf "%-28s %-20s\n" "HOST" "RESULT"
  printf '─%.0s' {1..50}; echo
  for host in \
    gitlab.devops.local \
    airflow.devops.local \
    superset.devops.local \
    minio.devops.local \
    trino.devops.local \
    jaeger.devops.local \
    grafana.devops.local \
    kibana.devops.local \
    prometheus.devops.local \
    argocd.devops.local \
    spark.devops.local \
    traefik.devops.local; do
    result=$(curl -sS -o /dev/null -H "Host: $host" --connect-timeout 3 --max-time 5 \
      -w 'code=%{http_code} total=%{time_total}s redirect=%{redirect_url}' \
      http://127.0.0.1 2>/dev/null || echo "code=FAIL total=- redirect=-")
    printf "%-28s %-20s\n" "$host" "$result"
  done
} > "$OUT/20_http_probe.txt" 2>&1

# ────────────────────────────────────────────────────────────
# 04 生成总结
# ────────────────────────────────────────────────────────────
{
cat <<'BANNER'
╔════════════════════════════════════════════════════════════════════╗
║              K3s 稳定性优先巡检报告（只读 / 无修改）              ║
╚════════════════════════════════════════════════════════════════════╝
BANNER
echo "生成时间：$(date)"
echo "主机名  ：$(hostname)"
echo "目录    ：$OUT"
echo

section "S1. 开机自启护栏"
cat "$OUT/01_services.txt"
echo
echo "判读原则："
echo "  - 对 K8s 托管服务而言，'开机启动 Pod' 的关键不是逐个 Pod 配置，而是确保 k3s 服务可自启。"
echo "  - Deployment / StatefulSet 会在 K3s 启动后自动拉回期望副本。"

section "S2. 关键异常 Pod"
if [ -s "$OUT/15_bad_pods.txt" ]; then
  cat "$OUT/15_bad_pods.txt"
else
  echo "未发现 CrashLoopBackOff / ImagePullBackOff / Pending / Error 类异常 Pod"
fi

section "S3. 重启观察名单"
cat "$OUT/16_restart_watchlist.txt"

section "S4. 资源护栏缺口（只提示，不自动改）"
echo "说明：这里优先提示缺失 requests.cpu / requests.memory / limits.memory 的工作负载。"
echo "说明：CPU limit 不做强制要求，避免在单机资源紧张时引入额外节流风险。"
cat "$OUT/17_resource_guardrails.txt"

section "S5. 本机入口探针"
cat "$OUT/20_http_probe.txt"

section "S6. 低风险优先级建议"
echo "P0. 先不做任何集群级重装、升级、卸载、killall。"
echo "P1. 若 ssh 已 active，但未 enabled，先只做 enable，不重启整机。"
echo "P2. 若 k3s / k3s-agent 未 enabled，优先修复这个，而不是手工处理 Pod。"
echo "P3. 先修单点异常服务（例如 CrashLoopBackOff 的 spark-history-server），再谈新增账号。"
echo "P4. 对慢启动服务优先考虑 startupProbe + 温和的 readinessProbe，而不是更激进的 livenessProbe。"
echo "P5. 对资源紧张节点，先补 requests；memory limit 需要结合实际用量谨慎设；不要集群级一把加 LimitRange。"
echo "P6. Traefik Dashboard 不建议裸奔暴露，后续应单独加认证或 IP 限制。"

section "S7. 后续人工核查命令"
echo "查看单个异常 Pod 详情： kubectl describe pod <pod> -n <ns>"
echo "查看单个异常 Pod 日志： kubectl logs <pod> -n <ns> --previous --tail=200"
echo "查看资源热区： head -n 20 $OUT/18_top_cpu.txt && head -n 20 $OUT/19_top_mem.txt"
echo "查看详细事件： less $OUT/14_events_tail.txt"
} > "$SUMMARY"

log "巡检完成：$SUMMARY"
echo
cat "$SUMMARY"
