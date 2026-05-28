#!/bin/bash
# ============================================================
# 第四阶段：变更后验证脚本
# 版本：v2.0  生产环境专用
# 用法：bash /root/devops-scripts/stage4_verify.sh
# 前提：已完成第三阶段优化（需要有 stage1 审计的基线对比）
# ============================================================
set -uo pipefail

TS=$(date +%F_%H%M%S)
OUT="/root/antigravity_verify_${TS}"
mkdir -p "$OUT"
REPORT="$OUT/verify_report.txt"

log()     { echo "[$(date '+%H:%M:%S')] $*"; }
section() { echo; printf '─%.0s' {1..60}; echo; echo "▶  $*"; printf '─%.0s' {1..60}; echo; }

log "验证报告：$REPORT"
log "开始变更后验证..."

{
echo "╔══════════════════════════════════════════════════════════╗"
echo "║          第四阶段：变更后验证报告                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo "验证时间：$(date)"
echo "主机名  ：$(hostname)"
echo

# ── V1: Failed Services（最重要，必须为 0）──────────────────
echo "════════ V1. Failed Services（必须为 0）════════"
systemctl --failed --no-pager
echo

# ── V2: 系统负载对比 ────────────────────────────────────────
echo "════════ V2. 当前系统负载 ════════"
echo "uptime  : $(uptime)"
echo "loadavg : $(cat /proc/loadavg)"
echo

# ── V3: 内存对比 ────────────────────────────────────────────
echo "════════ V3. 内存使用情况 ════════"
free -h
echo

# ── V4: vmstat 5次采样 ──────────────────────────────────────
echo "════════ V4. vmstat 1 5（IO/swap 观察）════════"
vmstat 1 5
echo

# ── V5: TOP 进程（对比基线）────────────────────────────────
echo "════════ V5. 当前 TOP 10 CPU 进程 ════════"
ps -eo pid,ppid,user,cmd,%cpu,%mem --sort=-%cpu | head -n 12
echo
echo "════════ V5b. 当前 TOP 10 内存进程 ════════"
ps -eo pid,ppid,user,cmd,%cpu,%mem --sort=-%mem | head -n 12
echo

# ── V6: 关键服务状态验证 ────────────────────────────────────
echo "════════ V6. 关键服务 enabled/active 状态 ════════"
printf "%-30s %-12s %-12s\n" "SERVICE" "ENABLED" "ACTIVE"
printf '─%.0s' {1..56}; echo
for svc in \
  docker containerd \
  nginx openresty apache2 httpd \
  redis redis-server \
  mysql mysqld mariadb postgresql \
  jenkins gitlab-runner sonarqube \
  prometheus grafana-server alertmanager node_exporter \
  kubelet etcd; do
  en=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
  ac=$(systemctl is-active  "$svc" 2>/dev/null || echo "not-found")
  # 高亮问题项
  FLAG=""
  if [ "$ac" = "active" ] && [ "$en" = "disabled" ]; then FLAG=" ⚠️ 运行中但未自启！"; fi
  if [ "$ac" = "failed" ]; then FLAG=" 🔴 FAILED！"; fi
  printf "%-30s %-12s %-12s%s\n" "$svc" "$en" "$ac" "$FLAG"
done
echo

# ── V7: 关键端口监听 ────────────────────────────────────────
echo "════════ V7. 关键监听端口 ════════"
ss -lntup | grep -E "LISTEN|udp|UNCONN" | sort
echo

# ── V8: 本地 HTTP 探针（对比基线）──────────────────────────
echo "════════ V8. 本地 HTTP 响应探针 ════════"
for u in \
  "http://127.0.0.1"       "http://localhost" \
  "https://127.0.0.1"      "https://localhost" \
  "http://127.0.0.1:8080"  "http://127.0.0.1:3000" \
  "http://127.0.0.1:9090"  "http://127.0.0.1:9100" \
  "http://127.0.0.1:9000"  "http://127.0.0.1:5601"; do
  result=$(curl -k -o /dev/null -s \
    -w "code=%{http_code} connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s" \
    --max-time 3 "$u" 2>/dev/null || echo "code=FAIL connect=- ttfb=- total=-")
  echo "$u  $result"
done
echo

# ── V9: 磁盘使用（对比基线）────────────────────────────────
echo "════════ V9. 磁盘使用 ════════"
df -hT
echo

# ── V10: 近期错误日志（变更后是否有新增错误）───────────────
echo "════════ V10. 变更后近期错误日志（最新30行）════════"
journalctl -p 3 -xb --no-pager 2>/dev/null | tail -n 30 || true
echo

# ── V11: Docker 容器状态 ────────────────────────────────────
echo "════════ V11. Docker 容器状态 ════════"
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}'
  echo
  echo "--- 容器资源 ---"
  docker stats --no-stream
else
  echo "[Docker 未安装]"
fi
echo

# ── V12: 对比检查清单 ───────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  ★ 变更后检查清单（请人工逐项确认）"
echo "════════════════════════════════════════════════════════"
echo "  [ ] V1  failed services 数量是否为 0？"
echo "  [ ] V2  系统负载是否与基线持平或下降？"
echo "  [ ] V3  内存可用量是否与基线持平或改善？"
echo "  [ ] V4  vmstat 是否无明显 swap 抖动（si/so 接近 0）？"
echo "  [ ] V6  需自启的关键服务是否全部变为 enabled？"
echo "  [ ] V7  关键端口监听是否正常（无减少）？"
echo "  [ ] V8  本地 HTTP 响应时间是否与基线持平或改善？"
echo "  [ ] V10 是否有新增的 failed/error 日志？（应为无）"
echo "  [ ] V11 容器是否全部健康运行？"
echo

echo "════════════════════════════════════════════════════════"
echo "  如有任何指标劣化 → 立即执行回滚命令（见 stage3 变更日志）"
echo "  完整验证报告：$REPORT"
echo "════════════════════════════════════════════════════════"

} | tee "$REPORT"

log "验证完成，报告已保存：$REPORT"
