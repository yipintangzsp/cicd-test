#!/bin/bash
# ============================================================
# 第一阶段：只读系统审计脚本
# 版本：v2.0  生产环境专用 | 只读，绝不修改任何配置
# 用法：bash /root/devops-scripts/stage1_audit.sh
# ============================================================
set -uo pipefail

TS=$(date +%F_%H%M%S)
OUT=/root/antigravity_opt_${TS}
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
HINT_FILE="$OUT/bottleneck_hints.txt"

log()     { echo "[$(date '+%H:%M:%S')] $*"; }
section() { echo; printf '═%.0s' {1..60}; echo; echo "▶  $*"; printf '═%.0s' {1..60}; echo; }

log "审计目录：$OUT"
log "正在采集数据，请稍候..."

# ────────────────────────────────────────────────────────────
# ① 采集原始数据（全部静默写文件，不打扰终端）
# ────────────────────────────────────────────────────────────

# 00 基础
{
  echo "hostname : $(hostname)"
  echo "date     : $(date)"
  echo "uname    : $(uname -a)"
  echo; cat /etc/os-release 2>/dev/null || true
  echo; echo "uptime   : $(uptime)"
  echo "loadavg  : $(cat /proc/loadavg)"
  echo "nproc    : $(nproc) logical CPUs"
  echo "MemTotal : $(grep MemTotal /proc/meminfo | awk '{print $2/1024" MB"}')"
} > "$OUT/00_basic.txt" 2>&1

# 01 内存（两份：人类可读 + 字节）
free -h  > "$OUT/01_free_human.txt" 2>&1
free -b  > "$OUT/01_free_bytes.txt" 2>&1

# 02 磁盘
df -hT   > "$OUT/02_df.txt" 2>&1
df -ih   > "$OUT/03_df_inode.txt" 2>&1

# 03 vmstat
vmstat 1 5 > "$OUT/04_vmstat.txt" 2>&1

# 04 iostat
if command -v iostat >/dev/null 2>&1; then
  iostat -xz 1 3 > "$OUT/05_iostat.txt" 2>&1
else
  echo "iostat not installed (sysstat package missing)" > "$OUT/05_iostat.txt"
fi

# 05 top / ps
top -b -n 1 > "$OUT/06_top.txt" 2>&1
ps -eo pid,ppid,user,cmd,%cpu,%mem --sort=-%cpu | head -n 40 > "$OUT/07_ps_cpu.txt" 2>&1
ps -eo pid,ppid,user,cmd,%cpu,%mem --sort=-%mem | head -n 40 > "$OUT/08_ps_mem.txt" 2>&1

# 06 systemd
systemctl --failed --no-pager          > "$OUT/09_failed_units.txt" 2>&1 || true
systemctl list-unit-files --type=service --no-pager \
                                        > "$OUT/10_unit_files.txt" 2>&1
systemctl list-units --type=service --state=running --no-pager \
                                        > "$OUT/11_running_services.txt" 2>&1
systemd-analyze blame                  > "$OUT/12_systemd_blame.txt" 2>&1 || true
systemd-analyze critical-chain         > "$OUT/13_critical_chain.txt" 2>&1 || true

# 07 网络
ss -lntup > "$OUT/14_ss_lntup.txt" 2>&1

# 08 近期错误日志（级别 ≤ 3: emerg/alert/crit/err）
journalctl -p 3 -xb --no-pager 2>/dev/null | tail -n 300 \
                                        > "$OUT/15_journal_errors.txt" 2>&1 || true

# 09 Docker / 容器
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}' \
                                        > "$OUT/16_docker_ps.txt" 2>&1
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' \
                                        > "$OUT/16b_docker_all.txt" 2>&1
  docker stats --no-stream             > "$OUT/17_docker_stats.txt" 2>&1
  docker system df                     > "$OUT/17b_docker_df.txt" 2>&1
  # 检查无重启策略的容器
  docker inspect $(docker ps -q) 2>/dev/null \
    | python3 -c "
import json,sys
data=json.load(sys.stdin)
for c in data:
  name=c['Name'].lstrip('/')
  policy=c['HostConfig']['RestartPolicy']['Name']
  print(f'{name}  RestartPolicy={policy}')
" 2>/dev/null > "$OUT/17c_docker_restart_policy.txt" || \
    echo "python3 not available or no containers" > "$OUT/17c_docker_restart_policy.txt"
