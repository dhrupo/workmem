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
const { readJson, listJsonFiles } = require('./storage.js');

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
  const rankedFiles = rankFiles(repoRoot, changedFiles, options.rank || 'risk');
  const limitedFiles = rankedFiles.slice(0, options.maxFiles || (repoConfig && repoConfig.maxFiles) || 12);
  const selectedPaths = limitedFiles.map((entry) => entry.path);
  const diff = getDiff(repoRoot, { ...options, base }, selectedPaths);
  const diffStats = getDiffStats(diff);
  const rules = loadRepoRules(repoRoot);
  const previousRun = selectPreviousRun(repoRoot, options);
  const previousPacket = getLatestJson(path.join(getRepoStore(repoRoot), 'packets'));
  const mode = options.mode || 'balanced';
  const target = options.target || 'generic';
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
    target,
    diffStats,
    changedFiles,
    highlightedFiles: buildHighlightedFiles(repoRoot, selectedPaths),
    ranking: limitedFiles,
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

  return renderPacket(packet, options.format || 'text', options);
}

function applyIgnoredPaths(files, ignoredPaths) {
  if (!ignoredPaths || !ignoredPaths.length) {
    return files;
  }

  return files.filter((file) => !ignoredPaths.some((ignore) => file.startsWith(ignore.replace(/\/+$/, ''))));
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

function rankFiles(repoRoot, files, strategy) {
  return files.map((file) => {
    const content = getFileContent(repoRoot, file) || '';
    const score = scoreFile(file, content, strategy);
    return {
      path: file,
      score: score.value,
      why: score.why
    };
  }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function scoreFile(file, content, strategy) {
  let value = 0;
  const why = [];
  if (/auth|payment|config|migration|route|controller|service|api/i.test(file)) {
    value += 5;
    why.push('high-risk path');
  }
  if (/test/i.test(file)) {
    value += 1;
    why.push('test-related');
  }
  if (/\.(php|js|ts|vue|jsx|tsx)$/i.test(file)) {
    value += 3;
    why.push('code file');
  }
  if (content.length > 2000) {
    value += 2;
    why.push('large file');
  }
  if (strategy === 'size') {
    value += Math.min(5, Math.ceil(content.length / 4000));
    why.push('size-ranked');
  }
  return { value, why };
}

function selectPreviousRun(repoRoot, options) {
  const store = getRepoStore(repoRoot);
  const runs = listJsonFiles(path.join(store, 'runs')).map((filePath) => readJson(filePath));
  if (!runs.length) {
    return null;
  }
  return runs[runs.length - 1];
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

  if (packet.ranking && packet.ranking.length) {
    lines.push('Top hotspots:');
    for (const entry of packet.ranking.slice(0, 5)) {
      lines.push(`- ${entry.path}: ${entry.why.join(', ') || 'selected'}`);
    }
  }

  return compressText(lines.join('\n'), mode).output;
}

function renderPacket(packet, format, options = {}) {
  if (format === 'json') {
    return JSON.stringify(packet, null, 2);
  }

  if (packet.target === 'codex') {
    return renderTargetPacket(packet, format, 'codex');
  }

  if (packet.target === 'claude') {
    return renderTargetPacket(packet, format, 'claude');
  }

  if (packet.target === 'cursor') {
    return renderTargetPacket(packet, format, 'cursor');
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

function renderTargetPacket(packet, format, target) {
  const header = target === 'codex'
    ? 'Task Packet For Codex'
    : target === 'claude'
      ? 'Task Packet For Claude'
      : 'Task Packet For Cursor';

  const sections = [
    header,
    `Task: ${packet.task || 'unspecified'}`,
    `Repo: ${packet.repo.name}`,
    `Branch: ${packet.repo.branch}`,
    `Base: ${packet.repo.base}`,
    `Changed files: ${packet.changedFiles.length}`,
    `Estimated reduction: ${packet.metrics.reductionPercent}%`,
    '',
    'Packet',
    packet.packetSummary
  ];

  if (format === 'markdown') {
    return `# ${header}\n\n${sections.slice(1).join('\n')}`;
  }

  return sections.join('\n');
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
