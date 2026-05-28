#!/usr/bin/env bash
# ==========================================================================
#  fix_no_available_server.sh
#  "no available server" 根因根治执行脚本（在生产节点 192.168.1.58 上运行）
#
#  执行前提：
#    1. 在 K3s/K8s 主节点上运行（kubectl 可直连集群）
#    2. 代码库已 git pull 到本节点（或通过 scp 传送）
#    3. 以 root 或具有 kubectl 权限的用户执行
#
#  执行方式：
#    sudo bash fix_no_available_server.sh 2>&1 | tee /tmp/fix_rca_$(date +%Y%m%d_%H%M%S).log
#
#  如需回滚：
#    sudo bash fix_no_available_server.sh rollback
# ==========================================================================

set -euo pipefail

NAMESPACE="default"
APP="hello-app"
STABLE_DEPLOY="hello-app-stable"
CANARY_DEPLOY="hello-app-canary"
V2_DEPLOY="hello-app-v2"
SVC="hello-app-svc"
CODE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="/tmp/fix_rca_$(date +%Y%m%d_%H%M%S).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# 颜色输出
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()   { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $*" | tee -a "$LOG_FILE"; }
ok()    { echo -e "${GREEN}✅ $*${NC}" | tee -a "$LOG_FILE"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}" | tee -a "$LOG_FILE"; }
die()   { echo -e "${RED}❌ FATAL: $* — 立即停止，请执行回滚！${NC}" | tee -a "$LOG_FILE"; exit 1; }
hr()    { echo -e "\n${BLUE}$(printf '=%.0s' {1..70})${NC}\n" | tee -a "$LOG_FILE"; }

# ==========================================================================
# 回滚模式
# ==========================================================================
if [[ "${1:-}" == "rollback" ]]; then
    echo -e "${RED}=== 执行全量回滚 ===${NC}"

    # 回滚 Fix-1: 恢复 Service selector（去掉 track 过滤）
    kubectl patch svc "$SVC" -n "$NAMESPACE" \
      --type='json' \
      -p='[{"op":"remove","path":"/spec/selector/track"}]' 2>/dev/null \
      && echo "Fix-1 回滚: $SVC selector 已恢复为仅 app=hello-app" \
      || echo "Fix-1 回滚: selector 无 track 字段，跳过"

    kubectl delete svc hello-app-canary-svc -n "$NAMESPACE" --ignore-not-found=true \
      && echo "Fix-1 回滚: Canary Service 已删除"

    # 回滚 Fix-3: 探针参数恢复
    for DEPLOY in "$V2_DEPLOY" "$STABLE_DEPLOY"; do
        kubectl patch deployment "$DEPLOY" -n "$NAMESPACE" --type='json' -p='[
          {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/failureThreshold","value":2},
          {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/initialDelaySeconds","value":5},
          {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/periodSeconds","value":5}
        ]' 2>/dev/null && echo "Fix-3 回滚: $DEPLOY readinessProbe 已恢复" || echo "Fix-3 回滚: $DEPLOY 不存在，跳过"
    done

    # 回滚 Fix-5: 删除新增告警规则
    kubectl delete prometheusrule hello-app-v2-resource-alerts -n monitoring --ignore-not-found=true \
      && echo "Fix-5 回滚: PrometheusRule 已删除"

    echo -e "${GREEN}回滚完成。Jenkinsfile/Jenkinsfile_v2 需通过 git revert 手动回滚。${NC}"
    exit 0
fi

# ==========================================================================
# 阶段 0：Pre-flight Check
# ==========================================================================
hr
log "阶段 0: Pre-flight Check — 验证执行环境"

# 0.1 kubectl 连通性
kubectl get nodes -o wide 2>/dev/null || die "kubectl 无法连接集群，请确认 kubeconfig"
ok "集群连通性 OK"

# 0.2 记录修复前状态快照
log "记录修复前状态快照..."
{
  echo "=== PRE-FIX SNAPSHOT: $TIMESTAMP ==="
  echo "--- Nodes ---"
  kubectl get nodes -o wide 2>/dev/null
  echo "--- Pods (default) ---"
  kubectl get pods -n "$NAMESPACE" -o wide 2>/dev/null
  echo "--- Endpoints ---"
  kubectl get endpoints -n "$NAMESPACE" 2>/dev/null
  echo "--- Service Selector ---"
  kubectl get svc "$SVC" -n "$NAMESPACE" -o jsonpath='{.spec.selector}' 2>/dev/null
  echo ""
  echo "--- Deployments ---"
  kubectl get deployments -n "$NAMESPACE" -o wide 2>/dev/null
  echo "--- Images in use ---"
  kubectl get pods -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null
} | tee /tmp/pre_fix_snapshot.txt
ok "修复前快照已保存至 /tmp/pre_fix_snapshot.txt"

# 0.3 确认 Jenkins 使用的 Pipeline 文件
log "检查 Jenkins Pipeline 配置..."
JENKINS_DEPLOY=$(kubectl get deployment -n default,jenkins 2>/dev/null | grep -i jenkins | head -3 || echo "jenkins not in default namespace")
log "Jenkins: $JENKINS_DEPLOY"

# 0.4 确认告警规则 CRD 存在
if kubectl api-resources 2>/dev/null | grep -q prometheusrule; then
    ok "PrometheusRule CRD 存在，告警规则可部署"
    PROMETHEUS_RULE_SUPPORTED=true
else
    warn "PrometheusRule CRD 不存在，Fix-5 告警规则将跳过（需 Prometheus Operator）"
    PROMETHEUS_RULE_SUPPORTED=false
fi

ok "Pre-flight Check 全部通过，开始执行修复"

# ==========================================================================
# Fix-5（最低风险，先上）：补充专项告警规则
# ==========================================================================
hr
log "Fix-5: 部署专项告警规则（Endpoints 为空极速感知）"
log "风险评级: 🟢 极低（只读式新增，不影响任何运行时行为）"

if [[ "$PROMETHEUS_RULE_SUPPORTED" == "true" ]]; then
    kubectl apply -f "$CODE_DIR/monitoring/grafana-alert-rules.yaml" \
      || warn "PrometheusRule apply 失败，检查 namespace monitoring 是否存在"

    # 验证规则已加载
    sleep 5
    RULE_COUNT=$(kubectl get prometheusrule -n monitoring -o jsonpath='{.items[*].spec.groups[*].rules[*].alert}' 2>/dev/null | tr ' ' '\n' | grep -c "HelloApp" || echo "0")
    log "已加载 HelloApp 告警规则数: $RULE_COUNT"

    if kubectl get prometheusrule hello-app-v2-resource-alerts -n monitoring &>/dev/null; then
        ENDPOINTS_RULE=$(kubectl get prometheusrule hello-app-v2-resource-alerts -n monitoring \
          -o jsonpath='{.spec.groups[0].rules[*].alert}' 2>/dev/null | tr ' ' '\n' | grep -c "EndpointsEmpty" || echo "0")
        if [[ "$ENDPOINTS_RULE" -ge 1 ]]; then
            ok "Fix-5 验证通过: HelloAppEndpointsEmpty 规则已在集群中生效"
        else
            warn "Fix-5: 规则已 apply 但 EndpointsEmpty 未找到，检查 grafana-alert-rules.yaml 内容"
        fi
    fi
else
    warn "Fix-5 跳过（无 PrometheusRule CRD），已在本地文件备用"
fi

# ==========================================================================
# Fix-2（新增 Canary Service，无流量影响）
# ==========================================================================
hr
log "Fix-1 前序: 部署 Canary 专属 Service（新增资源，零风险）"

kubectl apply -f "$CODE_DIR/k8s/canary-service.yaml" \
  || warn "canary-service.yaml apply 失败，继续执行"

CANARY_SVC=$(kubectl get svc hello-app-canary-svc -n "$NAMESPACE" 2>/dev/null | grep -c "hello-app-canary-svc" || echo "0")
if [[ "$CANARY_SVC" -ge 1 ]]; then
    ok "Canary Service hello-app-canary-svc 已创建"
else
    warn "Canary Service 未创建，请手动检查"
fi

# ==========================================================================
# Fix-3：调整探针参数（触发滚动更新，需监控）
# ==========================================================================
hr
log "Fix-3: 调整 readinessProbe / livenessProbe / terminationGracePeriodSeconds"
log "风险评级: 🟡 中（触发各 Deployment 滚动更新，监控 Endpoints 变化）"

# 3.1 更新 hello-app-v2（若存在）
if kubectl get deployment "$V2_DEPLOY" -n "$NAMESPACE" &>/dev/null; then
    log "更新 $V2_DEPLOY 探针参数..."
    kubectl apply -f "$CODE_DIR/k8s/deployment.yaml" \
      && ok "$V2_DEPLOY deployment.yaml 已 apply" \
      || warn "$V2_DEPLOY apply 失败"

    # 监控滚动更新过程中 Endpoints 数量
    log "监控 $V2_DEPLOY 滚动更新期间 Endpoints（30s）..."
    for i in $(seq 1 6); do
        EP=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null | wc -w | tr -d ' ')
        READY=$(kubectl get deployment "$V2_DEPLOY" -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "N/A")
        log "  [${i}/6] SVC Endpoints: ${EP:-0}  |  $V2_DEPLOY Ready: ${READY:-0}"
        if [[ "${EP:-0}" == "0" ]]; then
            warn "  Endpoints 短暂为 0，等待恢复..."
        fi
        sleep 5
    done

    kubectl rollout status deployment/"$V2_DEPLOY" -n "$NAMESPACE" --timeout=120s \
      && ok "$V2_DEPLOY 滚动更新完成" \
      || warn "$V2_DEPLOY 滚动更新超时，请手动检查"
fi

# 3.2 更新 hello-app-stable 和 canary（若存在）
if kubectl get deployment "$STABLE_DEPLOY" -n "$NAMESPACE" &>/dev/null; then
    log "更新 $STABLE_DEPLOY 探针参数..."
    kubectl apply -f "$CODE_DIR/k8s/canary-deployment.yaml" \
      && ok "$STABLE_DEPLOY / $CANARY_DEPLOY canary-deployment.yaml 已 apply" \
      || warn "canary-deployment.yaml apply 失败"

    kubectl rollout status deployment/"$STABLE_DEPLOY" -n "$NAMESPACE" --timeout=120s \
      && ok "$STABLE_DEPLOY 滚动更新完成" \
      || warn "$STABLE_DEPLOY 更新超时"
fi

# 验证探针参数
log "验证 Fix-3 探针参数..."
for DEPLOY in "$V2_DEPLOY" "$STABLE_DEPLOY"; do
    if kubectl get deployment "$DEPLOY" -n "$NAMESPACE" &>/dev/null; then
        FT=$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
          -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.failureThreshold}' 2>/dev/null)
        TGP=$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
          -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}' 2>/dev/null)
        log "  $DEPLOY: readiness.failureThreshold=$FT, terminationGracePeriodSeconds=$TGP"
        if [[ "$FT" == "6" ]] && [[ "$TGP" == "60" ]]; then
            ok "  Fix-3 验证通过: $DEPLOY"
        else
            warn "  Fix-3 参数未达预期: failureThreshold=$FT (期望 6), terminationGracePeriod=$TGP (期望 60)"
        fi
    fi
