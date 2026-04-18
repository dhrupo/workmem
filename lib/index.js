'use strict';

const fs = require('fs');
const { initCommand } = require('./repo.js');
const { buildContextCommand } = require('./packet.js');
const { saveRunCommand, recheckCommand, statusCommand } = require('./runs.js');
const { compressCommand } = require('./compressor.js');

function parseArgs(argv) {
  const result = {
    command: null,
    format: 'text',
    repo: null,
    help: false,
    version: false
  };

  if (!argv.length) {
    result.help = true;
    return result;
  }

  if (argv[0] === '-h' || argv[0] === '--help') {
    result.help = true;
    return result;
  }

  if (argv[0] === '-v' || argv[0] === '--version') {
    result.version = true;
    return result;
  }

  result.command = argv[0];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-v':
      case '--version':
        result.version = true;
        break;
      case '--repo':
      case '--format':
      case '--output':
      case '--base':
      case '--head':
      case '--task':
      case '--mode':
      case '--files':
      case '--max-files':
      case '--input':
      case '--kind':
      case '--branch':
      case '--commit':
      case '--run-id':
      case '--ignore':
        if (!next || next.startsWith('-')) {
          throw new Error(`Missing value for ${token}`);
        }
        result[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
        index += 1;
        break;
      case '--staged':
        result.staged = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (result.files) {
    result.files = result.files.split(',').map((item) => item.trim()).filter(Boolean);
  }

  if (result.ignore) {
    result.ignore = result.ignore.split(',').map((item) => item.trim()).filter(Boolean);
  }

  if (result.maxFiles) {
    result.maxFiles = Number.parseInt(result.maxFiles, 10);
  }

  return result;
}

function runCli(options, cwd) {
  switch (options.command) {
    case 'init':
      return initCommand(options, cwd);
    case 'build-context':
      return buildContextCommand(options, cwd);
    case 'save-run':
      return saveRunCommand(options, cwd);
    case 'recheck':
      return recheckCommand(options, cwd);
    case 'compress':
      return compressCommand(options, cwd);
    case 'status':
      return statusCommand(options, cwd);
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

function readOptionalInput(filePath) {
  if (!filePath) {
    return null;
  }

  return fs.readFileSync(filePath, 'utf8');
}

function formatError(error) {
  return `workmem error: ${error.message}`;
}

module.exports = {
  parseArgs,
  runCli,
  readOptionalInput,
  formatError
};
