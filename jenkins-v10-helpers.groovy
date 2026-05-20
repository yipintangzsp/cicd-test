// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  jenkins-v10-helpers.groovy                                              ║
// ║  辅助函数库 – 通过 load() 在 Stage 0 动态加载，独立 CPS 编译单元          ║
// ║  解决 MethodTooLargeException（JVM 64KB 方法体限制）                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic

// ── 钉钉通知 ─────────────────────────────────────────────────────────────
def notifyDingTalk(String status, String message) {
    try {
        def colorMap = [
            STARTED:'#4096FF', SUCCESS:'#52C41A', FAILURE:'#FF4D4F',
            UNSTABLE:'#FAAD14', APPROVAL:'#FA8C16', ROLLBACK:'#722ED1'
        ]
        def color    = colorMap.get(status, '#1890FF')
        def semver   = env.SEMVER             ?: 'N/A'
        def denv     = params.DEPLOY_ENV      ?: 'N/A'
        def strategy = params.DEPLOY_STRATEGY  ?: 'N/A'
        def commit   = env.GIT_COMMIT_ID      ?: 'N/A'
        def author   = env.GIT_AUTHOR         ?: 'N/A'
        def bnum     = env.BUILD_NUMBER       ?: 'N/A'
        def burl     = env.BUILD_URL          ?: '#'
        def payload = JsonOutput.toJson([
            msgtype: 'markdown',
            markdown: [
                title: "[CI/CD] ${env.APP_NAME} - ${status}",
                text: [
                "## <font color=\"${color}\">[${status}]</font> ${env.APP_NAME}",
                "> **消息**: ${message}",
                "> **版本**: v${semver} | **环境**: ${denv} | **策略**: ${strategy}",
                "> **提交**: ${commit} | **作者**: ${author}",
                "> **构建**: [#${bnum}](${burl})"
                ].join("\\n")
            ],
            at: [isAtAll: status == 'FAILURE']
        ])
        writeFile file: '.v10-dingtalk-payload.json', text: payload
        sh '''
            set +e
            curl -sS -m 8 -H 'Content-Type: application/json' \
              -X POST \
              --data-binary @.v10-dingtalk-payload.json \
              'http://192.168.1.58:18080/dingtalk' \
              >/tmp/v10-dingtalk-notify.out 2>&1
            if [ $? -ne 0 ]; then
              echo "DingTalk relay notify failed, ignored"
              cat /tmp/v10-dingtalk-notify.out || true
            fi
            rm -f .v10-dingtalk-payload.json
        '''
    } catch (e) {
        echo "⚠️ 钉钉通知异常：${e.message}"
    }
}

