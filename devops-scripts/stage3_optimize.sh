#!/bin/bash
# ============================================================
# 第三阶段：低风险优化执行脚本
# 版本：v2.0  生产环境专用
# 前提：必须先完成第一阶段审计，并经过第二阶段人工确认候选清单
# 用法：bash /root/devops-scripts/stage3_optimize.sh
# ============================================================
# 【绝对约束】
#   - 禁止重启整机
#   - 禁止修改内核参数（除非有专项脚本且证据充分）
#   - 禁止动数据库真实数据
#   - 禁止 kill 核心业务进程
#   - 每步操作后立即校验
# ============================================================
set -uo pipefail

TS=$(date +%F_%H%M%S)
CHANGE_LOG="/root/stage3_changes_${TS}.log"
: > "$CHANGE_LOG"   # 创建变更日志文件

log()    { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$CHANGE_LOG"; }
ok()     { echo "  ✅ $*" | tee -a "$CHANGE_LOG"; }
warn()   { echo "  ⚠️  $*" | tee -a "$CHANGE_LOG"; }
skip()   { echo "  ⏭️  [跳过] $*" | tee -a "$CHANGE_LOG"; }
section(){ echo | tee -a "$CHANGE_LOG"; echo "━━━ $* ━━━" | tee -a "$CHANGE_LOG"; }

log "变更日志文件：$CHANGE_LOG"
log "开始执行低风险优化..."

# ────────────────────────────────────────────────────────────
# 辅助函数：安全地 enable 一个服务
# ────────────────────────────────────────────────────────────
safe_enable() {
  local SVC="$1"
  local REASON="$2"

  # 检查服务文件是否存在
  if ! systemctl cat "$SVC" >/dev/null 2>&1; then
    skip "$SVC：服务不存在，跳过"
    return
  fi

  local BEFORE_EN
  local BEFORE_AC
  BEFORE_EN=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "unknown")
  BEFORE_AC=$(systemctl is-active  "$SVC" 2>/dev/null || echo "unknown")

  if [ "$BEFORE_EN" = "enabled" ]; then
    skip "$SVC：已经是 enabled，无需操作"
    return
  fi

  if [ "$BEFORE_EN" = "static" ] || [ "$BEFORE_EN" = "linked" ]; then
    skip "$SVC：状态为 $BEFORE_EN，由系统管理，无需手工 enable"
    return
  fi

  log "变更：enable $SVC"
  log "  原因        : $REASON"
  log "  变更前 enabled=$BEFORE_EN  active=$BEFORE_AC"
  log "  回滚命令    : systemctl disable $SVC"

  if systemctl enable "$SVC" >> "$CHANGE_LOG" 2>&1; then
    local AFTER_EN
    AFTER_EN=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "unknown")
    ok "$SVC → enabled=${AFTER_EN}（active 状态未变，本次不重启服务）"
  else
    warn "$SVC：enable 失败，请查看 $CHANGE_LOG 获取详情"
  fi
}

# ────────────────────────────────────────────────────────────
# A. 修正关键服务开机自启
#    判断标准：服务当前 active、是平台核心依赖、且 disabled
# ────────────────────────────────────────────────────────────
section "A. 修正关键服务开机自启（仅处理 active 且 disabled 的）"

# ── A1: 容器运行时 ──
for SVC in docker containerd; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "容器运行时，平台核心依赖，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  elif [ "$ACTIVE" != "active" ]; then
    skip "$SVC：当前未运行（active=$ACTIVE），不贸然设自启，需人工确认"
  fi
done

# ── A2: 反向代理 / 网关 ──
for SVC in nginx openresty apache2 httpd; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "反向代理/网关，平台流量入口，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  elif [ "$ACTIVE" != "active" ] && [ "$ACTIVE" != "not-found" ]; then
    skip "$SVC：当前未运行（active=$ACTIVE），不贸然设自启，需人工确认"
  fi
done

# ── A3: 缓存 ──
for SVC in redis redis-server; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "Redis 缓存，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  fi
done

