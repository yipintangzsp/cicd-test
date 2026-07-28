#!/usr/bin/env node

import fs from 'node:fs';

function decodeXml(value = '') {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return match ? decodeXml(match[1]).trim() : '';
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument sequence near ${key ?? '<end>'}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function parseParameterDefinitions(xml) {
  const property = xml.match(
    /<hudson\.model\.ParametersDefinitionProperty>([\s\S]*?)<\/hudson\.model\.ParametersDefinitionProperty>/,
  );
  if (!property) {
    return [];
  }

  const definitions = [];
  const pattern =
    /<hudson\.model\.(Boolean|Choice|String)ParameterDefinition>([\s\S]*?)<\/hudson\.model\.\1ParameterDefinition>/g;
  for (const match of property[1].matchAll(pattern)) {
    const [, rawType, block] = match;
    const name = tag(block, 'name');
    if (!name) {
      throw new Error(`Found ${rawType} parameter without a name`);
    }

    const common = {
      name,
      description: tag(block, 'description'),
    };
    if (rawType === 'Boolean') {
      definitions.push({
        ...common,
        type: 'boolean',
        defaultValue: tag(block, 'defaultValue') === 'true',
      });
    } else if (rawType === 'Choice') {
      const choicesBlock = block.match(/<choices[^>]*>([\s\S]*?)<\/choices>/)?.[1] ?? '';
      const choices = [...choicesBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((item) =>
        decodeXml(item[1]).trim(),
      );
      if (choices.length === 0) {
        throw new Error(`Choice parameter ${name} has no choices`);
      }
      definitions.push({ ...common, type: 'choice', choices });
    } else {
      definitions.push({
        ...common,
        type: 'string',
        defaultValue: tag(block, 'defaultValue'),
      });
    }
  }
  return definitions;
}

const args = parseArguments(process.argv.slice(2));
if (!args.config || !args.version) {
  throw new Error('Usage: jenkins_child_parameter_contract.mjs --config <config.xml> --version <version>');
}

const parameters = parseParameterDefinitions(fs.readFileSync(args.config, 'utf8'));
const names = parameters.map((parameter) => parameter.name);
if (new Set(names).size !== names.length) {
  throw new Error(`Duplicate parameter names in ${args.version}`);
}
if (names.includes('PIPELINE_VERSION')) {
  throw new Error(`${args.version} must not own the selector parameter PIPELINE_VERSION`);
}

process.stdout.write(
  JSON.stringify({
    version: args.version,
    source: 'selected-child-job',
    parameters,
  }),
);