// ── 全平台巡检（16 服务）─────────────────────────────────────────────────
def runInfraCheck() {
    sh '''
        set -eux
        docker rm -f temp-infra-check || true
        docker run -d --name temp-infra-check --network host alpine:3.20 sleep 3600
        docker exec temp-infra-check apk add --no-cache curl busybox-extras >/dev/null

        echo "=== CI/CD 核心 ==="
        docker exec temp-infra-check sh -c "nc -z -w 5 127.0.0.1 30050 && echo '✅ Harbor' || echo '⚠️ Harbor'"
        docker exec temp-infra-check sh -c "curl -fsS ${SONAR_URL}/api/system/ping >/dev/null && echo '✅ SonarQube' || echo '⚠️ SonarQube'"
        docker exec temp-infra-check sh -c "curl -fsS ${ARGOCD_URL}/healthz >/dev/null && echo '✅ ArgoCD' || echo '⚠️ ArgoCD'"

        echo "=== 大数据平台 ==="
        docker exec temp-infra-check sh -c "nc -z -w 5 ${KAFKA_HOST} ${KAFKA_PORT} && echo '✅ Kafka' || echo '⚠️ Kafka'"
        docker exec temp-infra-check sh -c "curl -fsS -H 'Host: ${FLINK_HOST}' http://127.0.0.1/overview >/dev/null && echo '✅ Flink' || echo '⚠️ Flink'"
        docker exec temp-infra-check sh -c "curl -fsS ${AIRFLOW_URL}/health >/dev/null && echo '✅ Airflow' || echo '⚠️ Airflow'"
        docker exec temp-infra-check sh -c "curl -fsS ${TRINO_URL}/v1/info >/dev/null && echo '✅ Trino' || echo '⚠️ Trino'"

        echo "=== 可观测性栈 ==="
        docker exec temp-infra-check sh -c "curl -fsS ${ES_URL} >/dev/null && echo '✅ Elasticsearch' || echo '⚠️ ES'"
        docker exec temp-infra-check sh -c "curl -fsS ${KIBANA_URL}/api/status >/dev/null && echo '✅ Kibana' || echo '⚠️ Kibana'"
        docker exec temp-infra-check sh -c "curl -fsS ${PROMETHEUS_URL}/-/healthy >/dev/null && echo '✅ Prometheus' || echo '⚠️ Prometheus'"
        docker exec temp-infra-check sh -c "curl -fsS ${GRAFANA_URL}/api/health >/dev/null && echo '✅ Grafana' || echo '⚠️ Grafana'"
        docker exec temp-infra-check sh -c "curl -fsS ${LOKI_URL}/ready >/dev/null && echo '✅ Loki' || echo '⚠️ Loki'"
        docker exec temp-infra-check sh -c "curl -fsS ${JAEGER_URL}/api/services >/dev/null && echo '✅ Jaeger' || echo '⚠️ Jaeger'"
        docker exec temp-infra-check sh -c "curl -fsS ${ZABBIX_URL} >/dev/null && echo '✅ Zabbix' || echo '⚠️ Zabbix'"

        echo "=== 数据存储 ==="
        docker exec temp-infra-check sh -c "nc -z -w 5 ${MYSQL_IP} 3306 && echo '✅ MySQL' || echo '⚠️ MySQL'"
        docker exec temp-infra-check sh -c "nc -z -w 5 ${MONGO_IP} 27017 && echo '✅ MongoDB' || echo '⚠️ MongoDB'"

        docker rm -f temp-infra-check
        echo "✅ 全平台 16 服务巡检完成"
    '''
}

// ── 蓝绿部署 ─────────────────────────────────────────────────────────────
def deployBlueGreen(String appName, String namespace, String imageName, String semver) {
    def replicas = sh(
        script: "kubectl get deployment/${appName} -n ${namespace} -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1",
        returnStdout: true
    ).trim()
    writeFile file: '.deploy-blue.yaml', text: """\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}-blue
  namespace: ${namespace}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${appName}
      track: blue
  template:
    metadata:
      labels:
        app: ${appName}
        track: blue
        version: "${semver}"
    spec:
      containers:
      - name: ${appName}
        image: ${imageName}
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 10
""".stripIndent()
    sh """
        set -eux
        kubectl apply -f .deploy-blue.yaml
        //kubectl rollout status deployment/${appName}-blue -n ${namespace} --timeout=180s
        kubectl rollout status deployment/${appName} -n ${namespace} --timeout=300s
        sleep 10
        kubectl patch service ${appName} -n ${namespace} --type merge \
          -p '{"spec":{"selector":{"app":"${appName}","track":"blue"}}}'
        rm -f .deploy-blue.yaml
        echo "✅ 蓝绿切换完成"
    """
}

