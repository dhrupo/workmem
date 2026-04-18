'use strict';

const fs = require('fs');
const { initCommand, loadRepoConfig, getRepoConfigPath } = require('./repo.js');
const { buildContextCommand } = require('./packet.js');
const {
  saveRunCommand,
  recheckCommand,
  statusCommand,
  listRunsCommand,
  showRunCommand,
  pruneCommand,
  clearCommand
} = require('./runs.js');
const { compressCommand } = require('./compressor.js');
const { isGitRepo, getRepoRoot } = require('./git.js');

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
    result.helpCommand = argv[1] || null;
    return result;
  }

  if (argv[0] === '-v' || argv[0] === '--version') {
    result.version = true;
    return result;
  }

  result.command = argv[0];

  if (argv[1] === '-h' || argv[1] === '--help') {
    result.help = true;
    return result;
  }

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
      case '--source':
      case '--target':
      case '--type':
      case '--against':
      case '--rank':
      case '--keep':
      case '--days':
      case '--runs':
      case '--config':
      case '--max-lines':
      case '--max-tokens':
        if (!next || next.startsWith('-')) {
          throw new Error(`Missing value for ${token}`);
        }
        result[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
        index += 1;
        break;
      case '--staged':
        result.staged = true;
        break;
      case '--verbose':
      case '--dry-run':
      case '--yes':
      case '--packets-only':
      case '--show-ranking':
      case '--show-metrics':
        result[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
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

  if (result.keep) {
    result.keep = Number.parseInt(result.keep, 10);
  }

  if (result.days) {
    result.days = Number.parseInt(result.days, 10);
  }

  if (result.runs) {
    result.runs = Number.parseInt(result.runs, 10);
  }

  if (result.maxLines) {
    result.maxLines = Number.parseInt(result.maxLines, 10);
  }

  if (result.maxTokens) {
    result.maxTokens = Number.parseInt(result.maxTokens, 10);
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
    case 'list-runs':
      return listRunsCommand(options, cwd);
    case 'show-run':
      return showRunCommand(options, cwd);
    case 'prune':
      return pruneCommand(options, cwd);
    case 'clear':
      return clearCommand(options, cwd);
    case 'config':
      return configCommand(options, cwd);
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

function configCommand(options, cwd) {
  const repoPath = options.repo || cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  const config = loadRepoConfig(repoRoot);
  if (!config) {
    throw new Error(`No repo config found at ${getRepoConfigPath(repoRoot)}`);
  }

  if ((options.format || 'text') === 'json') {
    return JSON.stringify({
      repoRoot,
      configPath: getRepoConfigPath(repoRoot),
      config
    }, null, 2);
  }

  return [
    'Workmem Config',
    `Repo: ${repoRoot}`,
    `Path: ${getRepoConfigPath(repoRoot)}`,
    `Base: ${config.base || 'auto'}`,
    `Compression mode: ${config.compressionMode || 'balanced'}`,
    `Max files: ${config.maxFiles || 12}`,
    `Ignored paths: ${(config.ignoredPaths || []).length}`
  ].join('\n');
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
