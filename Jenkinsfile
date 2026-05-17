properties([
  
  disableConcurrentBuilds(),
  buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '20')),
  parameters([
	    choice(name: 'SCRIPT_NAME', choices: [
	      'gh-release-r8-jkvideo',
	      'gh-release-r2',
	      'gh-release-r1'
	    ], description: 'Select GitHub pipeline snapshot version'),
	    choice(name: 'DEPLOY_ENV', choices: ['dev', 'test', 'prod'], description: 'Deployment environment'),
	    booleanParam(name: 'SKIP_SECURITY_SCAN', defaultValue: false, description: 'Skip Sonar and Trivy checks'),
	    booleanParam(name: 'RUN_UNIT_TESTS', defaultValue: true, description: 'Run unit tests'),
	    booleanParam(name: 'RUN_SMOKE_TEST', defaultValue: true, description: 'Run post-deploy smoke tests'),
	    booleanParam(name: 'DRY_RUN', defaultValue: false, description: 'Build and validate only; do not publish'),
	    choice(name: 'FLINK_RUN_MODE', choices: ['run', 'skip'], description: 'Run or skip Flink job publish'),
	    string(name: 'K8S_NAMESPACE', defaultValue: 'ns-apps', description: 'Kubernetes namespace'),
	    string(name: 'APP_HEALTH_URL', defaultValue: 'http://hello-app.ns-apps.svc.cluster.local/', description: 'Application health URL'),
	    booleanParam(name: 'BUILD_JKVIDEO', defaultValue: true, description: 'Build JKVideo web frontend'),
	    string(name: 'JKVIDEO_REPO_URL', defaultValue: 'http://gitlab-service/root/JKVideo.git', description: 'JKVideo Git repository URL'),
	    string(name: 'JKVIDEO_BRANCH', defaultValue: 'main', description: 'JKVideo branch'),
	    choice(name: 'JKVIDEO_PLATFORMS', choices: ['web', 'android+web', 'android'], description: 'JKVideo target platform'),
	    booleanParam(name: 'JKVIDEO_RUN_JEST', defaultValue: true, description: 'Run JKVideo Jest checks')
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
