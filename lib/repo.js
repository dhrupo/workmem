'use strict';

const fs = require('fs');
const path = require('path');
const { isGitRepo, getRepoRoot, detectBaseRef } = require('./git.js');

const DEFAULT_IGNORES = [
  '.workmem/',
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  'builds/'
];

function initCommand(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  const workmemDir = path.join(repoRoot, '.workmem');
  const configPath = path.join(workmemDir, 'config.json');
  const ignorePath = path.join(workmemDir, 'ignore');
  const gitExcludePath = path.join(repoRoot, '.git', 'info', 'exclude');

  fs.mkdirSync(workmemDir, { recursive: true });
  fs.mkdirSync(path.join(workmemDir, 'snapshots'), { recursive: true });

  const config = {
    base: options.base || detectBaseRef(repoRoot),
    compressionMode: 'balanced',
    maxFiles: 12,
    ignoredPaths: Array.from(new Set(DEFAULT_IGNORES.concat(options.ignore || [])))
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(ignorePath, `${config.ignoredPaths.join('\n')}\n`);
  addToGitExclude(gitExcludePath, '.workmem/');

  return [
    'Workmem Initialized',
    `Repo: ${repoRoot}`,
    `Config: ${configPath}`,
    `Ignore file: ${ignorePath}`,
    `Default base: ${config.base}`,
    `Git exclude updated: ${gitExcludePath}`
  ].join('\n');
}

function addToGitExclude(excludePath, entry) {
  if (!fs.existsSync(excludePath)) {
    return;
  }

  const current = fs.readFileSync(excludePath, 'utf8');
  if (current.split('\n').includes(entry)) {
    return;
  }

  const suffix = current.length && !current.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(excludePath, `${current}${suffix}${entry}\n`);
}

function loadRepoConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.workmem', 'config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function getRepoConfigPath(repoRoot) {
  return path.join(repoRoot, '.workmem', 'config.json');
}

module.exports = {
  initCommand,
  loadRepoConfig,
  getRepoConfigPath
};