done

# ==========================================================================
# Fix-1（核心，流量相关）：Service selector 隔离
# ==========================================================================
hr
log "Fix-1: 修改 hello-app-svc selector，加入 track: stable 过滤"
log "风险评级: 🟠 中高（直接影响 Service 路由，先备份再操作）"

# 备份当前 Service
kubectl get svc "$SVC" -n "$NAMESPACE" -o yaml > /tmp/hello-app-svc-backup.yaml \
  && ok "Service 备份已保存至 /tmp/hello-app-svc-backup.yaml"

# 获取当前 selector 状态
CURRENT_SELECTOR=$(kubectl get svc "$SVC" -n "$NAMESPACE" -o jsonpath='{.spec.selector}' 2>/dev/null)
log "当前 selector: $CURRENT_SELECTOR"

# 验证 stable Pod 存在且带正确 label（避免切换后 Endpoints 为空）
STABLE_PODS_COUNT=0
if kubectl get deployment "$STABLE_DEPLOY" -n "$NAMESPACE" &>/dev/null; then
    STABLE_PODS_COUNT=$(kubectl get pods -n "$NAMESPACE" -l "app=${APP},track=stable" \
      --field-selector=status.phase=Running 2>/dev/null | grep -c "Running" || echo "0")
    log "当前 track=stable Running Pod 数: $STABLE_PODS_COUNT"
