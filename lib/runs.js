'use strict';

const fs = require('fs');
const path = require('path');
const { loadRepoConfig } = require('./repo.js');
const {
  isGitRepo,
  getRepoRoot,
  getRepoName,
  getBranch,
  getHeadCommit
} = require('./git.js');
const {
  getRepoStore,
  writeJson,
  readJson,
  listJsonFiles,
  getLatestJson
} = require('./storage.js');
const { nowIso, sha1 } = require('./utils.js');

function saveRunCommand(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  loadRepoConfig(repoRoot);
  const inputPath = options.input ? path.resolve(cwd, options.input) : null;
  if (!inputPath) {
    throw new Error('save-run requires --input <path>');
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const payload = parseRunInput(raw, inputPath);
  const run = normalizeRun(payload, {
    repoRoot,
    repoName: getRepoName(repoRoot),
    branch: options.branch || getBranch(repoRoot),
    commit: options.commit || getHeadCommit(repoRoot),
    task: options.task || payload.task || null,
    kind: options.kind || payload.kind || 'review'
  });

  const store = getRepoStore(repoRoot);
  const fileName = `${Date.now()}-${run.id}.json`;
  writeJson(path.join(store, 'runs', fileName), run);

  for (const finding of run.findings) {
    writeJson(path.join(store, 'findings', `${finding.fingerprint}.json`), finding);
  }

  return renderRunSaved(run, options.format || 'text');
}

function recheckCommand(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  loadRepoConfig(repoRoot);
  const store = getRepoStore(repoRoot);
  const latestRun = options.runId ? findRunById(store, options.runId) : getLatestJson(path.join(store, 'runs'));
  if (!latestRun) {
    throw new Error('No saved run found for this repo');
  }

  let currentRun = null;
  if (options.input) {
    const raw = fs.readFileSync(path.resolve(cwd, options.input), 'utf8');
    currentRun = normalizeRun(parseRunInput(raw, options.input), {
      repoRoot,
      repoName: getRepoName(repoRoot),
      branch: getBranch(repoRoot),
      commit: getHeadCommit(repoRoot),
      task: options.task || null,
      kind: 'review'
    });
  } else {
    const runs = loadRuns(path.join(store, 'runs'));
    if (runs.length < 2) {
      throw new Error('recheck requires --input or at least two saved runs');
    }
    currentRun = runs[runs.length - 1];
    return renderRecheck(compareRuns(runs[runs.length - 2], currentRun), options.format || 'text');
  }

  return renderRecheck(compareRuns(latestRun, currentRun), options.format || 'text');
}

function statusCommand(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }

  const repoRoot = getRepoRoot(repoPath);
  loadRepoConfig(repoRoot);
  const store = getRepoStore(repoRoot);
  const runs = loadRuns(path.join(store, 'runs'));
  const findings = listJsonFiles(path.join(store, 'findings'));
  const packets = listJsonFiles(path.join(store, 'packets'));
  const latestRun = runs.length ? runs[runs.length - 1] : null;

  const status = {
    repo: getRepoName(repoRoot),
    branch: getBranch(repoRoot),
    commit: getHeadCommit(repoRoot),
    runCount: runs.length,
    findingCount: findings.length,
    packetCount: packets.length,
    latestRun
  };

  return renderStatus(status, options.format || 'text');
}

function parseRunInput(raw, inputPath) {
  if (inputPath.endsWith('.json')) {
    return JSON.parse(raw);
  }

  return {
    summary: raw.trim(),
    findings: []
  };
}

function normalizeRun(payload, context) {
  const findings = Array.isArray(payload.findings) ? payload.findings.map((finding) => normalizeFinding(finding)) : [];
  const summary = payload.summary || payload.overview || '';

  return {
    id: sha1(`${context.repoRoot}:${context.commit}:${context.task || summary}:${Date.now()}`).slice(0, 12),
    createdAt: nowIso(),
    repo: context.repoName,
    repoRoot: context.repoRoot,
    branch: context.branch,
    commit: context.commit,
    task: context.task,
    kind: context.kind,
    summary,
    findings
  };
}

function normalizeFinding(finding) {
  const file = finding.file || finding.path || 'unknown';
  const line = Number.isInteger(finding.line) ? finding.line : 1;
  const title = finding.title || finding.name || 'Untitled finding';
  const severity = finding.severity || 'medium';
  const evidence = finding.evidence || finding.explanation || '';
  const fingerprint = finding.fingerprint || sha1(`${file}:${line}:${title}:${severity}`).slice(0, 12);

  return {
    fingerprint,
    file,
    line,
    title,
    severity,
    confidence: finding.confidence || 'medium',
    evidence,
    impact: finding.impact || '',
    explanation: finding.explanation || '',
    verification: finding.verification || '',
    fixDirection: finding.fixDirection || finding.fix_direction || ''
  };
}