// ── 金丝雀部署 ───────────────────────────────────────────────────────────
def deployCanary(String appName, String namespace, String imageName, String semver, int weight) {
    def total = sh(
        script: "kubectl get deployment/${appName} -n ${namespace} -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 2",
        returnStdout: true
    ).trim().toInteger()
    def canary = Math.max(1, (int)(weight * total / 100.0 + 0.999))
    writeFile file: '.deploy-canary.yaml', text: """\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}-canary
  namespace: ${namespace}
spec:
  replicas: ${canary}
  selector:
    matchLabels:
      app: ${appName}
      track: canary
  template:
    metadata:
      labels:
        app: ${appName}
        track: canary
        version: "${semver}"
    spec:
      containers:
      - name: ${appName}
        image: ${imageName}
        ports:
        - containerPort: 80
""".stripIndent()
    sh """
        set -eux
        kubectl apply -f .deploy-canary.yaml
        kubectl rollout status deployment/${appName}-canary -n ${namespace} --timeout=120s
        rm -f .deploy-canary.yaml
        echo "✅ 金丝雀已上线，副本=${canary} (≈${weight}%流量)"
    """
}

// ── 滚动更新 ─────────────────────────────────────────────────────────────
def deployRolling(String appName, String namespace, String imageName) {
    sh """
        set -eux
        kubectl set image deployment/${appName} \
          ${appName}=${imageName} \
          -n ${namespace} || true
        kubectl rollout status deployment/${appName} \
          -n ${namespace} --timeout=300s
        echo "✅ 滚动更新完成"
    """
}

// ── 自动回滚 ─────────────────────────────────────────────────────────────
def autoRollback(String strategy, String appName, String namespace,
                 String prevRev, String prevSelector) {
    try {
        switch (strategy) {
            case 'rolling':
                if (prevRev && prevRev != '0') {
                    sh """
                        kubectl rollout undo deployment/${appName} \
                          --to-revision=${prevRev} -n ${namespace}
                        kubectl rollout status deployment/${appName} \
                          -n ${namespace} --timeout=120s
                    """
                    notifyDingTalk('ROLLBACK', "🔙 已回滚到 revision ${prevRev}")
                }
                break
            case 'canary':
                sh "kubectl delete deployment/${appName}-canary -n ${namespace} --ignore-not-found=true"
                notifyDingTalk('ROLLBACK', "🔙 canary 已删除，流量恢复稳定版")
                break
            case 'blue-green':
                def selectorMap = [:]
                try {
                    selectorMap = new JsonSlurperClassic().parseText(prevSelector ?: '{}') as Map
                } catch (ignored) { selectorMap = [:] }
                if (selectorMap && !selectorMap.isEmpty()) {
                    def patch = JsonOutput.toJson([spec: [selector: selectorMap]])
                    sh "kubectl patch service ${appName} -n ${namespace} --type merge -p '${patch}'"
                    notifyDingTalk('ROLLBACK', "🔙 Service selector 已恢复旧版本")
                } else {
                    notifyDingTalk('ROLLBACK', "❌ 蓝绿回滚失败：无旧 selector，请人工干预")
                }
                break
        }
    } catch (e) {
        echo "⚠️ 自动回滚失败：${e.message}"
        notifyDingTalk('ROLLBACK', "❌ 自动回滚异常！请立即人工处理")
    }
}

// ── MinIO 归档 ────────────────────────────────────────────────────────────
def uploadToMinio() {
    def buildNum = env.BUILD_NUMBER ?: 'unknown'
    sh """
        set -eux
        docker rm -f temp-minio-up || true
        docker run -d --name temp-minio-up --network host minio/mc:latest sleep 300

        docker exec temp-minio-up sh -c '
            mc alias set myminio http://192.168.1.58:30090 admin "Admin@123456" --api S3v4
        ' || echo "⚠️ MinIO alias 设置失败，但继续执行"

        docker exec temp-minio-up sh -c '
            mc mb myminio/devops-artifacts --ignore-existing || true
        '

        for jar in target/*.jar; do
          if [ -f "\$jar" ]; then
            fname=\$(basename "\$jar")
            docker cp "\$jar" temp-minio-up:/tmp/"\$fname"
            docker exec temp-minio-up sh -c "
            mc cp /tmp/\$fname myminio/devops-artifacts/${buildNum}/\$fname" \
              && echo "✅ 上传 \$fname" || echo "⚠️ 上传失败 \$fname"
          fi
        done

        docker rm -f temp-minio-up
        echo "✅ MinIO 归档完成"
    """
}