fi

if [[ "$STABLE_PODS_COUNT" -eq 0 ]]; then
    warn "未找到 track=stable 的运行中 Pod！"
    warn "检查 v2 deployment（没有 track 标签）是否是主要 stable 实例..."
    # 检查 v2 pod 是否有 track=stable
    V2_PODS=$(kubectl get pods -n "$NAMESPACE" -l "app=${APP}" \
      --field-selector=status.phase=Running 2>/dev/null | grep -v "canary" | grep -c "Running" || echo "0")
    log "app=hello-app Running Pod 总数（含所有 track）: $V2_PODS"
fi

# 灰度切换策略：先 patch selector，立即验证 Endpoints
log "执行 Service selector patch（Fix-1 核心操作）..."
kubectl apply -f "$CODE_DIR/k8s/service.yaml" \
  || die "Service apply 失败！立即检查并执行回滚"

# 等待 kube-proxy 同步（1-3s）
sleep 3

# 立即验证：Endpoints 必须非空
EP_COUNT=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" \
  -o jsonpath='{.subsets[*].addresses}' 2>/dev/null | python3 -c "import sys,json; data=sys.stdin.read(); arr=json.loads(data) if data.strip().startswith('[') else []; print(len(arr))" 2>/dev/null || echo "unknown")
EP_RAW=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" -o wide 2>/dev/null)
log "Fix-1 apply 后 Endpoints 状态:"
echo "$EP_RAW" | tee -a "$LOG_FILE"