else
  echo "docker_not_installed" > "$OUT/16_docker_ps.txt"
fi

# Kubernetes
if command -v crictl >/dev/null 2>&1; then
  crictl ps > "$OUT/18_crictl_ps.txt" 2>&1
else
  echo "crictl_not_installed" > "$OUT/18_crictl_ps.txt"
fi
if command -v kubectl >/dev/null 2>&1; then
  kubectl get pods -A -o wide > "$OUT/19_k8s_pods.txt" 2>&1
  kubectl get nodes            > "$OUT/19b_k8s_nodes.txt" 2>&1
else
  echo "kubectl_not_installed" > "$OUT/19_k8s_pods.txt"
fi

# 10 HTTP 探针（仅本机，不打外部）
{
  for u in \
    "http://127.0.0.1"       "http://localhost" \
    "https://127.0.0.1"      "https://localhost" \
    "http://127.0.0.1:8080"  "http://127.0.0.1:8081" \
    "http://127.0.0.1:3000"  "http://127.0.0.1:9090" \
    "http://127.0.0.1:9100"  "http://127.0.0.1:9000" \
    "http://127.0.0.1:9200"  "http://127.0.0.1:5601" \
    "http://127.0.0.1:2375"  "http://127.0.0.1:6443"; do
    result=$(curl -k -o /dev/null -s \
      -w "code=%{http_code} connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s" \
      --max-time 3 "$u" 2>/dev/null || echo "code=FAIL connect=- ttfb=- total=-")
    echo "$u  $result"
  done
} > "$OUT/20_local_http_probe.txt" 2>&1

# 11 Docker daemon 配置
cat /etc/docker/daemon.json > "$OUT/21_docker_daemon.txt" 2>/dev/null || \
  echo "no_daemon_json" > "$OUT/21_docker_daemon.txt"

# 12 关键服务 enabled/active 状态
{
  printf "%-30s %-12s %-12s\n" "SERVICE" "ENABLED" "ACTIVE"
  printf '─%.0s' {1..56}; echo
  for svc in \
    docker containerd \
    nginx openresty apache2 httpd \
    redis redis-server \
    mysql mysqld mariadb postgresql \
    jenkins gitlab-runner sonarqube \
    prometheus grafana-server alertmanager node_exporter \
    kubelet etcd \
    harbor-jobservice harbor-core harbor-registry harbor-portal; do
    en=$(systemctl is-enabled "$svc" 2>/dev/null || echo "not-found")
    ac=$(systemctl is-active  "$svc" 2>/dev/null || echo "not-found")
    printf "%-30s %-12s %-12s\n" "$svc" "$en" "$ac"
  done
  echo
  echo "--- 所有 running 的非标准用户服务（platform app 候选）---"
  systemctl list-units --type=service --state=running --no-pager 2>/dev/null \
    | grep -vE '(systemd|dbus|sshd|crond|cron|rsyslog|network|firewall|polkit|auditd|tuned|getty|login|user@)' \
    | head -n 40 || true
} > "$OUT/22_key_services.txt" 2>&1

# 13 内核关键参数（只读）
{
  echo "=== TCP/网络 ==="
  sysctl net.core.somaxconn net.ipv4.tcp_max_syn_backlog \
         net.ipv4.tcp_tw_reuse net.ipv4.ip_local_port_range \
         net.core.netdev_max_backlog 2>/dev/null || true
  echo
  echo "=== 内存/VM ==="
  sysctl vm.swappiness vm.dirty_ratio vm.dirty_background_ratio \
         vm.overcommit_memory 2>/dev/null || true
  echo
  echo "=== 文件句柄 ==="
  cat /proc/sys/fs/file-max 2>/dev/null && echo "(fs.file-max)"
  cat /proc/sys/fs/file-nr  2>/dev/null && echo "(fs.file-nr: open/unused/max)"
  ulimit -n
} > "$OUT/23_sysctl_readonly.txt" 2>&1

