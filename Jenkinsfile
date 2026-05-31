// GitHub entrypoint: keep every independent pipeline version visible, newest first.

def pipelineVersions = [
    'Jenkinsfile-epoch-v13',
    'Jenkinsfile-expert-v13',
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
    buildDiscarder(logRotator(numToKeepStr: '45', artifactNumToKeepStr: '30')),
    pipelineTriggers([githubPush(), pollSCM('* * * * *')]),
    parameters([
        choice(name: 'PIPELINE_VERSION', choices: pipelineVersions, description: 'Select GitHub pipeline version, newest first.'),
        choice(name: 'DEPLOY_ENV', choices: ['dev', 'test', 'prod'], description: 'Target environment label.'),
        booleanParam(name: 'DRY_RUN', defaultValue: false, description: 'Run real build/deploy path by default.'),
        booleanParam(name: 'RUN_UNIT_TESTS', defaultValue: true, description: 'Run unit tests.'),
        booleanParam(name: 'RUN_SMOKE_TEST', defaultValue: true, description: 'Run smoke checks.'),
        string(name: 'V13_PORTAL_NODEPORT', defaultValue: '30089', description: '[v13] Independent portal NodePort; 30087 is V12 and 30088 is jkvideo.'),
        booleanParam(name: 'V13_REQUIRE_CLOUDFLARE_PUBLICATION', defaultValue: false, description: '[v13] Keep false unless Cloudflare is intentionally moved to V13.')
    ])
])

node {
    stage('Select GitHub Pipeline Version') {
        checkout scm
        def selected = (params.PIPELINE_VERSION ?: 'Jenkinsfile-epoch-v13').trim()
        if (!pipelineVersions.contains(selected)) {
            error "Unsupported PIPELINE_VERSION: ${selected}"
        }
        if (!fileExists(selected)) {
            error "Selected Jenkinsfile does not exist: ${selected}"
        }
        currentBuild.displayName = "#${env.BUILD_NUMBER} github ${selected}"
        currentBuild.description = "github-entry=${selected}"
        load selected
    }
}