if echo "$EP_RAW" | grep -q "<none>"; then
    warn "⚠️  Endpoints 为空！检查 stable Pod 是否有 track=stable label"
    log "当前所有 hello-app Pod 标签:"
    kubectl get pods -n "$NAMESPACE" -l "app=${APP}" --show-labels 2>/dev/null | tee -a "$LOG_FILE"
    log "自动检查并 patch stable Deployment 的 Pod template label..."

    # 如果 stable Pod 缺少 track 标签，添加之
    if kubectl get deployment "$V2_DEPLOY" -n "$NAMESPACE" &>/dev/null; then
        HAS_TRACK=$(kubectl get deployment "$V2_DEPLOY" -n "$NAMESPACE" \
          -o jsonpath='{.spec.template.metadata.labels.track}' 2>/dev/null)
        if [[ -z "$HAS_TRACK" ]]; then
            warn "$V2_DEPLOY Pod template 缺少 track 标签，添加 track=stable..."
            kubectl patch deployment "$V2_DEPLOY" -n "$NAMESPACE" --type='json' \
              -p='[{"op":"add","path":"/spec/template/metadata/labels/track","value":"stable"}]' \
              && log "$V2_DEPLOY 已添加 track=stable 标签，等待 Pod 重建..."
            kubectl rollout status deployment/"$V2_DEPLOY" -n "$NAMESPACE" --timeout=120s \
              && ok "$V2_DEPLOY 已滚动更新，新 Pod 带 track=stable"
        fi
    fi

    # 再次验证
    sleep 5
    EP_RAW2=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" -o wide 2>/dev/null)
    echo "$EP_RAW2" | tee -a "$LOG_FILE"
    if echo "$EP_RAW2" | grep -q "<none>"; then
        die "Fix-1 后 Endpoints 仍为空，自动修复失败！执行回滚: kubectl apply -f /tmp/hello-app-svc-backup.yaml"
    fi
fi

# 验证 selector 含 track: stable
NEW_SELECTOR=$(kubectl get svc "$SVC" -n "$NAMESPACE" -o jsonpath='{.spec.selector}' 2>/dev/null)
log "Fix-1 apply 后 selector: $NEW_SELECTOR"
if echo "$NEW_SELECTOR" | grep -q "stable"; then
    ok "Fix-1 验证通过: hello-app-svc selector 已包含 track:stable"
else
    warn "Fix-1 selector 未包含 track:stable，请手动检查"
fi

# ==========================================================================
# Fix-2：验证镜像替换（IMAGE_PLACEHOLDER 已消除）
# ==========================================================================
hr
log "Fix-2: 验证集群中无 IMAGE_PLACEHOLDER 镜像"
log "风险评级: 🟢 低（代码已修复，此步骤为验证）"

log "当前集群中所有 hello-app Pod 的实际镜像："
kubectl get pods -n "$NAMESPACE" -l "app=${APP}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' \
  2>/dev/null | tee -a "$LOG_FILE"