# 14 日志磁盘占用（journald + var/log）
{
  echo "=== journald 占用 ==="
  journalctl --disk-usage 2>/dev/null || true
  echo
  echo "=== /var/log 最大目录 ==="
  du -sh /var/log/*/ 2>/dev/null | sort -rh | head -n 20 || true
  echo
  echo "=== /var/log 总量 ==="
  du -sh /var/log 2>/dev/null || true
} > "$OUT/24_log_disk.txt" 2>&1

# 15 swap 详情
{
  swapon --show 2>/dev/null || echo "no swap configured"
  cat /proc/swaps 2>/dev/null || true
} > "$OUT/25_swap.txt" 2>&1

log "原始数据采集完毕，正在生成 summary.txt..."

# ────────────────────────────────────────────────────────────
# ② 自动生成 summary.txt
# ────────────────────────────────────────────────────────────

{
cat <<'BANNER'
╔══════════════════════════════════════════════════════════╗
║          DevOps 平台服务器 - 只读审计报告                ║
║          由 stage1_audit.sh 自动生成，只读，无修改       ║
╚══════════════════════════════════════════════════════════╝
BANNER

echo "生成时间：$(date)"
echo "主机名  ：$(hostname)"
echo

# ── S1: 基础信息 ──────────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S1. 基础信息"
echo "════════════════════════════════════════════════════════"
tail -n +1 "$OUT/00_basic.txt"
echo

# ── S2: 内存 / Swap ───────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S2. 内存 / Swap"
echo "════════════════════════════════════════════════════════"
cat "$OUT/01_free_human.txt"
echo
echo "--- Swap 详情 ---"
cat "$OUT/25_swap.txt"
echo

# ── S3: 磁盘 ──────────────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S3. 磁盘使用（按挂载点）"
echo "════════════════════════════════════════════════════════"
cat "$OUT/02_df.txt"
echo
echo "--- 磁盘 Inode 使用 ---"
cat "$OUT/03_df_inode.txt"
echo

# ── S4: 性能基线（vmstat）─────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S4. 实时性能基线 (vmstat 1 5)"
echo "════════════════════════════════════════════════════════"
cat "$OUT/04_vmstat.txt"
echo

# ── S5: TOP CPU 进程（前10）──────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S5. TOP 10 CPU 消耗进程"
echo "════════════════════════════════════════════════════════"
head -n 12 "$OUT/07_ps_cpu.txt"
echo

# ── S6: TOP 内存进程（前10）──────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S6. TOP 10 内存消耗进程"
echo "════════════════════════════════════════════════════════"
head -n 12 "$OUT/08_ps_mem.txt"
echo

# ── S7: Failed Services ───────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S7. Failed Services（failed 即为异常）"
echo "════════════════════════════════════════════════════════"
cat "$OUT/09_failed_units.txt"
echo

# ── S8: 关键服务状态 ─────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S8. 关键服务 enabled / active 状态"
echo "════════════════════════════════════════════════════════"
cat "$OUT/22_key_services.txt"
echo

# ── S9: 关键监听端口 ─────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S9. 关键监听端口 (ss -lntup)"
echo "════════════════════════════════════════════════════════"
cat "$OUT/14_ss_lntup.txt"
echo

# ── S10: 近期严重错误日志（最后50行）────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S10. 近期严重错误日志（journalctl -p3，最后50行）"
echo "════════════════════════════════════════════════════════"
tail -n 50 "$OUT/15_journal_errors.txt"
echo

# ── S11: Docker 状态 ─────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S11. Docker 容器状态"
echo "════════════════════════════════════════════════════════"
if grep -q "docker_not_installed" "$OUT/16_docker_ps.txt" 2>/dev/null; then
  echo "[Docker 未安装]"
else
  echo "--- 运行中容器 ---"
  cat "$OUT/16_docker_ps.txt"
  echo
  echo "--- 全部容器（含已停止）---"
  cat "$OUT/16b_docker_all.txt"
  echo
  echo "--- 容器资源使用 ---"
  cat "$OUT/17_docker_stats.txt"
  echo
  echo "--- Docker 磁盘占用 ---"
  cat "$OUT/17b_docker_df.txt"
  echo
  echo "--- 容器重启策略 ---"
  cat "$OUT/17c_docker_restart_policy.txt"
fi
echo

# ── S12: 本地 HTTP 探针 ───────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S12. 本地 HTTP 探针结果（仅 127.0.0.1 / localhost）"
echo "════════════════════════════════════════════════════════"
cat "$OUT/20_local_http_probe.txt"
echo

# ── S13: 日志磁盘占用 ────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S13. 日志磁盘占用"
echo "════════════════════════════════════════════════════════"
cat "$OUT/24_log_disk.txt"
echo

# ── S14: 内核关键参数（只读快照）────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S14. 内核关键参数快照（只读）"
echo "════════════════════════════════════════════════════════"
cat "$OUT/23_sysctl_readonly.txt"
echo

# ── S15: iostat 摘要 ─────────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S15. IO 统计 (iostat)"
echo "════════════════════════════════════════════════════════"
cat "$OUT/05_iostat.txt"
echo

# ── S16: systemd 启动耗时 TOP20 ──────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  S16. systemd-analyze blame TOP 20（启动耗时）"
echo "════════════════════════════════════════════════════════"
head -n 20 "$OUT/12_systemd_blame.txt"
echo

} > "$SUMMARY"

# ────────────────────────────────────────────────────────────
# ③ 自动生成"疑似瓶颈提示"（基于数据推断，追加到 summary）
# ────────────────────────────────────────────────────────────

{
echo "════════════════════════════════════════════════════════"
echo "  S17. ⚠️  自动疑似瓶颈提示（脚本推断，需人工确认）"
echo "════════════════════════════════════════════════════════"

HINTS=()

# --- 内存压力检测 ---
MEM_AVAIL_KB=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
MEM_TOTAL_KB=$(grep MemTotal     /proc/meminfo | awk '{print $2}')
if [ -n "$MEM_AVAIL_KB" ] && [ -n "$MEM_TOTAL_KB" ] && [ "$MEM_TOTAL_KB" -gt 0 ]; then
  AVAIL_PCT=$((MEM_AVAIL_KB * 100 / MEM_TOTAL_KB))
  if [ "$AVAIL_PCT" -lt 10 ]; then
    HINTS+=("🔴 [内存] 可用内存仅剩 ${AVAIL_PCT}%（< 10%），内存压力极高，极可能是卡顿主因")
  elif [ "$AVAIL_PCT" -lt 20 ]; then
    HINTS+=("🟡 [内存] 可用内存剩余 ${AVAIL_PCT}%（< 20%），内存偏紧，需关注")
  else
    HINTS+=("🟢 [内存] 可用内存剩余 ${AVAIL_PCT}%，内存暂无明显压力")
  fi
fi

# --- Swap 使用检测 ---
SWAP_USED_KB=$(free -b 2>/dev/null | awk '/Swap:/{print int($3/1024)}')
if [ -n "$SWAP_USED_KB" ] && [ "$SWAP_USED_KB" -gt 524288 ]; then
  HINTS+=("🔴 [Swap] Swap 已使用 $((SWAP_USED_KB/1024)) MB，系统在换页，IO 性能会受影响")
elif [ -n "$SWAP_USED_KB" ] && [ "$SWAP_USED_KB" -gt 102400 ]; then
  HINTS+=("🟡 [Swap] Swap 使用 $((SWAP_USED_KB/1024)) MB，有一定换页压力")
fi

# --- 磁盘使用检测 ---
while IFS= read -r line; do
  USE=$(echo "$line" | awk '{print $6}' | tr -d '%')
  MNT=$(echo "$line" | awk '{print $NF}')
  if [[ "$USE" =~ ^[0-9]+$ ]] && [ "$USE" -ge 90 ]; then
    HINTS+=("🔴 [磁盘] 挂载点 $MNT 使用率 ${USE}%，磁盘接近满，可能影响日志写入和容器运行")
  elif [[ "$USE" =~ ^[0-9]+$ ]] && [ "$USE" -ge 80 ]; then
    HINTS+=("🟡 [磁盘] 挂载点 $MNT 使用率 ${USE}%，磁盘偏高，需持续关注")
  fi
done < <(df --output=pcent,target 2>/dev/null | tail -n +2)

# --- inode 检测 ---
while IFS= read -r line; do
  USE=$(echo "$line" | awk '{print $5}' | tr -d '%')
  MNT=$(echo "$line" | awk '{print $6}')
  if [[ "$USE" =~ ^[0-9]+$ ]] && [ "$USE" -ge 80 ]; then
    HINTS+=("🟡 [Inode] 挂载点 $MNT Inode 使用率 ${USE}%，可能影响小文件写入（如日志、镜像层）")
  fi
done < <(df -i 2>/dev/null | tail -n +2)

# --- Load Average 检测 ---
LOAD1=$(cat /proc/loadavg | awk '{print $1}')
NCPU=$(nproc)
LOAD_INT=$(echo "$LOAD1" | cut -d. -f1)
if [ "$LOAD_INT" -gt "$((NCPU * 2))" ] 2>/dev/null; then
  HINTS+=("🔴 [CPU负载] 1分钟负载 $LOAD1，CPU核数 $NCPU，负载严重过高（> 2x CPU核数）")
elif [ "$LOAD_INT" -gt "$NCPU" ] 2>/dev/null; then
  HINTS+=("🟡 [CPU负载] 1分钟负载 $LOAD1，CPU核数 $NCPU，负载超过1倍CPU核数，需关注")
else
  HINTS+=("🟢 [CPU负载] 1分钟负载 $LOAD1，CPU核数 $NCPU，负载正常")
fi

# --- Failed services ---
FAIL_COUNT=$(grep -c "●\|UNIT" "$OUT/09_failed_units.txt" 2>/dev/null || echo 0)
if grep -q "0 loaded units listed" "$OUT/09_failed_units.txt" 2>/dev/null; then
  HINTS+=("🟢 [Failed] 无 failed services")
else
  HINTS+=("🔴 [Failed] 存在 failed services，详见 S7，需立即处理")
fi

# --- 关键服务 active 但 disabled ---
while IFS= read -r line; do
  SVC=$(echo "$line" | awk '{print $1}')
  EN=$(echo "$line"  | awk '{print $2}' | cut -d= -f2)
  AC=$(echo "$line"  | awk '{print $3}' | cut -d= -f2)
  if [ "$AC" = "active" ] && [ "$EN" = "disabled" ]; then
    HINTS+=("🟡 [开机自启] $SVC 当前运行中但未设开机自启，重启后将不会自动恢复")
  fi
done < <(grep -v "not-found" "$OUT/22_key_services.txt" 2>/dev/null | grep "disabled" | grep "active" || true)

# --- Docker 无重启策略 ---
if [ -f "$OUT/17c_docker_restart_policy.txt" ]; then
  NO_POLICY=$(grep -c "RestartPolicy=no\b\|RestartPolicy=$\|RestartPolicy=no " \
    "$OUT/17c_docker_restart_policy.txt" 2>/dev/null || echo 0)
  if [ "$NO_POLICY" -gt 0 ]; then
    HINTS+=("🟡 [Docker] 有 $NO_POLICY 个容器无重启策略（policy=no），宿主机重启后不会自动恢复")
  fi
fi

# --- journald 错误数量 ---
ERR_COUNT=$(grep -c "." "$OUT/15_journal_errors.txt" 2>/dev/null || echo 0)
if [ "$ERR_COUNT" -gt 100 ]; then
  HINTS+=("🟡 [日志] 近期严重错误日志行数 $ERR_COUNT（> 100），建议逐条确认是否为持续性异常")
fi

# --- 输出所有 hints ---
if [ "${#HINTS[@]}" -eq 0 ]; then
  echo "未发现明显瓶颈（建议仍人工核查 summary 各项数据）"
else
  for h in "${HINTS[@]}"; do
    echo "$h"
  done
fi

echo
echo "────────────────────────────────────────────────────────"
echo "  ★ 审计说明"
echo "────────────────────────────────────────────────────────"
echo "  完整原始数据：$OUT/"
echo "  本文件是摘要不是全量，分析时请结合原始文件"
echo "  下一步：将本文件内容发给 AI 分析 → 输出优化候选清单"
echo "  全量打包：$OUT/../full_report_${TS}.tar.gz"
echo "════════════════════════════════════════════════════════"

} >> "$SUMMARY"

# ────────────────────────────────────────────────────────────
# ④ 打包完整原始日志
# ────────────────────────────────────────────────────────────
TARBALL="/root/full_report_${TS}.tar.gz"
tar -czf "$TARBALL" -C /root "$(basename $OUT)" 2>/dev/null || true
log "完整原始日志已打包：$TARBALL"

# ────────────────────────────────────────────────────────────
# ⑤ 终端输出提示
# ────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  审计完成！请执行以下命令查看摘要并发回 AI：         ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  cat $SUMMARY"
echo "║                                                          ║"
echo "║  完整原始日志：$TARBALL  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo
cat "$SUMMARY"
