def run(ctx, p) {
    ctx.withEnv([
        "SCRIPT_NAME=gh-release-r2",
        "APP_NAME=hello-app",
        "REGISTRY=127.0.0.1:30050",
        "CONFIG_REPO_URL=http://gitlab-service/root/hello-app-config.git",
        "TRIVY_VER=0.68.2",
        "MAVEN_IMAGE=maven:3-eclipse-temurin-17",
        "SONAR_URL=http://sonar.devops.local",
        "TRIVY_DB_REPO=127.0.0.1:30050/aquasecurity/trivy-db:2",
        "GITOPS_CREDENTIALS=gitlab-root-auth",
        "KAFKA_NS=ns-bigdata",
        "KAFKA_POD=kafka-0",
        "KAFKA_PORT=9092",
        "ES_URL=http://192.168.1.58:30092",
        "FLINK_HOST=flink.devops.local",
        "MAVEN_CACHE=/root/.m2"
    ]) {
        try {

            ctx.stage('0. 初始化上下文') {
                ctx.script {
                    ctx.env.GIT_COMMIT_ID = ctx.sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    ctx.env.GIT_BRANCH_NAME = ctx.sh(script: '(git symbolic-ref --short -q HEAD || echo main)', returnStdout: true).trim()
                    ctx.env.IMAGE_NAME = "${ctx.env.REGISTRY}/${ctx.env.APP_NAME}:${ctx.env.GIT_COMMIT_ID}"
                    ctx.env.BUILD_META_FILE = "meta/build-info.json"
                    ctx.env.PREVIOUS_IMAGE = ""
                    ctx.env.GITOPS_MANIFEST_PATH = ""

                    ctx.currentBuild.displayName = "#${ctx.env.BUILD_NUMBER} ${p.DEPLOY_ENV} ${ctx.env.GIT_COMMIT_ID}"
                    ctx.currentBuild.description = "branch=${ctx.env.GIT_BRANCH_NAME}, image=${ctx.env.IMAGE_NAME}, dryRun=${p.DRY_RUN}, script=${ctx.env.SCRIPT_NAME}"

                    ctx.sh """
                        mkdir -p meta reports
                        cat > meta/build-info.json <<EOF
{
  "build_number": "${ctx.env.BUILD_NUMBER}",
  "deploy_env": "${p.DEPLOY_ENV}",
  "git_commit": "${ctx.env.GIT_COMMIT_ID}",
  "git_branch": "${ctx.env.GIT_BRANCH_NAME}",
  "image_name": "${ctx.env.IMAGE_NAME}",
  "script_name": "${ctx.env.SCRIPT_NAME}",
  "dry_run": "${p.DRY_RUN}",
  "build_url": "${ctx.env.BUILD_URL}"
}
EOF
                    """

                    ctx.stash name: 'workspace-src', includes: '**/*', excludes: '.git/**, target/**, config-repo/**,.trivycache/**', useDefaultExcludes: false
                }
            }

            ctx.stage('1. 执行前预检') {
                ctx.unstash 'workspace-src'
                ctx.sh '''
                    set -eux
                    test -f Dockerfile
                    docker version
                    kubectl version --client
                    git --version

                    echo "🔍 预检：检查必要文件"
                    ls -lah

                    if [ ! -f "pom.xml" ]; then
                      echo "⚠️ 未找到 pom.xml，将只执行非 Maven 构建相关逻辑"
                    fi

                    echo "🔍 预检：检查目标命名空间"
                    kubectl get ns ${K8S_NAMESPACE} >/dev/null
                '''
            }

            ctx.stage('2. 并行质量关卡') {
                Map jobs = [:]

                jobs['2.1 源码脱敏审计 (Trivy FS)'] = {
                    if (!p.SKIP_SECURITY_SCAN) {
                        ctx.unstash 'workspace-src'
                        ctx.sh '''
                            set -eux
                            docker rm -f temp-trivy-fs || true
                            docker run -d --name temp-trivy-fs --entrypoint /bin/sh -w /work aquasec/trivy:${TRIVY_VER} -c 'sleep 3600'
                            docker cp . temp-trivy-fs:/work
                            mkdir -p reports
                            docker exec temp-trivy-fs trivy fs /work --scanners secret --format table > reports/trivy-fs.txt
                            docker rm -f temp-trivy-fs
                        '''
                    } else {
                        ctx.echo 'SKIP_SECURITY_SCAN=true，跳过 Trivy FS'
                    }
                }

                jobs['2.2 源码质量审计 (SonarQube)'] = {
                    if (!p.SKIP_SECURITY_SCAN) {
                        ctx.unstash 'workspace-src'
                        ctx.withCredentials([ctx.string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                            ctx.sh '''
                                set -eux
                                mkdir -p reports
                                if [ -f "pom.xml" ]; then
                                  docker rm -f temp-sonar-scan || true
                                  docker run -d --name temp-sonar-scan --network host -v ${MAVEN_CACHE}:/root/.m2 -w /usr/src ${MAVEN_IMAGE} sleep 3600
                                  docker cp . temp-sonar-scan:/usr/src/
                                  docker exec temp-sonar-scan mvn -B -U compile org.sonarsource.scanner.maven:sonar-maven-plugin:4.0.0.4121:sonar \
                                    -Dsonar.host.url=${SONAR_URL} \
                                    -Dsonar.token=${SONAR_TOKEN} \
                                    -Dsonar.projectKey=${APP_NAME} \
                                    -Dsonar.sources=. \
                                    -Dsonar.exclusions=/*.js,/*.html
                                  docker cp temp-sonar-scan:/usr/src/target/sonar/report-task.txt reports/sonar-report-task.txt || true
                                  docker rm -f temp-sonar-scan
                                else
                                  echo "⚠️ 未检测到 pom.xml，跳过 SonarQube"
                                fi
                            '''
                        }
                    } else {
                        ctx.echo 'SKIP_SECURITY_SCAN=true，跳过 SonarQube'
                    }
                }

                jobs['2.3 单元测试 (JUnit)'] = {
                    if (p.RUN_UNIT_TESTS) {
                        ctx.unstash 'workspace-src'
                        ctx.sh '''
                            set -eux
                            if [ -f "pom.xml" ]; then
                              docker rm -f temp-maven-test || true
                              docker run -d --name temp-maven-test -v ${MAVEN_CACHE}:/root/.m2 -w /usr/src ${MAVEN_IMAGE} sleep 3600
                              docker cp . temp-maven-test:/usr/src/
                              docker exec temp-maven-test mvn -B -U test
                              mkdir -p target
                              docker cp temp-maven-test:/usr/src/target target || true
                              docker rm -f temp-maven-test
                            else
                              echo "⚠️ 未检测到 pom.xml，跳过单元测试"
                            fi
                        '''
                    } else {
                        ctx.echo 'RUN_UNIT_TESTS=false，跳过单元测试'
                    }
                }

                ctx.parallel jobs

                ctx.script {
                    def junitFile = ctx.sh(
                        script: "find target -path '*/surefire-reports/*.xml' 2>/dev/null | head -n 1",
                        returnStdout: true
                    ).trim()

                    if (junitFile) {
                        ctx.junit allowEmptyResults: true, testResults: 'target/**/surefire-reports/*.xml'
                    } else {
                        ctx.echo 'ℹ️ 未发现 JUnit XML 报告，跳过 junit 收集'
                    }
                }
            }

            ctx.stage('2.4 Sonar 质量门禁等待') {
                if (!p.SKIP_SECURITY_SCAN) {
                    ctx.withCredentials([ctx.string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                        ctx.sh '''
                            set -eux
                            TASK_FILE=reports/sonar-report-task.txt

                            if [ ! -f "$TASK_FILE" ]; then
                              echo "⚠️ 未找到 Sonar report-task.txt，跳过质量门禁轮询"
                              exit 0
                            fi

                            CE_TASK_URL=$(grep '^ceTaskUrl=' "$TASK_FILE" | cut -d= -f2-)
                            if [ -z "$CE_TASK_URL" ]; then
                              echo "⚠️ 未解析到 ceTaskUrl，跳过质量门禁轮询"
                              exit 0
                            fi

                            i=0
                            STATUS="PENDING"
                            ANALYSIS_ID=""

                            while [ "$i" -lt 30 ]; do
                              CE_JSON=$(curl -fsS -u ${SONAR_TOKEN}: "$CE_TASK_URL")
                              STATUS=$(echo "$CE_JSON" | grep -o '"status":"[^"]*"' | head -n1 | cut -d'"' -f4)
                              ANALYSIS_ID=$(echo "$CE_JSON" | grep -o '"analysisId":"[^"]*"' | head -n1 | cut -d'"' -f4 || true)

                              echo "Sonar CE status=$STATUS"

                              if [ "$STATUS" = "SUCCESS" ]; then
                                break
                              fi

                              if [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "CANCELED" ]; then
                                echo "$CE_JSON" > reports/sonar-ce-task.json
                                echo "❌ Sonar CE task failed"
                                exit 1
                              fi

                              i=$((i+1))
                              sleep 5
                            done

                            if [ "$STATUS" != "SUCCESS" ]; then
                              echo "❌ Sonar Quality Gate wait timeout"
                              exit 1
                            fi

                            if [ -z "$ANALYSIS_ID" ]; then
                              echo "❌ Sonar analysisId 为空"
                              exit 1
                            fi

                            curl -fsS -u ${SONAR_TOKEN}: "${SONAR_URL}/api/qualitygates/project_status?analysisId=${ANALYSIS_ID}" > reports/sonar-quality-gate.json
                            GATE_STATUS=$(grep -o '"status":"[^"]*"' reports/sonar-quality-gate.json | head -n1 | cut -d'"' -f4)

                            echo "Sonar Quality Gate=$GATE_STATUS"
                            [ "$GATE_STATUS" = "OK" ]
                        '''
                    }
                } else {
                    ctx.echo 'SKIP_SECURITY_SCAN=true，跳过 Sonar 质量门禁'
                }
            }

            ctx.stage('3. 产物构建 (Maven Build)') {
                ctx.unstash 'workspace-src'
                ctx.sh '''
                    set -eux
                    if [ -f "pom.xml" ]; then
                      docker rm -f temp-maven-build || true
                      docker run -d --name temp-maven-build -v ${MAVEN_CACHE}:/root/.m2 -w /usr/src ${MAVEN_IMAGE} sleep 3600
                      docker cp . temp-maven-build:/usr/src/
                      docker exec temp-maven-build mvn -B -U clean package -DskipTests
                      rm -rf target
                      docker cp temp-maven-build:/usr/src/target .
                      docker rm -f temp-maven-build
                    else
                      echo "⚠️ 未检测到 pom.xml，跳过 Maven 打包"
                    fi
                '''
            }

            ctx.stage('4. 产物校验与摘要') {
                ctx.sh '''
                    set -eux
                    mkdir -p meta
                    if ls target/*.jar >/dev/null 2>&1; then
                      sha256sum target/*.jar | tee meta/artifact.sha256
                      ls -lah target/*.jar | tee meta/artifact.list
                    else
                      echo "no-jar-found" | tee meta/artifact.list
                    fi
                '''
            }

            ctx.stage('5. 业务镜像入库 (Docker Push)') {
                ctx.sh '''
                    set -eux
                    docker build --no-cache \
                      --label app.name=${APP_NAME} \
                      --label git.commit=${GIT_COMMIT_ID} \
                      --label git.branch=${GIT_BRANCH_NAME} \
                      --label build.number=${BUILD_NUMBER} \
                      -t ${IMAGE_NAME} .
                    if [ "${DRY_RUN}" = "false" ]; then
                      docker push ${IMAGE_NAME}
                    else
                      echo "DRY_RUN=true，跳过 docker push"
                    fi
                '''
            }

            ctx.stage('5.1 镜像元数据快照') {
                ctx.sh '''
                    set -eux
                    mkdir -p meta
                    docker inspect ${IMAGE_NAME} > meta/image-inspect.json
                '''
            }

            ctx.stage('6. 质量红线卡点 (Trivy Image)') {
                if (!p.SKIP_SECURITY_SCAN) {
                    ctx.sh '''
                        set -eux
                        mkdir -p reports .trivycache

                        docker run --rm --network host \
                          -v /var/run/docker.sock:/var/run/docker.sock \
                          -v "$PWD":/work -w /work \
                          -v "$PWD/.trivycache":/root/.cache/ \
                          aquasec/trivy:${TRIVY_VER} image \
                          --db-repository ${TRIVY_DB_REPO} \
                          --skip-version-check \
                          --exit-code 1 \
                          --severity CRITICAL,HIGH \
                          --format table \
                          --output reports/trivy-image.txt \
                          ${IMAGE_NAME}
                    '''
                } else {
                    ctx.echo 'SKIP_SECURITY_SCAN=true，跳过 Trivy Image'
                }
            }

            ctx.stage('6.1 镜像 SBOM 导出') {
                if (!p.SKIP_SECURITY_SCAN) {
                    ctx.sh '''
                        set -eux
                        mkdir -p reports .trivycache

                        docker run --rm --network host \
                          -v /var/run/docker.sock:/var/run/docker.sock \
                          -v "$PWD":/work -w /work \
                          -v "$PWD/.trivycache":/root/.cache/ \
                          aquasec/trivy:${TRIVY_VER} image \
                          --db-repository ${TRIVY_DB_REPO} \
                          --skip-version-check \
                          --format cyclonedx \
                          --output reports/trivy-image-sbom.json \
                          ${IMAGE_NAME}
                    '''
                } else {
                    ctx.echo 'SKIP_SECURITY_SCAN=true，跳过 SBOM 导出'
                }
            }

            ctx.stage('7. 基建健康度巡检 (Kafka / ES / Registry / Flink)') {
                ctx.script {
                    def kafkaHost = ctx.sh(
                        script: "kubectl get pod ${ctx.env.KAFKA_POD} -n ${ctx.env.KAFKA_NS} -o jsonpath='{.status.podIP}'",
                        returnStdout: true
                    ).trim()

                    if (!kafkaHost) {
                        ctx.error("🚨 无法获取 Kafka Pod IP，巡检中断")
                    }

                    ctx.env.KAFKA_HOST = kafkaHost

                    ctx.sh '''
                        set -eux
                        docker rm -f temp-infra-check || true
                        docker run -d --name temp-infra-check --network host alpine:3.20 sleep 3600
                        docker exec temp-infra-check sh -c "apk add --no-cache curl busybox-extras >/dev/null"

                        echo "👉 检查 Elasticsearch: ${ES_URL}"
                        docker exec temp-infra-check sh -c "curl -fsS ${ES_URL} >/dev/null"

                        echo "👉 检查 Kafka: ${KAFKA_HOST}:${KAFKA_PORT}"
                        docker exec temp-infra-check sh -c "nc -z -w 5 ${KAFKA_HOST} ${KAFKA_PORT}"

                        echo "👉 检查 Registry: ${REGISTRY}"
                        docker exec temp-infra-check sh -c "nc -z -w 5 127.0.0.1 30050"

                        echo "👉 检查 Flink Host Header 入口"
                        docker exec temp-infra-check sh -c "curl -fsS -H 'Host: ${FLINK_HOST}' http://127.0.0.1/overview >/dev/null || true"

                        docker rm -f temp-infra-check
                    '''
                }
            }

            ctx.stage('8. Flink 流水线任务发布') {
                if (p.FLINK_RUN_MODE == 'run' && !p.DRY_RUN) {
                    ctx.script {
                        def jarFile = ctx.sh(
                            script: "ls target/*-shaded.jar target/flink-kafka-demo-1.0-SNAPSHOT.jar 2>/dev/null | head -n 1",
                            returnStdout: true
                        ).trim()

                        if (!jarFile) {
                            ctx.echo "⚠️ 未发现 Flink 可执行 Jar，跳过 Flink 发布"
                        } else {
                            ctx.env.FLINK_JAR_FILE = jarFile
                            ctx.sh """
                                set -eux
                                mkdir -p meta
                                docker rm -f temp-curl-uploader || true
                                docker run -d --name temp-curl-uploader --network host curlimages/curl:8.6.0 sleep 3600
                                docker cp ${jarFile} temp-curl-uploader:/tmp/job.jar

                                docker exec temp-curl-uploader sh -c 'curl -s -X POST -H "Host: ${FLINK_HOST}" -F "jarfile=@/tmp/job.jar" http://127.0.0.1/jars/upload > /tmp/upload.json'
                                docker cp temp-curl-uploader:/tmp/upload.json meta/flink-upload.json

                                JAR_ID=\$(cat meta/flink-upload.json | grep -o 'flink-web-upload/[^"]*.jar' | cut -d '/' -f 2)
                                if [ -z "\$JAR_ID" ]; then
                                  echo "❌ 未能解析 Flink Jar ID"
                                  cat meta/flink-upload.json
                                  exit 1
                                fi

                                docker exec temp-curl-uploader sh -c "curl -s -X POST -H 'Host: ${FLINK_HOST}' http://127.0.0.1/jars/\${JAR_ID}/run > /tmp/run.json"
                                docker cp temp-curl-uploader:/tmp/run.json meta/flink-run.json
                                docker rm -f temp-curl-uploader
                            """
                        }
                    }
                } else {
                    ctx.echo '跳过 Flink 发布'
                }
            }

            ctx.stage('9. GitOps 多环境分发') {
                if (!p.DRY_RUN) {
                    ctx.dir('config-repo') {
                        ctx.checkout([
                            $class: 'GitSCM',
                            branches: [[name: 'main']],
                            userRemoteConfigs: [[url: "${ctx.env.CONFIG_REPO_URL}", credentialsId: "${ctx.env.GITOPS_CREDENTIALS}"]]
                        ])

                        ctx.script {
                            def manifestPath = "${p.DEPLOY_ENV}/deployment.yaml"
                            ctx.env.GITOPS_MANIFEST_PATH = manifestPath
                            ctx.env.PREVIOUS_IMAGE = ctx.sh(
                                script: "awk '/image:/{print \$2; exit}' ${manifestPath}",
                                returnStdout: true
                            ).trim()

                            ctx.sh """
                                set -eux
                                mkdir -p ../meta
                                test -f ${manifestPath}
                                echo '${ctx.env.PREVIOUS_IMAGE}' > ../meta/previous-image.txt
                                sed -i 's|image: .*|image: ${ctx.env.IMAGE_NAME}|g' ${manifestPath}
                                grep -n 'image:' ${manifestPath}
                                git config user.email 'jenkins@devops.local'
                                git config user.name 'jenkins-bot'
                                git add ${manifestPath}
                                git diff --cached --quiet || git commit -m "ci(gh-r2): deploy ${ctx.env.APP_NAME} ${ctx.env.GIT_COMMIT_ID} to ${p.DEPLOY_ENV}"
                            """

                            ctx.withCredentials([ctx.usernamePassword(
                                credentialsId: "${ctx.env.GITOPS_CREDENTIALS}",
                                usernameVariable: 'GIT_USERNAME',
                                passwordVariable: 'GIT_PASSWORD'
                            )]) {
                                ctx.sh '''
                                    set -eux
                                    if git log -1 --pretty=%s | grep -q "ci(gh-r2): deploy"; then
                                      git push http://${GIT_USERNAME}:${GIT_PASSWORD}@gitlab-service/root/hello-app-config.git HEAD:main
                                    else
                                      echo "无配置变更，跳过 git push"
                                    fi
                                '''
                            }
                        }
                    }
                } else {
                    ctx.echo 'DRY_RUN=true，跳过 GitOps 分发'
                }
            }

            ctx.stage('10. 发布闸门 (test/prod)') {
                if (!p.DRY_RUN && (p.DEPLOY_ENV == 'test' || p.DEPLOY_ENV == 'prod')) {
                    ctx.timeout(time: 10, unit: 'MINUTES') {
                        ctx.input message: "确认继续发布到 ${p.DEPLOY_ENV} ?", ok: "确认发布"
                    }
                } else {
                    ctx.echo '无需人工闸门'
                }
            }

            ctx.stage('11. 部署后验证 (Rollout + Smoke Test + Rollback)') {
                if (p.RUN_SMOKE_TEST) {
                    try {
                        ctx.sh """
                            set -eux
                            echo "👉 等待 Deployment Rollout"
                            kubectl rollout status deployment/${APP_NAME} -n ${K8S_NAMESPACE} --timeout=180s

                            APP_POD=\$(kubectl get pods -n ${K8S_NAMESPACE} -l app=${APP_NAME} --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}')
                            if [ -z "\$APP_POD" ]; then
                                echo "❌ 找不到处于 Running 状态的 ${APP_NAME} Pod"
                                exit 1
                            fi

                            echo "✅ 成功找到应用 Pod: \$APP_POD"

                            ok=0
                            for i in 1 2 3; do
                              echo "👉 第 \$i 次执行烟雾测试"
                              if kubectl exec -n ${K8S_NAMESPACE} \$APP_POD -- wget -qO- http://127.0.0.1:80/ > /dev/null; then
                                ok=1
                                break
                              fi
                              sleep 10
                            done

                            [ "\$ok" -eq 1 ]
                            echo "✅ 业务健康检查完美通过！"
                        """
                    } catch (err) {
                        if (!p.DRY_RUN && ctx.env.PREVIOUS_IMAGE?.trim()) {
                            ctx.echo "⚠️ 烟雾测试失败，开始自动回滚到 ${ctx.env.PREVIOUS_IMAGE}"

                            ctx.dir('config-repo') {
                                ctx.sh """
                                    set -eux
                                    test -f ${ctx.env.GITOPS_MANIFEST_PATH}
                                    sed -i 's|image: .*|image: ${ctx.env.PREVIOUS_IMAGE}|g' ${ctx.env.GITOPS_MANIFEST_PATH}
                                    grep -n 'image:' ${ctx.env.GITOPS_MANIFEST_PATH}
                                    git config user.email 'jenkins@devops.local'
                                    git config user.name 'jenkins-bot'
                                    git add ${ctx.env.GITOPS_MANIFEST_PATH}
                                    git diff --cached --quiet || git commit -m "rollback(gh-r2): restore ${ctx.env.APP_NAME} to ${ctx.env.PREVIOUS_IMAGE}"
                                """

                                ctx.withCredentials([ctx.usernamePassword(
                                    credentialsId: "${ctx.env.GITOPS_CREDENTIALS}",
                                    usernameVariable: 'GIT_USERNAME',
                                    passwordVariable: 'GIT_PASSWORD'
                                )]) {
                                    ctx.sh '''
                                        set -eux
                                        if git log -1 --pretty=%s | grep -q "rollback(gh-r2): restore"; then
                                          git push http://${GIT_USERNAME}:${GIT_PASSWORD}@gitlab-service/root/hello-app-config.git HEAD:main
                                        else
                                          echo "无回滚配置变更，跳过 git push"
                                        fi
                                    '''
                                }
                            }

                            ctx.sh """
                                set +e
                                kubectl rollout status deployment/${APP_NAME} -n ${K8S_NAMESPACE} --timeout=180s
                                exit 0
                            """
                        }

                        throw err
                    }
                } else {
                    ctx.echo 'RUN_SMOKE_TEST=false，跳过部署后验证'
                }
            }

            ctx.stage('12. 构建总结') {
                ctx.sh """
                    cat > meta/build-summary.txt <<EOF
Build Number   : ${ctx.env.BUILD_NUMBER}
Deploy Env     : ${p.DEPLOY_ENV}
Git Branch     : ${ctx.env.GIT_BRANCH_NAME}
Git Commit     : ${ctx.env.GIT_COMMIT_ID}
Image          : ${ctx.env.IMAGE_NAME}
Previous Image : ${ctx.env.PREVIOUS_IMAGE}
Dry Run        : ${p.DRY_RUN}
Flink Mode     : ${p.FLINK_RUN_MODE}
Script Name    : ${ctx.env.SCRIPT_NAME}
EOF
                """
                ctx.echo "✅ gh-release-r2 执行完成"
            }

        } finally {
            ctx.archiveArtifacts allowEmptyArchive: true, artifacts: 'target/*.jar,meta/*,reports/*', fingerprint: true
            ctx.echo "📦 已完成归档与清理，请以 Jenkins 最终构建结果为准"
            ctx.cleanWs(deleteDirs: true, disableDeferredWipeout: true, notFailBuild: true)
        }
    }
}

return this