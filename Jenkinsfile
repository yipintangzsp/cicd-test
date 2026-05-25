// Stable entrypoint for selecting an independent Jenkinsfile version.
// The selected Jenkinsfile remains self-contained and is loaded after checkout.

def pipelineVersions = [
    'Jenkinsfile-expert-v12',
    'Jenkinsfile-expert-v11',
    'Jenkinsfile-expert-v10',
    'Jenkinsfile-expert-v9',
    'Jenkinsfile-v8-jkvideo',
    'Jenkinsfile-expert-v8',
    'Jenkinsfile-expert-v7',
    'Jenkinsfile-expert-v6',
    'Jenkinsfile-expert-v5',
    'Jenkinsfile-expert-v4',
    'Jenkinsfile-expert-v3',
    'Jenkinsfile-expert-v2',
    'Jenkinsfile-v2-tested',
    'Jenkinsfile_v2',
    'Jenkinsfile-v1'
]

properties([
    disableConcurrentBuilds(),
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '20')),
    parameters([
        choice(name: 'PIPELINE_VERSION', choices: pipelineVersions, description: 'Select Jenkinsfile version, newest first.'),
        choice(name: 'DEPLOY_ENV', choices: ['dev', 'test', 'prod'], description: 'Target deployment environment.'),
        booleanParam(name: 'SKIP_SECURITY_SCAN', defaultValue: false, description: 'Skip SonarQube and Trivy checks.'),
        booleanParam(name: 'RUN_UNIT_TESTS', defaultValue: true, description: 'Run unit tests.'),
        booleanParam(name: 'RUN_SMOKE_TEST', defaultValue: true, description: 'Run smoke checks after deploy.'),
        booleanParam(name: 'DRY_RUN', defaultValue: false, description: 'Run the real build/deploy path by default; enable only when you want a validation-only run.'),
        choice(name: 'FLINK_RUN_MODE', choices: ['run', 'skip'], description: 'Submit Flink job by default.'),
        string(name: 'K8S_NAMESPACE', defaultValue: 'ns-apps', description: 'Kubernetes namespace for app deployment.'),
        string(name: 'APP_HEALTH_URL', defaultValue: 'http://hello-app.ns-apps.svc.cluster.local/', description: 'Application health URL.'),
        booleanParam(name: 'BUILD_JKVIDEO', defaultValue: true, description: 'Build JKVideo web/android artifacts.'),
        string(name: 'JKVIDEO_REPO_URL', defaultValue: 'http://gitlab-service/root/JKVideo.git', description: 'JKVideo repository URL.'),
        string(name: 'JKVIDEO_BRANCH', defaultValue: 'main', description: 'JKVideo branch.'),
        choice(name: 'JKVIDEO_PLATFORMS', choices: ['web', 'android+web', 'android'], description: 'JKVideo target platforms.'),
        booleanParam(name: 'JKVIDEO_RUN_JEST', defaultValue: true, description: 'Run JKVideo Jest tests.'),
        choice(name: 'DEPLOY_STRATEGY', choices: ['rolling', 'blue-green', 'canary'], description: '[v9] Deployment strategy.'),
        string(name: 'CANARY_WEIGHT', defaultValue: '20', description: '[v9] Canary traffic percent.'),
        booleanParam(name: 'SKIP_PERF_TEST', defaultValue: false, description: '[v9/v10] Skip k6 performance baseline; default runs it.'),
        booleanParam(name: 'SKIP_DB_MIGRATION', defaultValue: false, description: '[v9/v10] Skip Flyway migration; default runs it.'),
        booleanParam(name: 'SIGN_IMAGE', defaultValue: true, description: '[v9/v10] Sign image with Cosign when available.'),
        booleanParam(name: 'UPLOAD_TO_MINIO', defaultValue: true, description: '[v9/v10] Upload artifacts to MinIO when available.'),
        booleanParam(name: 'TRIGGER_AIRFLOW_DAG', defaultValue: true, description: '[v9/v10] Trigger Airflow DAG when available.'),
        booleanParam(name: 'CHECK_TRINO_QUERY', defaultValue: true, description: '[v9/v10] Verify Trino query.'),
        booleanParam(name: 'VERIFY_ARGOCD_SYNC', defaultValue: true, description: '[v9/v10] Verify ArgoCD sync status.'),
        string(name: 'PERF_BASELINE_RPS', defaultValue: '100', description: '[v9] Minimum k6 RPS.'),
        string(name: 'ROLLBACK_TIMEOUT', defaultValue: '30', description: '[v9] Rollback wait seconds.'),
        booleanParam(name: 'V12_PLATFORM_MATRIX', defaultValue: true, description: '[v12] Generate platform evidence matrix.'),
        booleanParam(name: 'V12_PUBLISH_PORTAL', defaultValue: true, description: '[v12] Publish visible evidence portal.'),
        booleanParam(name: 'V12_RUN_PLATFORM_PROBES', defaultValue: true, description: '[v12] Probe all platform services and record evidence.'),
        booleanParam(name: 'V12_STRICT_SERVICE_READY', defaultValue: false, description: '[v12] Fail the build when a service probe fails.'),
        booleanParam(name: 'V12_IMPORT_OBSERVABILITY_ASSETS', defaultValue: true, description: '[v12] Import observability evidence to Elasticsearch/Kibana when available.'),
        booleanParam(name: 'V12_INCLUDE_RESOURCE_PROFILE', defaultValue: true, description: '[v12] Collect node and pod resource profiles.'),
        booleanParam(name: 'V12_INCLUDE_POD_LOG_SAMPLE', defaultValue: true, description: '[v12] Collect short log samples from key pods.'),
        booleanParam(name: 'V12_NOTIFY_DINGTALK', defaultValue: true, description: '[v12] Generate/send DingTalk notification when webhook credentials are configured.'),
        string(name: 'V12_SERVICE_PROBE_TIMEOUT', defaultValue: '8', description: '[v12] HTTP service probe timeout in seconds.'),
        string(name: 'V12_GRAFANA_DASHBOARD_TITLE', defaultValue: 'Jenkins V12 Platform Evidence', description: '[v12] Grafana dashboard title.'),
        string(name: 'V12_KIBANA_INDEX_PREFIX', defaultValue: 'jenkins-v12-platform', description: '[v12] Kibana/Elasticsearch index prefix.'),
        string(name: 'V12_PORTAL_NAMESPACE', defaultValue: 'ns-apps', description: '[v12] Evidence portal namespace.'),
        string(name: 'V12_PORTAL_NODEPORT', defaultValue: '30087', description: '[v12] Evidence portal NodePort.'),
        booleanParam(name: 'V12_REQUIRE_CLOUDFLARE_PUBLICATION', defaultValue: true, description: '[v12] Fail when Cloudflare publication cannot be verified.'),
        booleanParam(name: 'V12_RECRUITMENT_BENCHMARK', defaultValue: true, description: '[v12] Include recruitment-market capability benchmark evidence.'),
        booleanParam(name: 'V12_INCLUDE_IAC_GAP_REPORT', defaultValue: true, description: '[v12] Include IaC capability gap report.'),
        booleanParam(name: 'V12_REQUIRE_NO_IDLE_CORE_SERVICE', defaultValue: false, description: '[v12] Fail when suspicious idle core services are detected.'),
        booleanParam(name: 'V11_PLATFORM_MATRIX', defaultValue: true, description: '[v11] Generate platform evidence matrix.'),
        booleanParam(name: 'V11_PUBLISH_PORTAL', defaultValue: true, description: '[v11] Publish visible evidence portal.'),
        booleanParam(name: 'V11_RUN_PLATFORM_PROBES', defaultValue: true, description: '[v11] Probe all core platform services and record evidence.'),
        booleanParam(name: 'V11_STRICT_SERVICE_READY', defaultValue: false, description: '[v11] Fail the build when a service probe fails.'),
        booleanParam(name: 'V11_IMPORT_OBSERVABILITY_ASSETS', defaultValue: true, description: '[v11] Import/push observability assets when credentials are configured.'),
        booleanParam(name: 'V11_INCLUDE_RESOURCE_PROFILE', defaultValue: true, description: '[v11] Collect node and pod resource profiles.'),
        booleanParam(name: 'V11_INCLUDE_POD_LOG_SAMPLE', defaultValue: true, description: '[v11] Collect short log samples from key pods.'),
        booleanParam(name: 'V11_NOTIFY_DINGTALK', defaultValue: true, description: '[v11] Generate/send DingTalk notification when webhook credentials are configured.'),
        string(name: 'V11_SERVICE_PROBE_TIMEOUT', defaultValue: '8', description: '[v11] HTTP service probe timeout in seconds.'),
        string(name: 'V11_GRAFANA_DASHBOARD_TITLE', defaultValue: 'Jenkins V11 Platform Evidence', description: '[v11] Grafana dashboard title.'),
        string(name: 'V11_KIBANA_INDEX_PREFIX', defaultValue: 'jenkins-v11-platform', description: '[v11] Kibana/Elasticsearch index prefix.'),
        string(name: 'V11_PORTAL_NAMESPACE', defaultValue: 'ns-apps', description: '[v11] Evidence portal namespace.'),
        string(name: 'V11_PORTAL_NODEPORT', defaultValue: '30087', description: '[v11] Evidence portal NodePort.'),
        booleanParam(name: 'V11_REQUIRE_CLOUDFLARE_PUBLICATION', defaultValue: true, description: '[v11] Fail when Cloudflare publication cannot be verified.'),
        booleanParam(name: 'V10_PLATFORM_MATRIX', defaultValue: true, description: '[v10] Generate platform evidence matrix.'),
        booleanParam(name: 'V10_PUBLISH_PORTAL', defaultValue: true, description: '[v10] Publish visible evidence portal.'),
        booleanParam(name: 'V10_RUN_PLATFORM_PROBES', defaultValue: true, description: '[v10] Probe all core platform services and record evidence.'),
        booleanParam(name: 'V10_STRICT_SERVICE_READY', defaultValue: false, description: '[v10] Fail the build when a service probe fails.'),
        booleanParam(name: 'V10_IMPORT_OBSERVABILITY_ASSETS', defaultValue: true, description: '[v10] Import/push observability assets when credentials are configured.'),
        booleanParam(name: 'V10_INCLUDE_RESOURCE_PROFILE', defaultValue: true, description: '[v10] Collect node and pod resource profiles.'),
        booleanParam(name: 'V10_INCLUDE_POD_LOG_SAMPLE', defaultValue: true, description: '[v10] Collect short log samples from key pods.'),
        booleanParam(name: 'V10_NOTIFY_DINGTALK', defaultValue: true, description: '[v10] Generate/send DingTalk notification when webhook credentials are configured.'),
        string(name: 'V10_SERVICE_PROBE_TIMEOUT', defaultValue: '8', description: '[v10] HTTP service probe timeout in seconds.'),
        string(name: 'V10_GRAFANA_DASHBOARD_TITLE', defaultValue: 'Jenkins V10 Platform Evidence', description: '[v10] Grafana dashboard title.'),
        string(name: 'V10_KIBANA_INDEX_PREFIX', defaultValue: 'jenkins-v10-platform', description: '[v10] Kibana/Elasticsearch index prefix.'),
        string(name: 'V10_PORTAL_NAMESPACE', defaultValue: 'ns-apps', description: '[v10] Evidence portal namespace.'),
        string(name: 'V10_PORTAL_NODEPORT', defaultValue: '30087', description: '[v10] Evidence portal NodePort.'),
        string(name: 'CLOUDFLARE_PUBLIC_HOSTNAME', defaultValue: 'platform.heil.ccwu.cc', description: '[v10] Cloudflare public hostname.'),
        string(name: 'CLOUDFLARE_TUNNEL_SECRET', defaultValue: 'cloudflare-v11-tunnel-token', description: '[v11/v10] Kubernetes Secret containing Cloudflare Tunnel token.'),
        string(name: 'CLOUDFLARE_TUNNEL_IMAGE', defaultValue: '127.0.0.1:30050/library/cloudflared:2026.5.0', description: '[v11] Cloudflare Tunnel local image with pinned tag.'),
        booleanParam(name: 'V10_REQUIRE_CLOUDFLARE_PUBLICATION', defaultValue: true, description: '[v10] Fail when Cloudflare publication cannot be verified.')
    ])
])

node {
    stage('Select Jenkinsfile') {
        if (env.JOB_NAME == 'github-cicd-test') {
            echo 'No Jenkins scm binding detected; using workspace prepared by GitHub job wrapper.'
        } else {
            sh '''
                set -eux
                git clone /var/jenkins_home/github-cache/cicd-test.git .
                git checkout -f main
                git remote set-url origin https://github.com/yipintangzsp/cicd-test.git
            '''
        }
        def selected = (params.PIPELINE_VERSION ?: 'Jenkinsfile-expert-v12').trim()
        if (!pipelineVersions.contains(selected)) {
            error "Unsupported PIPELINE_VERSION: ${selected}"
        }
        if (!fileExists(selected)) {
            error "Selected Jenkinsfile does not exist: ${selected}"
        }
        currentBuild.displayName = "#${env.BUILD_NUMBER} ${selected}"
        currentBuild.description = "router=${selected}"
        echo "Dispatching to ${selected}"
        load selected
    }
}
