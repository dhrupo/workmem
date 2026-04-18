'use strict';

const fs = require('fs');
const path = require('path');
const { loadRepoConfig } = require('./repo.js');
const {
  isGitRepo,
  getRepoRoot,
  getRepoName,
  detectBaseRef,
  getBranch,
  getHeadCommit,
  getChangedFiles,
  getDiff,
  getFileContent,
  getDiffStats
} = require('./git.js');
const { getRepoStore, writeJson, getLatestJson } = require('./storage.js');
const { compressText } = require('./compressor.js');
const { nowIso, estimateTokens, truncate } = require('./utils.js');

const RULE_FILES = [
  'AGENTS.md',
  'README.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.codex/reviewer.yml',
  '.codex/workmem.yml'
];

function buildContextCommand(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  const repoConfig = loadRepoConfig(repoRoot);
  const base = options.base || (repoConfig && repoConfig.base) || detectBaseRef(repoRoot);
  const changedFiles = applyIgnoredPaths(
    getChangedFiles(repoRoot, { ...options, base }),
    repoConfig && repoConfig.ignoredPaths
  );
  const limitedFiles = limitFiles(changedFiles, options.maxFiles || (repoConfig && repoConfig.maxFiles) || 12);
  const diff = getDiff(repoRoot, { ...options, base }, limitedFiles);
  const diffStats = getDiffStats(diff);
  const rules = loadRepoRules(repoRoot);
  const previousRun = getLatestJson(path.join(getRepoStore(repoRoot), 'runs'));
  const previousPacket = getLatestJson(path.join(getRepoStore(repoRoot), 'packets'));
  const mode = options.mode || 'balanced';
  const compressedRules = rules.map((rule) => ({
    path: rule.path,
    summary: compressText(rule.content, mode).output
  }));

  const packet = {
    id: `packet-${Date.now()}`,
    createdAt: nowIso(),
    repo: {
      name: getRepoName(repoRoot),
      root: repoRoot,
      branch: getBranch(repoRoot),
      commit: getHeadCommit(repoRoot),
      base
    },
    task: options.task || null,
    diffStats,
    changedFiles,
    highlightedFiles: buildHighlightedFiles(repoRoot, limitedFiles),
    rules: compressedRules,
    previousRun: previousRun ? summarizePreviousRun(previousRun) : null,
    previousPacket: previousPacket ? summarizePreviousPacket(previousPacket) : null
  };

  packet.packetSummary = buildPacketSummary(packet, mode);
  packet.metrics = {
    packetTokens: estimateTokens(JSON.stringify(packet.packetSummary)),
    diffTokens: estimateTokens(diff),
    reductionPercent: calculateReduction(estimateTokens(diff), estimateTokens(JSON.stringify(packet.packetSummary)))
  };

  const store = getRepoStore(repoRoot);
  writeJson(path.join(store, 'packets', `${Date.now()}.json`), packet);

  return renderPacket(packet, options.format || 'text');
}

function applyIgnoredPaths(files, ignoredPaths) {
  if (!ignoredPaths || !ignoredPaths.length) {
    return files;
  }

  return files.filter((file) => !ignoredPaths.some((ignore) => file.startsWith(ignore.replace(/\/+$/, ''))));
}

function limitFiles(files, maxFiles) {
  return files.slice(0, maxFiles);
}

function loadRepoRules(repoRoot) {
  const rules = [];
  for (const rulePath of RULE_FILES) {
    const fullPath = path.join(repoRoot, rulePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    rules.push({
      path: rulePath,
      content: fs.readFileSync(fullPath, 'utf8')
    });
  }
  return rules;
}

function buildHighlightedFiles(repoRoot, files) {
  return files.map((file) => {
    const content = getFileContent(repoRoot, file) || '';
    return {
      path: file,
      snippet: compressText(content.slice(0, 1800), 'balanced').output
    };
  });
}

function summarizePreviousRun(run) {
  return {
    id: run.id,
    task: run.task,
    kind: run.kind,
    createdAt: run.createdAt,
    findingCount: run.findings.length
  };
}

function summarizePreviousPacket(packet) {
  return {
    id: packet.id,
    createdAt: packet.createdAt,
    changedFiles: packet.changedFiles.length,
    packetTokens: packet.metrics ? packet.metrics.packetTokens : null
  };
}

function buildPacketSummary(packet, mode) {
  const lines = [
    `Task: ${packet.task || 'unspecified'}`,
    `Repo: ${packet.repo.name}`,
    `Branch: ${packet.repo.branch}`,
    `Base: ${packet.repo.base}`,
    `Commit: ${packet.repo.commit}`,
    `Changed files: ${packet.changedFiles.length}`,
    `Changed lines: ${packet.diffStats.changedLines}`
  ];

  if (packet.previousRun) {
    lines.push(`Previous run: ${packet.previousRun.kind} with ${packet.previousRun.findingCount} finding(s)`);
  }

  if (packet.rules.length) {
    lines.push('Relevant repo rules:');
    for (const rule of packet.rules) {
      lines.push(`- ${rule.path}: ${truncate(rule.summary.replace(/\n+/g, ' '), 220)}`);
    }
  }

  if (packet.highlightedFiles.length) {
    lines.push('Highlighted files:');
    for (const file of packet.highlightedFiles) {
      lines.push(`- ${file.path}: ${truncate(file.snippet.replace(/\n+/g, ' '), 220)}`);
    }
  }

  return compressText(lines.join('\n'), mode).output;
}

function renderPacket(packet, format) {
  if (format === 'json') {
    return JSON.stringify(packet, null, 2);
  }

  if (format === 'markdown') {
    return [
      '# Workmem Context Packet',
      '',
      `- Repo: \`${packet.repo.name}\``,
      `- Branch: \`${packet.repo.branch}\``,
      `- Base: \`${packet.repo.base}\``,
      `- Commit: \`${packet.repo.commit}\``,
      `- Changed files: ${packet.changedFiles.length}`,
      `- Changed lines: ${packet.diffStats.changedLines}`,
      `- Estimated raw diff tokens: ${packet.metrics.diffTokens}`,
      `- Estimated packet tokens: ${packet.metrics.packetTokens}`,
      `- Estimated reduction: ${packet.metrics.reductionPercent}%`,
      '',
      '## Summary',
      '',
      packet.packetSummary
    ].join('\n');
  }

  return [
    'Context Packet',
    `Repo: ${packet.repo.name}`,
    `Branch: ${packet.repo.branch}`,
    `Base: ${packet.repo.base}`,
    `Commit: ${packet.repo.commit}`,
    `Changed files: ${packet.changedFiles.length}`,
    `Changed lines: ${packet.diffStats.changedLines}`,
    `Estimated raw diff tokens: ${packet.metrics.diffTokens}`,
    `Estimated packet tokens: ${packet.metrics.packetTokens}`,
    `Estimated reduction: ${packet.metrics.reductionPercent}%`,
    '',
    'Summary',
    packet.packetSummary
  ].join('\n');
}

function calculateReduction(before, after) {
  if (!before) {
    return 0;
  }

  return Math.max(0, Math.round(((before - after) / before) * 100));
}

module.exports = {
  buildContextCommand
};