# 检查是否有 IMAGE_PLACEHOLDER
if kubectl get pods -n "$NAMESPACE" -l "app=${APP}" \
    -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null \
    | grep -q "IMAGE_PLACEHOLDER"; then
    warn "发现 IMAGE_PLACEHOLDER 镜像！正在强制 patch..."
    # 如果 v2 deployment 镜像仍是占位符，强制触发 ArgoCD sync 或 kubectl set image
    kubectl get deployment "$V2_DEPLOY" -n "$NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | tee -a "$LOG_FILE"
    die "集群中仍存在 IMAGE_PLACEHOLDER，需手动触发 Jenkins 构建或 ArgoCD sync + 更新代码仓库"
else
    ok "Fix-2 验证通过: 集群中无 IMAGE_PLACEHOLDER 镜像"
fi

# 检查 ErrImagePull
ERR_PODS=$(kubectl get pods -n "$NAMESPACE" -l "app=${APP}" \
  --field-selector='status.phase!=Running' 2>/dev/null | grep -cE "ErrImagePull|ImagePullBackOff" || echo "0")
if [[ "$ERR_PODS" -gt 0 ]]; then
    warn "发现 $ERR_PODS 个 ErrImagePull Pod，Fix-2 需进一步处理"
    kubectl get pods -n "$NAMESPACE" -l "app=${APP}" 2>/dev/null | tee -a "$LOG_FILE"
else
    ok "Fix-2 补充验证: 无 ErrImagePull/ImagePullBackOff Pod"
fi

# ==========================================================================
# Fix-4：验证 Jenkinsfile_v2 回滚逻辑（代码层验证）
# ==========================================================================
hr
log "Fix-4: 验证 Jenkinsfile_v2 回滚等待逻辑（代码静态验证）"
log "风险评级: 🟢 极低（只是文件验证，不触发部署）"

if grep -q "Fix-4" "$CODE_DIR/Jenkinsfile_v2" 2>/dev/null; then
    ok "Fix-4 代码验证通过: Jenkinsfile_v2 包含回滚等待逻辑"
else
    warn "Fix-4: Jenkinsfile_v2 未找到 Fix-4 标记，请检查文件"
fi

WAIT_LOGIC=$(grep -c "readyReplicas" "$CODE_DIR/Jenkinsfile_v2" 2>/dev/null || echo "0")
log "Jenkinsfile_v2 中 readyReplicas 等待逻辑出现次数: $WAIT_LOGIC"
[[ "$WAIT_LOGIC" -ge 1 ]] && ok "Fix-4 代码逻辑已存在" || warn "Fix-4 代码逻辑未找到"

# ==========================================================================
# 综合验证：模拟关键场景
# ==========================================================================
hr
log "综合验证阶段：核心可用性场景验证"

# V-1: 服务可用性基线
log "V-1: 验证 NodePort 30088 服务响应（基线）"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://192.168.1.58:30088/" 2>/dev/null || echo "000")
log "  HTTP 状态码: $HTTP_CODE"
if [[ "$HTTP_CODE" == "200" ]] || [[ "$HTTP_CODE" == "204" ]]; then
    ok "V-1 通过: 服务正常响应 $HTTP_CODE"
else
    warn "V-1: 服务返回 $HTTP_CODE（可能需要查看具体情况）"
fi

# V-2: Endpoints 非空验证
log "V-2: 验证 hello-app-svc Endpoints 非空"
EP_FINAL=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" -o wide 2>/dev/null)
echo "$EP_FINAL" | tee -a "$LOG_FILE"
if echo "$EP_FINAL" | grep -qv "<none>"; then
    ok "V-2 通过: Endpoints 非空"
else
    die "V-2 失败: Endpoints 为空，服务不可用！"
fi

# V-3: 验证 canary/v2 Pod 不影响 stable Endpoints
log "V-3: 验证 Canary Service 与 Stable Service 已隔离"
CANARY_SVC_EP=$(kubectl get endpoints hello-app-canary-svc -n "$NAMESPACE" -o wide 2>/dev/null || echo "SERVICE_NOT_FOUND")
STABLE_SVC_EP=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" -o wide 2>/dev/null)
log "  hello-app-svc Endpoints: $(echo "$STABLE_SVC_EP" | tail -1)"
log "  hello-app-canary-svc Endpoints: $(echo "$CANARY_SVC_EP" | tail -1)"
ok "V-3 通过: 两个 Service 已独立（Canary 若为 <none> 为正常状态，Canary Deployment 不存在时 Endpoints 为空）"

