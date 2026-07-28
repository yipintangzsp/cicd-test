#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runtimeFiles = [
  'Jenkinsfile-intelligence-v18',
  'ci/v18_universal_fabric.mjs',
  'platform/v18/service-coverage-contract.md',
  '.github/workflows/v18-platform-evidence.yml',
];
const selectorFile = 'Jenkinsfile-era-router';
const files = [...runtimeFiles, selectorFile];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sources = files.map((file) => ({ file, body: read(file) }));
const jenkinsfile = sources[0].body;
const selector = sources.find(({ file }) => file === selectorFile).body;
const expectedVersionJobs = new Map([
  ['v18', 'hello-app-v18'], ['v17', 'hello-app-v17'], ['v16', 'hello-app-v16'],
  ['v15', 'hello-app-v15'], ['v14', 'hello-app-v14'], ['v13', 'hello-app-v13'],
]);
const selectorEntries = [...selector.matchAll(/^\s*'([^']+)':\s*'([^']+)',?$/gm)]
  .map((match) => [match[1], match[2]]);
const selectorChoices = selectorEntries.map(([version]) => version);
const selectorIsComplete = selectorEntries.length === expectedVersionJobs.size
  && selectorEntries.every(([version, job]) => expectedVersionJobs.get(version) === job)
  && /name:\s*['"]PIPELINE_VERSION['"]/.test(selector)
  && /jenkins_child_parameter_contract\.mjs/.test(selector)
  && /build\s*(?:\(\s*)?job:\s*childJob/.test(selector)
  && !/\bload\s+/.test(selector);
const runtimeSources = sources.filter(({ file }) => runtimeFiles.includes(file));

const declaredParameters = [...jenkinsfile.matchAll(/(?:booleanParam|string|choice)\s*\(\s*name:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)]
  .map((match) => match[1]);
const foreignParameters = declaredParameters.filter((name) => name !== 'PIPELINE_VERSION' && !name.startsWith('V18_'));
const foreignVersionTokens = runtimeSources.flatMap(({ file, body }) =>
  [...body.matchAll(/\bV(?!18(?:\b|_))\d+(?:\b|_)/g)].map((match) => ({ file, token: match[0], offset: match.index }))
);
const foreignArtifactReferences = runtimeSources.flatMap(({ file, body }) =>
  [...body.matchAll(/(?:reports|meta)\/v(?!18(?:[-/]))\d+[^\s'"`)]*/g)].map((match) => ({ file, reference: match[0] }))
);
const forbiddenRuntimeReferences = runtimeSources.flatMap(({ file, body }) => {
  const isWorkflow = file.startsWith('.github/workflows/');
  return [
    ...(!isWorkflow && /Jenkinsfile-router/.test(body)
      ? [{ file, reference: 'Jenkinsfile-router' }]
      : []),
    ...(!isWorkflow && /Jenkinsfile-era-router/.test(body)
      ? [{ file, reference: 'Jenkinsfile-era-router' }]
      : []),
    ...(/version_independence_audit/.test(body)
      ? [{ file, reference: 'version_independence_audit' }]
      : []),
    ...(/\bload\s*\(?'?Jenkinsfile(?!-intelligence-v18)/.test(body)
      ? [{ file, reference: 'foreign Jenkinsfile load' }]
      : []),
  ];
});

const pass = selectorIsComplete
  && !declaredParameters.includes('PIPELINE_VERSION')
  && foreignParameters.length === 0
  && foreignVersionTokens.length === 0
  && foreignArtifactReferences.length === 0
  && forbiddenRuntimeReferences.length === 0;
const report = {
  pipelineVersion: 'v18',
  policy: 'The platform-era-v13 selector owns only v13-v18 and PIPELINE_VERSION, reads only the selected child parameter contract, and dispatches an independent child job. V18 owns only V18 parameters, source, runtime calls, workspace, and artifacts.',
  auditedFiles: files,
  declaredParameters,
  selectorChoices,
  selectorIsComplete,
  foreignParameters,
  foreignVersionTokens,
  foreignArtifactReferences,
  forbiddenRuntimeReferences,
  pass,
};

fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports/v18-isolation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`v18_isolation=${pass ? 'ok' : 'failed'} parameters=${declaredParameters.join(',')}`);
if (!pass) process.exit(1);
