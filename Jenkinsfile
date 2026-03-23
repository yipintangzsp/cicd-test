properties([
  pipelineTriggers([pollSCM('H/2 * * * *')]),
  disableConcurrentBuilds(),
  buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '20')),
  parameters([
    choice(name: 'SCRIPT_NAME', choices: [
      'gh-release-r2',
      'gh-release-r1'
    ], description: '选择 GitHub 流水线快照版本'),
    choice(name: 'DEPLOY_ENV', choices: ['dev', 'test', 'prod'], description: '选择部署环境'),
    booleanParam(name: 'SKIP_SECURITY_SCAN', defaultValue: false, description: '跳过 Sonar/Trivy 安全扫描'),
    booleanParam(name: 'RUN_UNIT_TESTS', defaultValue: true, description: '执行单元测试'),
    booleanParam(name: 'RUN_SMOKE_TEST', defaultValue: true, description: '执行部署后烟雾测试'),
    booleanParam(name: 'DRY_RUN', defaultValue: false, description: '仅做构建与校验，不执行发布'),
    choice(name: 'FLINK_RUN_MODE', choices: ['run', 'skip'], description: '是否执行 Flink 任务发布'),
    string(name: 'K8S_NAMESPACE', defaultValue: 'ns-apps', description: '应用部署后的命名空间'),
    string(name: 'APP_HEALTH_URL', defaultValue: 'http://hello-app.ns-apps.svc.cluster.local:8080/actuator/health', description: '部署后健康检查地址')
  ])
])

node {
  timestamps {
    ansiColor('xterm') {
      timeout(time: 120, unit: 'MINUTES') {

        stage('拉取 GitHub main') {
          checkout scm
        }

        stage('加载版本脚本') {
          script {
            def file = "${params.SCRIPT_NAME}.groovy"
            if (!fileExists(file)) {
              error "未找到版本文件: ${file}"
            }
            def runner = load(file)
            runner.run(this, params)
          }
        }
      }
    }
  }
}