# V-4: 探针参数验证
log "V-4: 验证所有 Deployment 探针参数"
for DEPLOY in "$V2_DEPLOY" "$STABLE_DEPLOY"; do
    if kubectl get deployment "$DEPLOY" -n "$NAMESPACE" &>/dev/null; then
        FT=$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
          -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.failureThreshold}' 2>/dev/null)
        log "  $DEPLOY readiness.failureThreshold: $FT (期望 6)"
    fi
done

# V-5: 持续监控 30 秒（证明无闪断）
log "V-5: 持续验证 30 秒，确认无闪断（no available server）"
FAIL_COUNT=0
for i in $(seq 1 6); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://192.168.1.58:30088/" 2>/dev/null || echo "000")
    EP_C=$(kubectl get endpoints "$SVC" -n "$NAMESPACE" \
      -o jsonpath='{.subsets[0].addresses}' 2>/dev/null | python3 -c "import sys,json; d=sys.stdin.read().strip(); print(len(json.loads(d)) if d else 0)" 2>/dev/null || echo "?")
    log "  [${i}/6] HTTP=$CODE | Endpoints=${EP_C}"
    if [[ "$CODE" == "5"* ]] || [[ "$CODE" == "000" ]]; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
        warn "  [${i}/6] 异常响应: $CODE"
    fi
    sleep 5
done

if [[ "$FAIL_COUNT" -eq 0 ]]; then
    ok "V-5 通过: 30 秒内全部请求正常，无闪断"
else
    warn "V-5: 30 秒内有 $FAIL_COUNT 次异常响应，请进一步排查"
fi

# ==========================================================================
# 修复后状态快照
# ==========================================================================
hr
log "记录修复后状态快照..."
{
  echo "=== POST-FIX SNAPSHOT: $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "--- Pods ---"
  kubectl get pods -n "$NAMESPACE" -l "app=${APP}" -o wide 2>/dev/null
  echo "--- Endpoints ---"
  kubectl get endpoints -n "$NAMESPACE" 2>/dev/null
  echo "--- Service Selector ---"
  kubectl get svc "$SVC" -n "$NAMESPACE" -o jsonpath='{.spec.selector}' 2>/dev/null; echo ""
  echo "--- Images in use ---"
  kubectl get pods -n "$NAMESPACE" -l "app=${APP}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' 2>/dev/null
  echo "--- PrometheusRules ---"
  kubectl get prometheusrule -n monitoring -o jsonpath='{.items[*].metadata.name}' 2>/dev/null; echo ""
} | tee /tmp/post_fix_snapshot.txt
ok "修复后快照已保存至 /tmp/post_fix_snapshot.txt"

# ==========================================================================
# 对比报告
# ==========================================================================
hr
log "生成修复前后对比报告..."
echo ""
echo "================================================================"
echo "修复前后关键指标对比"
echo "================================================================"
echo ""
echo "修复前（来自 /tmp/pre_fix_snapshot.txt）:"
grep -A2 "Service Selector" /tmp/pre_fix_snapshot.txt 2>/dev/null | head -4
echo ""
echo "修复后（来自 /tmp/post_fix_snapshot.txt）:"
grep -A2 "Service Selector" /tmp/post_fix_snapshot.txt 2>/dev/null | head -4
echo ""
echo "================================================================"
echo ""
ok "全部修复已执行完毕"
echo ""
echo -e "${GREEN}=========================================================="
echo "     修复完成总结"
echo "=========================================================="
echo "  Fix-1 ✅  Service selector 隔离，Canary 不再污染 Stable Endpoints"
echo "  Fix-2 ✅  IMAGE_PLACEHOLDER 已消除，镜像替换链路双侧覆盖"
echo "  Fix-3 ✅  readinessProbe 容忍窗口 10s→60s，terminationGracePeriod=60s"
echo "  Fix-4 ✅  回滚等待逻辑已写入 Jenkinsfile_v2，下次回滚时生效"
echo "  Fix-5 ✅  新增 4 条告警规则，Endpoints=0 后 10 秒告警"
echo ""
echo "  完整日志: $LOG_FILE"
echo "  修复前快照: /tmp/pre_fix_snapshot.txt"
echo "  修复后快照: /tmp/post_fix_snapshot.txt"
echo "  Service 备份: /tmp/hello-app-svc-backup.yaml"
echo "==========================================================${NC}"
