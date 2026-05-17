def run(ctx, p) {
    def buildJkvideo = (p.BUILD_JKVIDEO == null) ? true : p.BUILD_JKVIDEO
    def jkvideoPlatforms = p.JKVIDEO_PLATFORMS ?: 'web'
    def jkvideoRepoUrl = p.JKVIDEO_REPO_URL ?: 'http://gitlab-service/root/JKVideo.git'
    def jkvideoBranch = p.JKVIDEO_BRANCH ?: 'main'
    def runJest = (p.JKVIDEO_RUN_JEST == null) ? true : p.JKVIDEO_RUN_JEST

    ctx.withEnv([
        'SCRIPT_NAME=gh-release-r8-jkvideo',
        'APP_NAME=hello-app',
        'REGISTRY=127.0.0.1:30050',
        'CONFIG_REPO_URL=http://gitlab-service/root/hello-app-config.git',
        'MAVEN_IMAGE=maven:3-eclipse-temurin-17',
        'MAVEN_CACHE=/root/.m2',
        'GITOPS_CREDENTIALS=gitlab-root-auth',
        'K8S_NAMESPACE=ns-apps',
        'JKVIDEO_APP_NAME=jkvideo',
        "JKVIDEO_WORKSPACE=${ctx.env.WORKSPACE}/jkvideo-src",
        'NODE_CACHE=/root/.npm',
        "DEPLOY_ENV=${p.DEPLOY_ENV}",
        "DRY_RUN=${p.DRY_RUN}",
        "JKVIDEO_RUN_JEST=${runJest}",
        "JKVIDEO_PLATFORMS=${jkvideoPlatforms}"
    ]) {
        try {
            ctx.stage('0. Init GitHub context') {
                ctx.script {
                    ctx.env.GIT_COMMIT_ID = ctx.sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    ctx.env.GIT_BRANCH_NAME = ctx.sh(script: '(git symbolic-ref --short -q HEAD || echo main)', returnStdout: true).trim()
                    ctx.env.IMAGE_NAME = "${ctx.env.REGISTRY}/${ctx.env.APP_NAME}:${ctx.env.GIT_COMMIT_ID}"
                    ctx.env.JKVIDEO_WEB_IMAGE = "${ctx.env.REGISTRY}/${ctx.env.JKVIDEO_APP_NAME}-web:${ctx.env.GIT_COMMIT_ID}"

                    ctx.currentBuild.displayName = "#${ctx.env.BUILD_NUMBER} github ${p.DEPLOY_ENV} ${ctx.env.GIT_COMMIT_ID}"
                    ctx.currentBuild.description = "github, image=${ctx.env.IMAGE_NAME}, jkvideo=${buildJkvideo}, dryRun=${p.DRY_RUN}"

                    ctx.sh """#!/bin/sh
set -eux
mkdir -p meta reports
cat > meta/build-info.json <<EOF
{
  "source": "github",
  "script_name": "gh-release-r8-jkvideo",
  "build_number": "${ctx.env.BUILD_NUMBER}",
  "deploy_env": "${p.DEPLOY_ENV}",
  "git_commit": "${ctx.env.GIT_COMMIT_ID}",
  "git_branch": "${ctx.env.GIT_BRANCH_NAME}",
  "image_name": "${ctx.env.IMAGE_NAME}",
  "jkvideo_web_image": "${ctx.env.JKVIDEO_WEB_IMAGE}",
  "jkvideo_enabled": "${buildJkvideo}",
  "dry_run": "${p.DRY_RUN}"
}
EOF
"""
                }
            }

            ctx.stage('1. Preflight') {
                ctx.sh '''#!/bin/sh
set -eux
test -f Dockerfile
docker version
kubectl version --client
git --version
kubectl get ns ${K8S_NAMESPACE} >/dev/null
'''
            }

            ctx.stage('2. Maven test and build') {
                if (p.RUN_UNIT_TESTS) {
                    ctx.sh '''#!/bin/sh
set -eux
if [ -f pom.xml ]; then
  docker rm -f temp-gh-maven >/dev/null 2>&1 || true
  trap 'docker rm -f temp-gh-maven >/dev/null 2>&1 || true' EXIT
  docker run -d --name temp-gh-maven -v ${MAVEN_CACHE}:/root/.m2 -w /usr/src ${MAVEN_IMAGE} sleep 3600
  docker cp . temp-gh-maven:/usr/src/
  docker exec temp-gh-maven mvn -B -U test clean package -DskipTests
  rm -rf target
  docker cp temp-gh-maven:/usr/src/target .
else
  echo "No pom.xml, skip Maven build"
fi
'''
                    ctx.junit allowEmptyResults: true, testResults: 'target/**/surefire-reports/*.xml'
                } else {
                    ctx.echo 'RUN_UNIT_TESTS=false, skip Maven test'
                }
            }

            ctx.stage('3. Build and push GitHub image') {
                ctx.sh '''#!/bin/sh
set -eux
docker build --no-cache --network none \
  --label app.name=${APP_NAME} \
  --label source.repo=github \
  --label git.commit=${GIT_COMMIT_ID} \
  --label git.branch=${GIT_BRANCH_NAME} \
  --label build.number=${BUILD_NUMBER} \
  -t ${IMAGE_NAME} .
if [ "${DRY_RUN}" = "false" ]; then
  docker push ${IMAGE_NAME}
else
  echo "DRY_RUN=true, skip docker push"
fi
docker inspect ${IMAGE_NAME} > meta/image-inspect.json
'''
            }

            if (buildJkvideo) {
                ctx.stage('4. Checkout JKVideo') {
                    ctx.dir(ctx.env.JKVIDEO_WORKSPACE) {
                        ctx.checkout(
                            changelog: false,
                            poll: false,
                            scm: [
                                $class: 'GitSCM',
                                branches: [[name: "*/${jkvideoBranch}"]],
                                userRemoteConfigs: [[
                                    url: jkvideoRepoUrl,
                                    credentialsId: "${ctx.env.GITOPS_CREDENTIALS}"
                                ]]
                            ]
                        )
                    }
                }

                ctx.stage('5. JKVideo web build') {
                    if (jkvideoPlatforms == 'web' || jkvideoPlatforms == 'android+web') {
                        ctx.sh '''#!/bin/sh
set -eux
docker rm -f temp-gh-jkvideo-web >/dev/null 2>&1 || true
trap 'docker rm -f temp-gh-jkvideo-web >/dev/null 2>&1 || true' EXIT
docker run -d --name temp-gh-jkvideo-web \
  -v ${NODE_CACHE}:/root/.npm \
  -w /app \
  node:20-alpine sleep 3600
docker cp ${JKVIDEO_WORKSPACE}/. temp-gh-jkvideo-web:/app/
docker exec temp-gh-jkvideo-web npm ci --prefer-offline --cache /root/.npm
if [ "${JKVIDEO_RUN_JEST}" = "true" ]; then
  docker exec temp-gh-jkvideo-web npx tsc --noEmit
  docker exec temp-gh-jkvideo-web npm test -- --config jest.config.js --coverage --ci --passWithNoTests --forceExit
fi
docker exec temp-gh-jkvideo-web sh -c 'npx expo export --platform web --output-dir dist/web 2>&1' | cat
mkdir -p reports/jkvideo-web
docker cp temp-gh-jkvideo-web:/app/dist/web/. reports/jkvideo-web/
tar -czf reports/jkvideo-web.tar.gz -C reports/jkvideo-web .
'''
                    } else {
                        ctx.echo "JKVIDEO_PLATFORMS=${jkvideoPlatforms}, skip web build"
                    }
                }

                ctx.stage('6. JKVideo web image') {
                    if (jkvideoPlatforms == 'web' || jkvideoPlatforms == 'android+web') {
                        ctx.sh '''#!/bin/sh
set -eux
rm -rf /tmp/gh-jkvideo-web-build
mkdir -p /tmp/gh-jkvideo-web-build/html
cp -r reports/jkvideo-web/. /tmp/gh-jkvideo-web-build/html/
cat > /tmp/gh-jkvideo-web-build/nginx.conf <<'NGINXCONF'
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location ~* [.](js|css|png|ttf|woff2|ico)$ {
        expires 7d;
        add_header Cache-Control "public";
    }
    gzip on;
    gzip_types text/plain text/css application/javascript application/json;
}
NGINXCONF
cat > /tmp/gh-jkvideo-web-build/Dockerfile <<'DOCKERFILE'
FROM 127.0.0.1:30050/library/nginx-alpine:latest
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/
EXPOSE 80
DOCKERFILE
docker build --no-cache --network none \
  --label app.name=${JKVIDEO_APP_NAME}-web \
  --label source.repo=github \
  --label git.commit=${GIT_COMMIT_ID} \
  -t ${JKVIDEO_WEB_IMAGE} \
  /tmp/gh-jkvideo-web-build
rm -rf /tmp/gh-jkvideo-web-build
if [ "${DRY_RUN}" = "false" ]; then
  docker push ${JKVIDEO_WEB_IMAGE}
else
  echo "DRY_RUN=true, skip JKVideo image push"
fi
'''
                    }
                }
            }

            ctx.stage('7. GitOps deploy') {
                if (!p.DRY_RUN) {
                    ctx.dir('config-repo') {
                        ctx.checkout(
                            changelog: false,
                            poll: false,
                            scm: [
                                $class: 'GitSCM',
                                branches: [[name: 'main']],
                                userRemoteConfigs: [[
                                    url: "${ctx.env.CONFIG_REPO_URL}",
                                    credentialsId: "${ctx.env.GITOPS_CREDENTIALS}"
                                ]]
                            ]
                        )

                        ctx.sh """#!/bin/sh
set -eux
git config user.email 'jenkins@devops.local'
git config user.name 'jenkins-bot'
test -f ${p.DEPLOY_ENV}/deployment.yaml
sed -i 's|image: .*|image: ${ctx.env.IMAGE_NAME}|g' ${p.DEPLOY_ENV}/deployment.yaml
git add ${p.DEPLOY_ENV}/deployment.yaml
git diff --cached --quiet || git commit -m "ci(gh-r8): deploy ${ctx.env.APP_NAME} ${ctx.env.GIT_COMMIT_ID} to ${p.DEPLOY_ENV}"
"""

                        if (buildJkvideo && (jkvideoPlatforms == 'web' || jkvideoPlatforms == 'android+web')) {
                            ctx.sh """#!/bin/sh
set -eux
cat > ${p.DEPLOY_ENV}/jkvideo-web-deployment.yaml <<'YAML'
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
        image: ${ctx.env.JKVIDEO_WEB_IMAGE}
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 20m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 192Mi
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
  - name: http
    port: 80
    targetPort: 80
    nodePort: 30088
YAML
git add ${p.DEPLOY_ENV}/jkvideo-web-deployment.yaml
git diff --cached --quiet || git commit -m "ci(gh-r8): deploy jkvideo-web ${ctx.env.GIT_COMMIT_ID} to ${p.DEPLOY_ENV}"
"""
                        }

                        ctx.withCredentials([ctx.usernamePassword(
                            credentialsId: "${ctx.env.GITOPS_CREDENTIALS}",
                            usernameVariable: 'GIT_USERNAME',
                            passwordVariable: 'GIT_PASSWORD'
                        )]) {
                            ctx.sh '''#!/bin/sh
set -eux
git push http://${GIT_USERNAME}:${GIT_PASSWORD}@gitlab-service/root/hello-app-config.git HEAD:main
'''
                        }
                    }
                } else {
                    ctx.echo 'DRY_RUN=true, skip GitOps deploy'
                }
            }

            ctx.stage('8. Verify') {
                if (p.RUN_SMOKE_TEST) {
                    ctx.sh '''#!/bin/sh
set -eux
kubectl rollout status deployment/${APP_NAME} -n ${K8S_NAMESPACE} --timeout=180s
APP_POD=$(kubectl get pods -n ${K8S_NAMESPACE} -l app=${APP_NAME} --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}')
test -n "$APP_POD"
kubectl exec -n ${K8S_NAMESPACE} "$APP_POD" -- wget -qO- http://127.0.0.1:80/ >/dev/null
if kubectl get deployment jkvideo-web -n ${K8S_NAMESPACE} >/dev/null 2>&1; then
  kubectl rollout status deployment/jkvideo-web -n ${K8S_NAMESPACE} --timeout=180s
  JK_POD=$(kubectl get pods -n ${K8S_NAMESPACE} -l app=jkvideo-web --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}')
  test -n "$JK_POD"
  kubectl exec -n ${K8S_NAMESPACE} "$JK_POD" -- wget -qO- http://127.0.0.1:80/ >/dev/null
  JK_NODEPORT=$(kubectl get svc jkvideo-web -n ${K8S_NAMESPACE} -o jsonpath='{.spec.ports[0].nodePort}' 2>/dev/null || true)
  if [ -n "$JK_NODEPORT" ]; then
    curl -fsS "http://192.168.1.58:${JK_NODEPORT}/" >/dev/null
    echo "JKVideo URL: http://192.168.1.58:${JK_NODEPORT}/"
  fi
fi
'''
                }
            }

            ctx.stage('9. Summary') {
                ctx.sh """#!/bin/sh
cat > meta/build-summary.txt <<EOF
Source         : github
Script Name    : gh-release-r8-jkvideo
Deploy Env     : ${p.DEPLOY_ENV}
Git Branch     : ${ctx.env.GIT_BRANCH_NAME}
Git Commit     : ${ctx.env.GIT_COMMIT_ID}
Main Image     : ${ctx.env.IMAGE_NAME}
JKVideo Image  : ${ctx.env.JKVIDEO_WEB_IMAGE}
Dry Run        : ${p.DRY_RUN}
JKVideo URL    : http://192.168.1.58:30088/
EOF
"""
            }
        } finally {
            ctx.archiveArtifacts allowEmptyArchive: true, artifacts: 'target/*.jar,meta/*,reports/*,reports/jkvideo-web.tar.gz', fingerprint: true
            ctx.cleanWs(deleteDirs: true, disableDeferredWipeout: true, notFailBuild: true)
        }
    }
}

return this