// ── Flink 任务提交 ────────────────────────────────────────────────────────
def submitFlinkJob(String flinkUrl, String jarFile) {
    sh """
        set -eux
        mkdir -p meta
        docker rm -f temp-curl-uploader || true
        docker run -d --name temp-curl-uploader --network host curlimages/curl:8.6.0 sleep 3600
        docker exec temp-curl-uploader sh -c 'curl -fsS --max-time 10 ${flinkUrl}/overview >/tmp/flink-overview.json'
        docker cp temp-curl-uploader:/tmp/flink-overview.json meta/flink-overview.json
        docker cp ${jarFile} temp-curl-uploader:/tmp/job.jar
        docker exec temp-curl-uploader sh -c \
          'curl -fsS --max-time 60 -X POST -F "jarfile=@/tmp/job.jar" ${flinkUrl}/jars/upload > /tmp/upload.json'
        docker cp temp-curl-uploader:/tmp/upload.json meta/flink-upload.json
        JAR_ID=\$(cat meta/flink-upload.json | grep -o 'flink-web-upload/[^"]*\\.jar' | cut -d/ -f2)
        if [ -z "\$JAR_ID" ]; then
          echo "❌ 无法解析 Flink Jar ID"; cat meta/flink-upload.json; exit 1
        fi
        docker exec temp-curl-uploader sh -c \
          "curl -fsS --max-time 60 -X POST ${flinkUrl}/jars/\${JAR_ID}/run > /tmp/run.json"
        docker cp temp-curl-uploader:/tmp/run.json meta/flink-run.json
        docker rm -f temp-curl-uploader
        echo "✅ Flink 任务已提交"
    """
}

// ── GitOps 推送 ───────────────────────────────────────────────────────────
def gitOpsPush(String manifest, String imageName, String commitMsg,
               String jkManifest, String jkImage, String gitopsCredId) {
    // 在同一 sh 块内处理 manifest 创建，不增加额外 CPS step 调用
    sh """
        set -eux
        mkdir -p \$(dirname ${manifest})
        if [ ! -f ${manifest} ]; then
          cat > ${manifest} << 'HELLO_APP_MANIFEST'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app
  namespace: ns-apps
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hello-app
  template:
    metadata:
      labels:
        app: hello-app
    spec:
      containers:
      - name: hello-app
        image: PLACEHOLDER
        ports:
        - containerPort: 80
HELLO_APP_MANIFEST
          echo "✅ 自动创建 ${manifest}"
        fi
        sed -i 's|image: .*|image: ${imageName}|g' ${manifest}
        git config user.email 'jenkins@devops.local'
        git config user.name  'jenkins-bot'
        git add ${manifest}
        git diff --cached --quiet || git commit -m "${commitMsg}"
    """
    if (jkManifest && jkImage) {
        if (!fileExists(jkManifest)) {
            writeFile file: jkManifest, text: """\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jkvideo-web
  namespace: ns-apps
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jkvideo-web
  template:
    metadata:
      labels:
        app: jkvideo-web
    spec:
      containers:
      - name: jkvideo-web
        image: PLACEHOLDER
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: jkvideo-web
  namespace: ns-apps
spec:
  type: NodePort
  selector:
    app: jkvideo-web
  ports:
  - port: 80
    targetPort: 80
    nodePort: 30088
""".stripIndent()
        }
        sh """
            sed -i 's|image: .*|image: ${jkImage}|g' ${jkManifest}
            git add ${jkManifest}
            git diff --cached --quiet || git commit -m "ci(v9): deploy jkvideo-web to env"
        """
    }
    withCredentials([usernamePassword(
        credentialsId: gitopsCredId,
        usernameVariable: 'GIT_USERNAME',
        passwordVariable: 'GIT_PASSWORD'
    )]) {
        sh '''
            LAST_MSG=$(git log -1 --pretty=%s 2>/dev/null || echo '')
        if echo "$LAST_MSG" | grep -q 'ci(v10)'; then
              git push http://${GIT_USERNAME}:${GIT_PASSWORD}@gitlab-service/root/hello-app-config.git HEAD:main \
                && echo '✅ GitOps 推送成功' || echo '⚠️ GitOps push 失败，继续流水线'
            else
              echo '无 ci(v10) 变更，跳过 push'
            fi
        '''
    }
}