function compareRuns(previousRun, currentRun) {
  const previousMap = new Map(previousRun.findings.map((finding) => [finding.fingerprint, finding]));
  const currentMap = new Map(currentRun.findings.map((finding) => [finding.fingerprint, finding]));
  const fixed = [];
  const stillPresent = [];
  const newFindings = [];

  for (const [fingerprint, finding] of previousMap) {
    if (currentMap.has(fingerprint)) {
      stillPresent.push(currentMap.get(fingerprint));
    } else {
      fixed.push(finding);
    }
  }

  for (const [fingerprint, finding] of currentMap) {
    if (!previousMap.has(fingerprint)) {
      newFindings.push(finding);
    }
  }

  return {
    previousRun: {
      id: previousRun.id,
      commit: previousRun.commit,
      createdAt: previousRun.createdAt,
      findingCount: previousRun.findings.length
    },
    currentRun: {
      id: currentRun.id,
      commit: currentRun.commit,
      createdAt: currentRun.createdAt,
      findingCount: currentRun.findings.length
    },
    fixed,
    stillPresent,
    newFindings
  };
}

function loadRuns(dirPath) {
  return listJsonFiles(dirPath).map((filePath) => readJson(filePath));
}

function findRunById(store, runId) {
  const runs = loadRuns(path.join(store, 'runs'));
  return runs.find((run) => run.id === runId) || null;
}

function renderRunSaved(run, format) {
  if (format === 'json') {
    return JSON.stringify(run, null, 2);
  }

  if (format === 'markdown') {
    return [
      '# Run Saved',
      '',
      `- ID: \`${run.id}\``,
      `- Kind: \`${run.kind}\``,
      `- Repo: \`${run.repo}\``,
      `- Branch: \`${run.branch}\``,
      `- Commit: \`${run.commit}\``,
      `- Findings: ${run.findings.length}`
    ].join('\n');
  }

  return [
    'Run Saved',
    `ID: ${run.id}`,
    `Kind: ${run.kind}`,
    `Repo: ${run.repo}`,
    `Branch: ${run.branch}`,
    `Commit: ${run.commit}`,
    `Findings: ${run.findings.length}`
  ].join('\n');
}

function renderRecheck(result, format) {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    'Recheck',
    `Previous run: ${result.previousRun.id} (${result.previousRun.findingCount} finding(s))`,
    `Current run: ${result.currentRun.id} (${result.currentRun.findingCount} finding(s))`,
    `Fixed: ${result.fixed.length}`,
    `Still present: ${result.stillPresent.length}`,
    `New: ${result.newFindings.length}`
  ];

  if (result.fixed.length) {
    lines.push('', 'Fixed findings:');
    for (const finding of result.fixed) {
      lines.push(`- [${finding.fingerprint}] ${finding.title}`);
    }
  }

  if (result.stillPresent.length) {
    lines.push('', 'Still present findings:');
    for (const finding of result.stillPresent) {
      lines.push(`- [${finding.fingerprint}] ${finding.title}`);
    }
  }

  if (result.newFindings.length) {
    lines.push('', 'New findings:');
    for (const finding of result.newFindings) {
      lines.push(`- [${finding.fingerprint}] ${finding.title}`);
    }
  }

  if (format === 'markdown') {
    return lines.map((line) => (line.startsWith('- ') ? line : line)).join('\n');
  }

  return lines.join('\n');
}

function renderStatus(status, format) {
  if (format === 'json') {
    return JSON.stringify(status, null, 2);
  }

  const lines = [
    'Workmem Status',
    `Repo: ${status.repo}`,
    `Branch: ${status.branch}`,
    `Commit: ${status.commit}`,
    `Saved runs: ${status.runCount}`,
    `Saved findings: ${status.findingCount}`,
    `Saved packets: ${status.packetCount}`
  ];

  if (status.latestRun) {
    lines.push(`Latest run: ${status.latestRun.id} (${status.latestRun.findings.length} finding(s))`);
  }

  return lines.join('\n');
}

module.exports = {
  saveRunCommand,
  recheckCommand,
  statusCommand,
  compareRuns
};