# ── A4: 数据库（仅 active 且 disabled 才处理）──
for SVC in mysql mysqld mariadb postgresql; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "数据库，当前运行中但未设自启（不重启服务，仅 enable）"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  fi
done

# ── A5: CI/CD 平台 ──
for SVC in jenkins gitlab-runner; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "CI/CD 服务，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  fi
done

# ── A6: 监控基础代理（node_exporter）──
for SVC in node_exporter; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "监控指标采集代理，缺失会影响运维可观测性，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  fi
done

# ── A7: Kubernetes（仅在 kubelet 运行时处理）──
for SVC in kubelet; do
  ACTIVE=$(systemctl is-active "$SVC" 2>/dev/null || echo "not-found")
  ENABLED=$(systemctl is-enabled "$SVC" 2>/dev/null || echo "not-found")
  if [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "disabled" ]; then
    safe_enable "$SVC" "kubelet 是 K8s 节点核心，当前运行中但未设自启"
  elif [ "$ACTIVE" = "active" ] && [ "$ENABLED" = "enabled" ]; then
    skip "$SVC：已是 enabled + active，无需操作"
  fi
done

# ────────────────────────────────────────────────────────────
# B. journald 日志磁盘限制（如果 /var/log 占用超过 2GB）
#    操作：仅配置大小上限，不删现有日志，重启 journald
#    风险：极低，可回滚
# ────────────────────────────────────────────────────────────
section "B. journald 日志磁盘限制（可选，仅当 /var/log 过大时执行）"

JOURNAL_DISK=$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d.]+\s*(G|M)B' | head -n 1 || echo "unknown")
log "当前 journald 占用：$JOURNAL_DISK"

VAR_LOG_USED=$(df /var/log 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%')

if [ -n "$VAR_LOG_USED" ] && [ "$VAR_LOG_USED" -ge 80 ] 2>/dev/null; then
  warn "/var/log 使用率 ${VAR_LOG_USED}%，建议执行以下操作（此处不自动执行，需人工确认）："
  echo "  # 查看 journald 配置文件"
  echo "  cat /etc/systemd/journald.conf"
  echo "  # 如无 SystemMaxUse 限制，可添加（建议值 500M）："
  echo "  # echo 'SystemMaxUse=500M' >> /etc/systemd/journald.conf"
  echo "  # systemctl restart systemd-journald"
  echo "  # 回滚：删除上面添加的行，再 restart systemd-journald"
else
  skip "日志磁盘使用率 ${VAR_LOG_USED}%，未超阈值，无需操作"
fi

# ────────────────────────────────────────────────────────────
# C. Docker 孤立 overlay2 / 无用镜像处理
#    风险：中等。不自动执行，仅输出建议命令
# ────────────────────────────────────────────────────────────
section "C. Docker 资源清理建议（不自动执行，需人工确认后手动运行）"

if command -v docker >/dev/null 2>&1; then
  log "已检测到 Docker，以下是可选清理命令（不自动执行）："
  echo
  echo "  # 查看 Docker 磁盘占用详情："
  echo "  docker system df -v"
  echo
  echo "  # 清理已停止容器 + 无用网络 + 悬空镜像（不删卷）："
  echo "  docker system prune -f"
  echo "  # 回滚：无法回滚已删除的悬空镜像（但悬空镜像是无用的）"
  echo
  echo "  # ⚠️  以下命令会删除所有未被使用的镜像（谨慎！）："
  echo "  # docker image prune -a -f"
  echo
  echo "  # ⚠️  绝对不要执行（会删数据卷）："
  echo "  # docker system prune -a --volumes"
else
  skip "Docker 未安装，跳过"
fi

# ────────────────────────────────────────────────────────────
# 最终：输出变更汇总
# ────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  优化执行完毕 - 变更摘要                                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
grep -E "✅|⚠️|⏭️|变更：" "$CHANGE_LOG" | head -n 60
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  完整变更日志：$CHANGE_LOG"
echo "║  下一步：执行第四阶段验证脚本                            ║"
echo "╚══════════════════════════════════════════════════════════╝"