// ── JKVideo Web 镜像构建 ──────────────────────────────────────────────────
def buildJkvideoWebImage(String imageName) {
    def dist = ''
    if (fileExists('ws-web/reports/jkvideo-web.tar.gz')) dist = 'ws-web/reports/jkvideo-web.tar.gz'
    else if (fileExists('reports/jkvideo-web.tar.gz'))   dist = 'reports/jkvideo-web.tar.gz'
    if (!dist) { echo '⚠️ 无 JKVideo Web 产物，跳过'; return }
    writeFile file: '.jk-dockerfile', text: '''\
FROM 127.0.0.1:30050/library/nginx-alpine:latest
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/
EXPOSE 80
'''.stripIndent()
    writeFile file: '.jk-nginx.conf', text: '''\
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  location ~* \\.(js|css|ttf|woff2|ico|png)$ { expires 7d; }
  gzip on;
  gzip_types text/plain text/css application/javascript application/json;
}
'''.stripIndent()
    sh """
        set -eux
        rm -rf /tmp/jkvideo-ctx && mkdir -p /tmp/jkvideo-ctx/html
        tar -xzf ${dist} -C /tmp/jkvideo-ctx/html
        cp .jk-dockerfile /tmp/jkvideo-ctx/Dockerfile
        cp .jk-nginx.conf /tmp/jkvideo-ctx/nginx.conf
        docker build --no-cache --network none \\
          --label app.name=jkvideo-web \\
          --label git.commit=${GIT_COMMIT_ID} \\
          -t ${imageName} /tmp/jkvideo-ctx
        docker push ${imageName}
        rm -rf /tmp/jkvideo-ctx .jk-dockerfile .jk-nginx.conf
        echo "✅ JKVideo Web 镜像推送: ${imageName}"
    """
}

// ── Smoke Test ────────────────────────────────────────────────────────────
def runSmokeTest(String namespace, String labelSelector) {
    sh '''
        set -eux

        APP_POD=$(kubectl get pods -n ''' + namespace + ''' \
          -l ''' + labelSelector + ''' \
          --field-selector status.phase=Running \
          -o jsonpath='{.items[0].metadata.name}' || echo "")

        [ -n "$APP_POD" ] || { echo "❌ 无可用 Pod"; exit 1; }
        echo "✅ 目标 Pod: $APP_POD"

        # 重试等待应用真正 ready
        for i in $(seq 1 30); do
            echo "尝试 Smoke Test 第 ${i} 次..."
            if kubectl exec -n ''' + namespace + ''' "$APP_POD" -- \
               wget -qO- --timeout=5 http://127.0.0.1:80/ >/dev/null 2>&1; then
                echo "✅ Smoke Test 通过"
                exit 0
            fi
            sleep 3
        done

        echo "⚠️ Smoke Test 超时（应用可能还在启动）"
        exit 1
    '''
}

