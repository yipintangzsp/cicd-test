#!/bin/bash

# 基础持久化根目录
DATA_ROOT="/opt/devops/data"
NAMESPACE="default"

echo "🛡️  Antigravity DevOps 持久化巡检开始..."

# 1. 获取所有 Deployment
DEPLOYS=$(kubectl get deployments -n $NAMESPACE -o name)

for DEPLOY in $DEPLOYS; do
    DEPLOY_NAME=${DEPLOY#deployment.apps/}
    echo "🔍 检查服务: $DEPLOY_NAME"

    # 检查是否有 volumeMounts 且指向了持久化卷 (排除 emptyDir 和 secret/configmap)
    HAS_PERSISTENCE=$(kubectl get $DEPLOY -n $NAMESPACE -o json | jq '.spec.template.spec.volumes // [] | .[] | select(has("hostPath") or has("persistentVolumeClaim"))')

    if [ -z "$HAS_PERSISTENCE" ]; then
        echo "  ⚠️ 警告: $DEPLOY_NAME 尚未配置持久化！"
        
        # 定义该软件的专属目录
        APP_DIR="$DATA_ROOT/$DEPLOY_NAME"
        
        if [ ! -d "$APP_DIR" ]; then
            echo "  📂 正在创建持久化目录: $APP_DIR"
            sudo mkdir -p "$APP_DIR"
            
            # 特殊权限处理 (针对常见 DevOps 软件)
            case "$DEPLOY_NAME" in
                *elasticsearch*) PUID=1000 ;;
                *jenkins*)       PUID=1000 ;;
                *mysql*)         PUID=999  ;;
                *gitlab*)        PUID=0    ;;
                *)               PUID=1000 ;;
            esac
            
            sudo chown -R $PUID:$PUID "$APP_DIR"
            sudo chmod 775 "$APP_DIR"
            echo "  ✅ 目录创建完成，权限已设为 $PUID"
        else
            echo "  ℹ️ 目录 $APP_DIR 已存在，跳过创建。"
        fi

        echo "  📝 请手动更新 $DEPLOY_NAME 的 YAML，加入以下 hostPath 配置:"
        echo "     path: $APP_DIR"
    else
        echo "  ✅ $DEPLOY_NAME 已有持久化配置，安全。"
    fi
done

echo "🏁 巡检结束。请根据提示更新 YAML 文件。"
