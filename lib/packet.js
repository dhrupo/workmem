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
    summary: compressText(rule.content, mode, { type: 'rules' }).output
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
    highlightedFiles: buildHighlightedFiles(repoRoot, selectedPaths, diff),
    symbolHotspots: buildSymbolHotspots(repoRoot, selectedPaths, diff),
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

function buildHighlightedFiles(repoRoot, files, diffText) {
  const diffRanges = parseDiffRanges(diffText);
  return files.map((file) => {
    const content = getFileContent(repoRoot, file) || '';
    return {
      path: file,
      snippet: summarizeHighlightedContent(file, content, diffRanges.get(file) || [])
    };
  });
}

function buildSymbolHotspots(repoRoot, files, diffText) {
  const diffRanges = parseDiffRanges(diffText);
  const hotspots = [];

  for (const file of files) {
    const content = getFileContent(repoRoot, file) || '';
    const extension = path.extname(file).toLowerCase();
    const changedRanges = diffRanges.get(file) || [];
    if (!content.trim() || !changedRanges.length || !/\.(js|ts|jsx|tsx|vue|php)$/i.test(extension)) {
      continue;
    }
    if (looksLikeGeneratedArtifact(file, content, changedRanges)) {
      continue;
    }

    const symbols = extractChangedDeclarations(content, changedRanges);
    for (const symbol of symbols) {
      hotspots.push({
        file,
        type: symbol.type,
        line: symbol.line,
        text: symbol.text,
        score: scoreSymbolHotspot(file, symbol, changedRanges)
      });
    }
  }

  return hotspots
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.line - right.line)
    .slice(0, 10)
    .map((item) => ({
      file: item.file,
      type: item.type,
      line: item.line,
      text: item.text,
      score: item.score
    }));
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

function summarizeHighlightedContent(filePath, content, changedRanges = []) {
  const extension = path.extname(filePath).toLowerCase();
  if (!content.trim()) {
    return '(empty file)';
  }

  if (/\.(js|ts|jsx|tsx|vue|php)$/i.test(extension)) {
    return summarizeCodeContent(filePath, content, changedRanges);
  }

  if (/\.(md|markdown|txt|yml|yaml|json)$/i.test(extension)) {
    return summarizeTextContent(filePath, content, changedRanges);
  }

  return compressText(content.slice(0, 1800), 'balanced', { maxLines: 20 }).output;
}

function summarizeCodeContent(filePath, content, changedRanges = []) {
  if (looksLikeGeneratedArtifact(filePath, content, changedRanges)) {
    return summarizeGeneratedArtifact(filePath, content, changedRanges);
  }

  const lines = content.split('\n');
  const imports = [];
  const exportsList = [];
  const functions = [];
  const classes = [];
  const constants = [];
  const declarations = extractDeclarations(content);

  const summaryLines = [`File: ${filePath}`];
  appendChangedRanges(summaryLines, changedRanges);
  appendChangedSymbols(summaryLines, declarations, changedRanges);
  appendGroup(summaryLines, 'Imports', collectImports(content), 4);
  appendGroup(summaryLines, 'Exports', collectExports(content), 4);
  appendGroup(summaryLines, 'Classes', declarations.filter((item) => item.type === 'class').map((item) => item.text), 4);
  appendGroup(summaryLines, 'Functions', declarations.filter((item) => item.type === 'function').map((item) => item.text), 8);
  appendGroup(summaryLines, 'Constants', collectConstants(content), 4);

  if (summaryLines.length === 1) {
    summaryLines.push(`Preview: ${compressText(content.slice(0, 1200), 'balanced', { maxLines: 12 }).output}`);
  }

  return summaryLines.join('\n');
}