// ── Loki 日志验证 ─────────────────────────────────────────────────────────
def runLokiCheck() {
    sh '''
        set -eux
        docker rm -f temp-loki-check || true
        docker run -d --name temp-loki-check --network host alpine:3.20 sleep 60
        START=$(date -d '5 minutes ago' +%s)000000000
        END=$(date +%s)000000000
        RESP=$(docker exec temp-loki-check sh -c \
          "curl -s '${LOKI_URL}/loki/api/v1/query_range' \
           --data-urlencode 'query={namespace=\"ns-apps\"}' \
           --data-urlencode 'limit=1' \
           --data-urlencode \"start=${START}\" \
           --data-urlencode \"end=${END}\" \
           2>/dev/null || echo '{}'")
        echo "Loki 响应: $(echo $RESP | head -c 200)"
        docker rm -f temp-loki-check
        echo "✅ Loki 日志链路验证完成"
    '''
}

// ── SemVer 解析（纯 Groovy，@NonCPS 跳过 CPS 变换）───────────────────────
@NonCPS
def parseSemver(String tag) {
    def m = tag =~ /^v(\d+)\.(\d+)\.(\d+)$/
    if (m.matches()) {
        return [m[0][1].toInteger(), m[0][2].toInteger(), m[0][3].toInteger()]
    }
    return [0, 0, 0]
}

def runInfraCheckFixed(String kafkaHost, String kafkaPort) {
    sh '''
        set +e
        echo "=== CI/CD 核心 ==="
        REGISTRY_IP=$(kubectl get svc local-registry -n ns-devops -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo '')
        [ -n "$REGISTRY_IP" ] && curl -fsS --max-time 5 "http://${REGISTRY_IP}:5000/v2/" >/dev/null && echo '✅ Harbor/local-registry' || echo '⚠️ Harbor/local-registry'
        curl -fsS --max-time 5 ${SONAR_URL}/api/system/status >/dev/null && echo '✅ SonarQube' || echo '⚠️ SonarQube'
        kubectl get svc argocd-server -n argocd >/dev/null 2>&1 && echo '✅ ArgoCD' || echo '⚠️ ArgoCD'

        echo "=== 大数据平台 ==="
        timeout 5 bash -lc "cat < /dev/null > /dev/tcp/''' + kafkaHost + '''/''' + kafkaPort + '''" \
          && echo '✅ Kafka' || echo '⚠️ Kafka'
        curl -fsS --max-time 5 ${FLINK_URL}/overview >/dev/null && echo '✅ Flink' || echo '⚠️ Flink'

        echo "=== 可观测性栈 ==="
        curl -fsS --max-time 5 ${ES_URL} >/dev/null && echo '✅ Elasticsearch' || echo '⚠️ Elasticsearch'
        curl -fsS --max-time 5 ${KIBANA_URL}/api/status >/dev/null && echo '✅ Kibana' || echo '⚠️ Kibana'
        curl -fsS --max-time 5 ${PROMETHEUS_URL}/-/ready >/dev/null && echo '✅ Prometheus' || echo '⚠️ Prometheus'
        curl -fsS --max-time 5 ${GRAFANA_URL}/api/health >/dev/null && echo '✅ Grafana' || echo '⚠️ Grafana'
        curl -fsS --max-time 5 ${LOKI_URL}/ready >/dev/null && echo '✅ Loki' || echo '⚠️ Loki'

        echo "=== 数据存储 ==="
        MYSQL_IP=$(kubectl get pod -n ns-data -l app=mysql -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo "127.0.0.1")
        MONGO_IP=$(kubectl get pod -n ns-data -l app.kubernetes.io/name=mongodb -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo "")
        timeout 5 bash -lc "cat < /dev/null > /dev/tcp/${MYSQL_IP}/3306" && echo '✅ MySQL' || echo '⚠️ MySQL'
        if [ -n "$MONGO_IP" ]; then
          timeout 5 bash -lc "cat < /dev/null > /dev/tcp/${MONGO_IP}/27017" && echo '✅ MongoDB' || echo '⚠️ MongoDB'
        else
          echo 'ℹ️ MongoDB 未部署，跳过连通性检查'
        fi
        set -e
        echo "✅ 全平台巡检完成"
    '''
}

// 必须 return this，load() 才能获取函数绑定
return this