function extractDeclarations(content) {
  const lines = content.split('\n');
  const declarations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const lineNumber = index + 1;

    const functionMatch = trimmed.match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(|^(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_]+\s*=>)|^([A-Za-z0-9_]+)\s*:\s*(?:async\s*)?function\b|^(?!if\b|for\b|while\b|switch\b|catch\b|else\b)([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/);
    if (functionMatch) {
      declarations.push({ type: 'function', line: lineNumber, text: trimmed });
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
    if (classMatch) {
      declarations.push({ type: 'class', line: lineNumber, text: trimmed });
      continue;
    }
  }

  return declarations;
}

function collectImports(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((trimmed) => /^(import\s.+|const\s.+?=\s*require\(|use\s+[A-Za-z0-9_\\]+;)/.test(trimmed));
}

function collectExports(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((trimmed) => /^(export\s+(default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+[A-Za-z0-9_]+|module\.exports\s*=|exports\.[A-Za-z0-9_]+\s*=)/.test(trimmed));
}

function collectConstants(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((trimmed) => /^(const|let|var)\s+[A-Z0-9_]{3,}\s*=/.test(trimmed));
}

function extractChangedDeclarations(content, changedRanges) {
  const declarations = extractDeclarations(content);
  const matches = [];

  for (const range of changedRanges) {
    const containing = declarations.filter((item) => item.line >= range.start && item.line <= range.end);
    const nearby = containing.length ? containing : findNearestDeclarations(declarations, range.start, 2);
    for (const item of nearby) {
      matches.push(item);
    }
  }

  const seen = new Set();
  return matches.filter((item) => {
    const key = `${item.type}:${item.line}:${item.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function scoreSymbolHotspot(file, symbol, changedRanges) {
  let score = 0;
  const symbolText = String(symbol.text || '');
  const normalized = symbolText.toLowerCase();

  score += symbol.type === 'class' ? 4 : 3;
  if (/auth|payment|config|migration|route|controller|service|api/i.test(file)) {
    score += 4;
  }
  if (/test/i.test(file)) {
    score += 1;
  }

  if (/\b(handle|process|save|update|delete|remove|create|submit|verify|validate|authorize|authenticate|login|logout|sync|migrate|dispatch|send|persist|write)\b/.test(normalized)) {
    score += 3;
  }
  if (/\b(payment|billing|subscription|invoice|checkout|cart|order|transaction|webhook|nonce|token|session|password|permission|capability|header|request|response|route|controller|service|model|config|settings|cache|queue|job)\b/.test(normalized)) {
    score += 4;
  }
  if (/\b(test|spec|fixture|mock)\b/.test(normalized)) {
    score += 1;
  }
  if (/^(export\s+|module\.exports|exports\.)/.test(symbolText)) {
    score += 1;
  }
  if (normalized.includes('async')) {
    score += 1;
  }
  score += Math.min(3, changedRanges.length);
  if (symbol.line <= 120) {
    score += 1;
  }

  const changeDensity = changedRanges.reduce((total, range) => total + Math.max(1, range.end - range.start + 1), 0);
  if (changeDensity >= 40) {
    score += 1;
  }

  return score;
}

function looksLikeGeneratedArtifact(filePath, content, changedRanges) {
  const lineCount = content.split('\n').length;
  const minifiedMarkers = (content.match(/\/\*\*\*\*\*\/|webpackBootstrap|__webpack_require__|sourceMappingURL|function\(_0x[a-f0-9]+/g) || []).length;
  const hugeSingleRange = changedRanges.some((range) => range.start === 1 && (range.end - range.start) > 1500);

  return /\.(min\.js|bundle\.js|chunk\.js)$/i.test(filePath)
    || (lineCount > 1500 && minifiedMarkers >= 3)
    || (lineCount > 4000 && hugeSingleRange);
}

function summarizeGeneratedArtifact(filePath, content, changedRanges) {
  const lines = content.split('\n');
  const summaryLines = [
    `File: ${filePath}`,
    'Generated artifact: likely compiled/bundled output'
  ];
  appendChangedRanges(summaryLines, changedRanges);
  summaryLines.push(`Line count: ${lines.length}`);

  const likelySources = inferLikelySourceFiles(filePath);
  if (likelySources.length) {
    summaryLines.push('Review source instead:');
    for (const source of likelySources) {
      summaryLines.push(`- ${source}`);
    }
  }

  return summaryLines.join('\n');
}

function inferLikelySourceFiles(filePath) {
  const candidates = [];
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.startsWith('assets/js/')) {
    const base = path.basename(normalized).replace(/\.min(?=\.)/, '').replace(/\.[^.]+$/, '');
    candidates.push(`resources/**/*.${base}.{js,ts,vue}`);
    candidates.push(`guten_block/src/**/${base}.{js,jsx,ts,tsx}`);
  }

  if (normalized.startsWith('dist/') || normalized.startsWith('build/')) {
    candidates.push('src/**/*');
    candidates.push('resources/**/*');
  }

  return candidates;
}

function summarizeTextContent(filePath, content, changedRanges = []) {
  const lines = content.split('\n');
  const summaryLines = [`File: ${filePath}`];
  appendChangedRanges(summaryLines, changedRanges);

  if (changedRanges.length) {
    summaryLines.push('Changed snippets:');
    for (const range of changedRanges.slice(0, 3)) {
      const start = Math.max(0, range.start - 1);
      const end = Math.min(lines.length, range.end);
      const snippet = lines.slice(start, end).join('\n');
      const compressed = compressText(snippet, 'balanced', { type: 'rules', maxLines: 6 }).output;
      summaryLines.push(`- ${range.start}-${range.end}: ${truncate(compressed.replace(/\n+/g, ' '), 180)}`);
    }
    return summaryLines.join('\n');
  }

  summaryLines.push(compressText(content.slice(0, 2400), 'balanced', { type: 'rules', maxLines: 24 }).output);
  return summaryLines.join('\n');
}

function appendGroup(lines, label, items, limit) {
  const uniqueItems = Array.from(new Set(items)).slice(0, limit);
  if (!uniqueItems.length) {
    return;
  }
  lines.push(`${label}:`);
  for (const item of uniqueItems) {
    lines.push(`- ${truncate(item, 140)}`);
  }
}

function appendChangedRanges(lines, changedRanges) {
  if (!changedRanges.length) {
    return;
  }
  const rendered = changedRanges
    .slice(0, 4)
    .map((range) => `${range.start}-${range.end}`)
    .join(', ');
  lines.push(`Changed lines: ${rendered}`);
}

function appendChangedSymbols(lines, declarations, changedRanges) {
  if (!changedRanges.length || !declarations.length) {
    return;
  }

  const matches = [];
  for (const range of changedRanges) {
    const containing = declarations.filter((item) => item.line >= range.start && item.line <= range.end);
    const nearby = containing.length ? containing : findNearestDeclarations(declarations, range.start, 2);
    for (const item of nearby) {
      matches.push(`${item.type}: ${item.text}`);
    }
  }

  const uniqueMatches = Array.from(new Set(matches)).slice(0, 6);
  if (!uniqueMatches.length) {
    return;
  }

  lines.push('Changed symbols:');
  for (const item of uniqueMatches) {
    lines.push(`- ${truncate(item, 140)}`);
  }
}

function findNearestDeclarations(declarations, lineNumber, limit) {
  return declarations
    .map((item) => ({ ...item, distance: Math.abs(item.line - lineNumber) }))
    .sort((left, right) => left.distance - right.distance || left.line - right.line)
    .slice(0, limit);
}

function parseDiffRanges(diffText) {
  const ranges = new Map();
  if (!diffText) {
    return ranges;
  }

  let currentFile = null;
  const lines = diffText.split('\n');
  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      if (!ranges.has(currentFile)) {
        ranges.set(currentFile, []);
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) {
      continue;
    }

    const start = Number.parseInt(hunkMatch[1], 10);
    const length = Number.parseInt(hunkMatch[2] || '1', 10);
    const end = Math.max(start, start + Math.max(length - 1, 0));
    ranges.get(currentFile).push({ start, end });
  }

  for (const [file, fileRanges] of ranges.entries()) {
    ranges.set(file, mergeRanges(fileRanges));
  }

  return ranges;
}

function mergeRanges(ranges) {
  if (!ranges.length) {
    return [];
  }

  const sorted = ranges
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 2) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
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
      lines.push(`- ${file.path}: ${truncate(compactHighlightedSnippet(file.snippet), 220)}`);
    }
  }

  if (packet.symbolHotspots && packet.symbolHotspots.length) {
    lines.push('Changed symbols:');
    for (const symbol of packet.symbolHotspots.slice(0, 6)) {
      lines.push(`- ${symbol.file}:${symbol.line} ${symbol.type} ${truncate(symbol.text, 140)}`);
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

function compactHighlightedSnippet(snippet) {
  const lines = String(snippet || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const filtered = [];
  for (const line of lines) {
    if (/^Changed symbols:/i.test(line)) {
      continue;
    }
    if (/^- function:/i.test(line) || /^- class:/i.test(line)) {
      continue;
    }
    filtered.push(line);
  }

  return filtered.join(' ');
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
      `- Estimated reduction: ${formatPacketReduction(packet.metrics)}`,
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
    `Estimated reduction: ${formatPacketReduction(packet.metrics)}`,
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
    `Estimated reduction: ${formatPacketReduction(packet.metrics)}`,
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

  return Math.max(0, Number((((before - after) / before) * 100).toFixed(1)));
}

function formatPacketReduction(metrics) {
  if (!metrics || !metrics.diffTokens) {
    return 'No diff to compress';
  }
  return `${metrics.reductionPercent}%`;
}

module.exports = {
  buildContextCommand
};
