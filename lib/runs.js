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
  getRepoStoreByRoot,
  writeJson,
  readJson,
  listJsonFiles,
  getLatestJson,
  deleteFile,
  deleteDir,
  getDirSize
} = require('./storage.js');
const {
  nowIso,
  sha1,
  normalizeKey,
  lineBucket,
  similarity,
  formatBytes
} = require('./utils.js');

function saveRunCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const config = loadRepoConfig(repoRoot);
  const inputPath = options.input ? path.resolve(cwd, options.input) : null;
  if (!inputPath) {
    throw new Error('save-run requires --input <path>');
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const payload = parseRunInput(raw, inputPath);
  const metadata = inferRepoMetadata(repoRoot, options, payload, config);
  const store = getRepoStore(repoRoot);
  const baseline = selectBaselineRun(loadRuns(path.join(store, 'runs')), metadata, {
    runId: options.runId,
    against: options.against
  });
  const run = normalizeRun(payload, metadata, baseline);

  writeJson(path.join(store, 'runs', `${Date.now()}-${run.id}.json`), run);
  syncFindingIndex(store, loadRuns(path.join(store, 'runs')));

  return renderRunSaved(run, options.format || 'text');
}

function recheckCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const config = loadRepoConfig(repoRoot);
  const store = getRepoStore(repoRoot);
  const runs = loadRuns(path.join(store, 'runs'));
  if (!runs.length) {
    throw new Error('No saved run found for this repo');
  }

  let currentRun = null;
  let baseline = null;
  const selection = { runId: options.runId, against: options.against };

  if (options.input) {
    const raw = fs.readFileSync(path.resolve(cwd, options.input), 'utf8');
    const payload = parseRunInput(raw, options.input);
    const metadata = inferRepoMetadata(repoRoot, options, payload, config);
    baseline = selectBaselineRun(runs, metadata, selection);
    currentRun = normalizeRun(payload, metadata, baseline);
  } else {
    if (runs.length < 2) {
      throw new Error('recheck requires --input or at least two saved runs');
    }
    currentRun = runs[runs.length - 1];
    baseline = selectBaselineRun(runs.slice(0, -1), currentRun, selection) || runs[runs.length - 2];
  }

  if (!baseline) {
    throw new Error('No suitable baseline run found');
  }

  const result = compareRuns(baseline, currentRun);
  writeJson(path.join(store, 'rechecks', `${Date.now()}-${result.currentRun.id}.json`), result);
  syncFindingIndex(store, runs.concat(options.input ? [currentRun] : []));
  return renderRecheck(result, options.format || 'text');
}

function statusCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const config = loadRepoConfig(repoRoot);
  const store = getRepoStore(repoRoot);
  const runs = loadRuns(path.join(store, 'runs'));
  const packets = listJsonFiles(path.join(store, 'packets')).map((filePath) => readJson(filePath));
  const rechecks = listJsonFiles(path.join(store, 'rechecks')).map((filePath) => readJson(filePath));
  const latestRun = runs[runs.length - 1] || null;
  const latestPacket = packets[packets.length - 1] || null;
  const latestRecheck = rechecks[rechecks.length - 1] || null;
  const openFindings = buildOpenFindings(runs);

  const status = {
    repo: getRepoName(repoRoot),
    repoRoot,
    branch: getBranch(repoRoot),
    commit: getHeadCommit(repoRoot),
    runCount: runs.length,
    packetCount: packets.length,
    recheckCount: rechecks.length,
    storePath: store,
    storeSize: getDirSize(store),
    config: config || null,
    latestRun: latestRun ? summarizeRun(latestRun) : null,
    latestPacket: latestPacket ? summarizePacket(latestPacket) : null,
    latestRecheck: latestRecheck ? summarizeRecheck(latestRecheck) : null,
    openFindings,
    health: deriveHealth(runs, openFindings, latestRecheck)
  };

  return renderStatus(status, options.format || 'text', options);
}

function listRunsCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const runs = loadRuns(path.join(getRepoStore(repoRoot), 'runs')).reverse();
  const limit = options.runs || 10;
  const selected = runs.slice(0, limit).map(summarizeRun);

  if ((options.format || 'text') === 'json') {
    return JSON.stringify(selected, null, 2);
  }

  return [
    'Saved Runs',
    ...selected.map((run) => `- ${run.id} | ${run.kind} | ${run.task || 'no-task'} | ${run.findingCount} finding(s) | ${run.commit}`)
  ].join('\n');
}

function showRunCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const store = getRepoStore(repoRoot);
  const runs = loadRuns(path.join(store, 'runs'));
  const run = options.runId
    ? runs.find((item) => item.id === options.runId)
    : runs[runs.length - 1];

  if (!run) {
    throw new Error('Run not found');
  }

  if ((options.format || 'text') === 'json') {
    return JSON.stringify(run, null, 2);
  }

  return [
    'Run',
    `ID: ${run.id}`,
    `Kind: ${run.kind}`,
    `Task: ${run.task || 'none'}`,
    `Source: ${run.source || 'generic'}`,
    `Branch: ${run.branch}`,
    `Base: ${run.baseRef || 'unknown'}`,
    `Commit: ${run.commit}`,
    `Files reviewed: ${run.scope && run.scope.fileCount ? run.scope.fileCount : 0}`,
    `Findings: ${run.findings.length}`,
    `Summary: ${run.summary || ''}`
  ].join('\n');
}

function pruneCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  const store = getRepoStore(repoRoot);
  const keep = options.keep || 20;
  const packetsOnly = Boolean(options.packetsOnly);
  const dryRun = Boolean(options.dryRun);
  const removed = [];

  if (packetsOnly) {
    removed.push(...pruneDir(path.join(store, 'packets'), keep, dryRun));
  } else {
    removed.push(...pruneDir(path.join(store, 'packets'), keep, dryRun));
    removed.push(...pruneDir(path.join(store, 'runs'), keep, dryRun));
    removed.push(...pruneDir(path.join(store, 'rechecks'), keep, dryRun));
  }

  return [
    dryRun ? 'Prune Preview' : 'Prune Complete',
    `Removed files: ${removed.length}`,
    ...removed.map((filePath) => `- ${filePath}`)
  ].join('\n');
}

function clearCommand(options, cwd) {
  const repoRoot = resolveRepoRoot(options, cwd);
  if (!options.yes) {
    throw new Error('clear is destructive; rerun with --yes');
  }

  const store = getRepoStore(repoRoot);
  deleteDir(store);
  return [
    'Workmem Cleared',
    `Repo: ${repoRoot}`,
    `Removed: ${store}`
  ].join('\n');
}

function parseRunInput(raw, inputPath) {
  if (inputPath.endsWith('.json')) {
    return normalizePayload(JSON.parse(raw));
  }

  return normalizePayload(parseTextRunInput(raw));
}

function normalizeRun(payload, metadata, baseline) {
  const findings = Array.isArray(payload.findings) ? payload.findings.map((finding) => normalizeFinding(finding)) : [];
  const summary = payload.summary || payload.overview || '';
  const idSeed = `${metadata.repoRoot}:${metadata.commit}:${metadata.task || summary}:${Date.now()}`;

  return {
    id: `run_${sha1(idSeed).slice(0, 12)}`,
    createdAt: nowIso(),
    repo: {
      name: metadata.repoName,
      root: metadata.repoRoot
    },
    branch: metadata.branch,
    baseRef: metadata.baseRef,
    commit: metadata.commit,
    task: metadata.task,
    kind: metadata.kind,
    source: metadata.source,
    scope: metadata.scope,
    baseline: baseline ? {
      runId: baseline.id,
      selectionReason: baseline.selectionReason || 'auto'
    } : null,
    summary,
    findings
  };
}

function normalizeFinding(finding) {
  const file = normalizePathKey(finding.file || finding.path || 'unknown');
  const line = normalizeLine(finding.line || finding.startLine || finding.lineNumber || extractLine(finding.location));
  const title = String(finding.title || finding.name || finding.summary || 'Untitled finding').trim();
  const severity = normalizeSeverity(finding.severity || finding.level || finding.priority || 'medium');
  const evidence = String(finding.evidence || finding.explanation || finding.message || '').trim();
  const fileKey = normalizeKey(file);
  const titleKey = normalizeKey(title);
  const evidenceKey = normalizeKey(evidence);
  const anchorKey = `${fileKey}:${lineBucket(line)}`;
  const semanticKey = sha1(`${fileKey}:${titleKey || evidenceKey}`);
  const fingerprint = finding.fingerprint || sha1(`${semanticKey}:${severity}`);

  return {
    fingerprint,
    semanticKey,
    fileKey,
    titleKey,
    evidenceKey,
    anchorKey,
    file,
    line,
    title,
    severity,
    confidence: normalizeConfidence(finding.confidence || finding.certainty || 'medium'),
    evidence,
    impact: finding.impact || '',
    explanation: finding.explanation || '',
    verification: finding.verification || '',
    fixDirection: finding.fixDirection || finding.fix_direction || ''
  };
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { summary: '', findings: [] };
  }

  return {
    summary: payload.summary || payload.overview || payload.message || payload.verdict || '',
    task: payload.task || payload.title || null,
    kind: payload.kind || payload.type || null,
    source: payload.source || payload.agent || null,
    findings: firstArray(payload, ['findings', 'issues', 'comments', 'observations', 'problems', 'warnings']) || []
  };
}

function parseTextRunInput(raw) {
  const trimmed = raw.trim();
  const findings = [];
  const lines = trimmed.split('\n');
  let inFindings = false;

  for (const line of lines) {
    const current = line.trim();
    if (!current) {
      continue;
    }

    if (/^#{1,6}\s*(findings|issues|problems|warnings|concerns)\b/i.test(current)) {
      inFindings = true;
      continue;
    }

    if (/^#{1,6}\s+/.test(current)) {
      inFindings = false;
      continue;
    }

    if (inFindings && /^([-*]|\d+\.)\s+/.test(current)) {
      findings.push(parseBulletFinding(current.replace(/^([-*]|\d+\.)\s+/, '')));
    }
  }

  return {
    summary: lines[0] || trimmed,
    findings
  };
}

function parseBulletFinding(text) {
  const severityMatch = text.match(/^\[?(critical|important|medium|low|high|warning|warn|error)\]?\s*/i);
  const severity = severityMatch ? normalizeSeverity(severityMatch[1]) : 'medium';
  const withoutSeverity = severityMatch ? text.slice(severityMatch[0].length) : text;
  const fileMatch = withoutSeverity.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::(\d+))?/);
  const file = fileMatch ? fileMatch[1] : 'unknown';
  const line = fileMatch && fileMatch[2] ? Number.parseInt(fileMatch[2], 10) : 1;
  let title = withoutSeverity;
  if (fileMatch) {
    title = withoutSeverity.replace(fileMatch[0], '').trim();
  }

  return {
    severity,
    title: title || withoutSeverity,
    file,
    line,
    evidence: withoutSeverity,
    explanation: withoutSeverity
  };
}

function compareRuns(previousRun, currentRun) {
  const previous = previousRun.findings.slice();
  const current = currentRun.findings.slice();
  const matchedPrev = new Set();
  const matchedCurr = new Set();
  const stillPresent = [];
  const severityUp = [];
  const severityDown = [];
  const fixed = [];
  const newFindings = [];

  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    const currentFinding = current[currentIndex];
    const match = findBestMatch(previous, currentFinding, matchedPrev);
    if (!match) {
      continue;
    }

    matchedPrev.add(match.index);
    matchedCurr.add(currentIndex);
    const previousFinding = previous[match.index];
    const currentSeverityRank = severityRank(currentFinding.severity);
    const previousSeverityRank = severityRank(previousFinding.severity);
    const payload = {
      previous: previousFinding,
      current: currentFinding,
      matchType: match.type,
      score: match.score
    };

    if (currentSeverityRank > previousSeverityRank) {
      severityUp.push(payload);
    } else if (currentSeverityRank < previousSeverityRank) {
      severityDown.push(payload);
    } else {
      stillPresent.push(payload);
    }
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (!matchedPrev.has(index)) {
      fixed.push(previous[index]);
    }
  }

  for (let index = 0; index < current.length; index += 1) {
    if (!matchedCurr.has(index)) {
      newFindings.push(current[index]);
    }
  }

  const verdict = deriveRecheckVerdict({ severityUp, severityDown, fixed, newFindings });

  return {
    previousRun: summarizeRun(previousRun),
    currentRun: summarizeRun(currentRun),
    selection: currentRun.baseline || null,
    verdict,
    fixed,
    stillPresent,
    newFindings,
    severityUp,
    severityDown
  };
}

function findBestMatch(previousFindings, currentFinding, matchedPrev) {
  let best = null;

  previousFindings.forEach((previousFinding, index) => {
    if (matchedPrev.has(index)) {
      return;
    }

    let score = 0;
    let type = null;
    if (previousFinding.fingerprint === currentFinding.fingerprint) {
      score = 1;
      type = 'exact';
    } else if (previousFinding.semanticKey === currentFinding.semanticKey) {
      score = 0.95;
      type = 'semantic';
    } else if (previousFinding.anchorKey === currentFinding.anchorKey) {
      score = 0.85;
      type = 'anchor';
    } else if (previousFinding.fileKey === currentFinding.fileKey) {
      const titleScore = similarity(previousFinding.titleKey, currentFinding.titleKey);
      const evidenceScore = similarity(previousFinding.evidenceKey, currentFinding.evidenceKey);
      const combined = Math.max(titleScore, evidenceScore);
      if (combined >= 0.6) {
        score = combined;
        type = 'normalized';
      }
    }

    if (type && (!best || score > best.score)) {
      best = { index, score, type };
    }
  });

  return best;
}

function selectBaselineRun(runs, metadata, selection) {
  if (!runs.length) {
    return null;
  }

  if (selection.runId) {
    const run = runs.find((item) => item.id === selection.runId);
    if (run) {
      run.selectionReason = 'explicit run id';
      return run;
    }
  }

  if (selection.against && selection.against.startsWith('run:')) {
    const targetId = selection.against.slice(4);
    const run = runs.find((item) => item.id === targetId);
    if (run) {
      run.selectionReason = 'explicit against run';
      return run;
    }
  }

  const branchMatches = runs.filter((run) => run.branch === metadata.branch);
  const taskMatches = metadata.task ? branchMatches.filter((run) => run.task === metadata.task) : [];
  const kindMatches = metadata.kind ? branchMatches.filter((run) => run.kind === metadata.kind) : [];

  if (selection.against === 'latest-same-task' && taskMatches.length) {
    taskMatches[taskMatches.length - 1].selectionReason = 'latest same task';
    return taskMatches[taskMatches.length - 1];
  }

  if (selection.against === 'latest-same-kind' && kindMatches.length) {
    kindMatches[kindMatches.length - 1].selectionReason = 'latest same kind';
    return kindMatches[kindMatches.length - 1];
  }

  if (taskMatches.length) {
    taskMatches[taskMatches.length - 1].selectionReason = 'same task same branch latest';
    return taskMatches[taskMatches.length - 1];
  }

  if (kindMatches.length) {
    kindMatches[kindMatches.length - 1].selectionReason = 'same kind same branch latest';
    return kindMatches[kindMatches.length - 1];
  }

  if (branchMatches.length) {
    branchMatches[branchMatches.length - 1].selectionReason = 'same branch latest';
    return branchMatches[branchMatches.length - 1];
  }

  runs[runs.length - 1].selectionReason = 'latest repo run';
  return runs[runs.length - 1];
}

function syncFindingIndex(store, runs) {
  const openMap = buildOpenFindings(runs);
  const records = Array.from(openMap.values());
  writeJson(path.join(store, 'findings', 'open-findings.json'), records);
}

function buildOpenFindings(runs) {
  const map = new Map();
  for (const run of runs) {
    for (const finding of run.findings) {
      map.set(finding.semanticKey, {
        semanticKey: finding.semanticKey,
        title: finding.title,
        file: finding.file,
        severity: finding.severity,
        lastSeenRun: run.id,
        lastSeenAt: run.createdAt
      });
    }
  }
  return map;
}

function pruneDir(dirPath, keep, dryRun) {
  const files = listJsonFiles(dirPath);
  if (files.length <= keep) {
    return [];
  }
  const remove = files.slice(0, files.length - keep);
  if (!dryRun) {
    for (const filePath of remove) {
      deleteFile(filePath);
    }
  }
  return remove;
}

function loadRuns(dirPath) {
  return listJsonFiles(dirPath)
    .filter((filePath) => !filePath.endsWith('open-findings.json'))
    .map((filePath) => hydrateRun(readJson(filePath)));
}

function summarizeRun(run) {
  return {
    id: run.id,
    kind: run.kind,
    task: run.task,
    source: run.source,
    branch: run.branch,
    baseRef: run.baseRef,
    commit: run.commit,
    createdAt: run.createdAt,
    findingCount: run.findings.length
  };
}

function summarizePacket(packet) {
  return {
    id: packet.id,
    createdAt: packet.createdAt,
    packetTokens: packet.metrics ? packet.metrics.packetTokens : 0,
    diffTokens: packet.metrics ? packet.metrics.diffTokens : 0,
    reductionPercent: packet.metrics ? packet.metrics.reductionPercent : 0
  };
}

function summarizeRecheck(recheck) {
  return {
    currentRunId: recheck.currentRun.id,
    verdict: recheck.verdict,
    fixed: recheck.fixed.length,
    stillPresent: recheck.stillPresent.length,
    newFindings: recheck.newFindings.length,
    severityUp: recheck.severityUp.length,
    severityDown: recheck.severityDown.length
  };
}

function renderRunSaved(run, format) {
  if (format === 'json') {
    return JSON.stringify(run, null, 2);
  }

  const lines = [
    'Run Saved',
    `ID: ${run.id}`,
    `Kind: ${run.kind}`,
    `Source: ${run.source}`,
    `Repo: ${run.repo.name}`,
    `Branch: ${run.branch}`,
    `Base: ${run.baseRef || 'unknown'}`,
    `Commit: ${run.commit}`,
    `Files reviewed: ${run.scope && run.scope.fileCount ? run.scope.fileCount : 0}`,
    `Findings: ${run.findings.length}`
  ];

  if (run.baseline) {
    lines.push(`Baseline: ${run.baseline.runId} (${run.baseline.selectionReason})`);
  }

  return lines.join('\n');
}

function renderRecheck(result, format) {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    'Recheck',
    `Previous run: ${result.previousRun.id} (${result.previousRun.kind}, ${result.previousRun.findingCount} finding(s))`,
    `Current run: ${result.currentRun.id} (${result.currentRun.kind}, ${result.currentRun.findingCount} finding(s))`,
    `Verdict: ${result.verdict}`,
    `Fixed: ${result.fixed.length}`,
    `Still present: ${result.stillPresent.length}`,
    `New: ${result.newFindings.length}`,
    `Severity up: ${result.severityUp.length}`,
    `Severity down: ${result.severityDown.length}`
  ];

  if (result.selection) {
    lines.push(`Baseline selection: ${result.selection.selectionReason || 'auto'}`);
  }

  appendFindingLines(lines, 'Fixed findings:', result.fixed, (finding) => `- [${finding.fingerprint}] ${finding.title}`);
  appendFindingLines(lines, 'Still present findings:', result.stillPresent, (match) => `- [${match.current.fingerprint}] ${match.current.title} (${match.matchType})`);
  appendFindingLines(lines, 'New findings:', result.newFindings, (finding) => `- [${finding.fingerprint}] ${finding.title}`);
  appendFindingLines(lines, 'Severity increased:', result.severityUp, (match) => `- [${match.current.fingerprint}] ${match.current.title} (${match.previous.severity} -> ${match.current.severity})`);
  appendFindingLines(lines, 'Severity decreased:', result.severityDown, (match) => `- [${match.current.fingerprint}] ${match.current.title} (${match.previous.severity} -> ${match.current.severity})`);

  return lines.join('\n');
}

function renderStatus(status, format, options = {}) {
  if (format === 'json') {
    return JSON.stringify({
      ...status,
      openFindings: Array.from(status.openFindings.values())
    }, null, 2);
  }

  const lines = [
    'Workmem Status',
    `Repo: ${status.repo}`,
    `Branch: ${status.branch}`,
    `Commit: ${status.commit}`,
    `Health: ${status.health}`,
    `Saved runs: ${status.runCount}`,
    `Saved packets: ${status.packetCount}`,
    `Saved rechecks: ${status.recheckCount}`,
    `Open findings: ${status.openFindings.size}`,
    `Store size: ${formatBytes(status.storeSize)}`,
    `Store path: ${status.storePath}`
  ];

  if (status.config) {
    lines.push(`Config: base=${status.config.base || 'auto'}, mode=${status.config.compressionMode || 'balanced'}, maxFiles=${status.config.maxFiles || 12}`);
  }

  if (status.latestRun) {
    lines.push(`Latest run: ${status.latestRun.id} (${status.latestRun.kind}, ${status.latestRun.task || 'no-task'})`);
  }

  if (status.latestPacket) {
    lines.push(`Last packet reduction: ${status.latestPacket.reductionPercent}%`);
  }

  if (status.latestRecheck) {
    lines.push(`Last recheck: ${status.latestRecheck.verdict} | fixed=${status.latestRecheck.fixed}, new=${status.latestRecheck.newFindings}`);
  }

  if (options.verbose) {
    const previews = Array.from(status.openFindings.values()).slice(0, options.runs || 5);
    if (previews.length) {
      lines.push('', 'Open findings preview:');
      for (const finding of previews) {
        lines.push(`- ${finding.title} (${finding.severity})`);
      }
    }
  }

  return lines.join('\n');
}

function firstArray(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return [];
}

function inferRepoMetadata(repoRoot, options, payload, config) {
  return {
    repoRoot,
    repoName: getRepoName(repoRoot),
    branch: options.branch || getBranch(repoRoot),
    baseRef: options.base || (config && config.base) || null,
    commit: options.commit || getHeadCommit(repoRoot),
    task: options.task || payload.task || null,
    kind: options.kind || payload.kind || 'review',
    source: options.source || payload.source || 'generic',
    scope: {
      files: options.files || payload.files || [],
      fileCount: (options.files || payload.files || []).length
    }
  };
}

function resolveRepoRoot(options, cwd) {
  const repoPath = options.repo ? path.resolve(cwd, options.repo) : cwd;
  if (!isGitRepo(repoPath)) {
    throw new Error(`${repoPath} is not a git repository`);
  }
  return getRepoRoot(repoPath);
}

function normalizePathKey(value) {
  return String(value || 'unknown').replace(/\\/g, '/');
}

function normalizeLine(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function extractLine(location) {
  if (!location || typeof location !== 'string') {
    return null;
  }
  const match = location.match(/:(\d+)/);
  return match ? match[1] : null;
}

function normalizeSeverity(value) {
  const normalized = String(value).toLowerCase();
  if (['critical', 'important', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  if (['high', 'error', 'blocker'].includes(normalized)) {
    return 'important';
  }
  if (['warn', 'warning', 'normal'].includes(normalized)) {
    return 'medium';
  }
  return 'low';
}

function normalizeConfidence(value) {
  const normalized = String(value).toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  if (['5', '4'].includes(normalized)) {
    return 'high';
  }
  if (['3', '2'].includes(normalized)) {
    return 'medium';
  }
  return 'low';
}

function severityRank(value) {
  return {
    low: 1,
    medium: 2,
    important: 3,
    critical: 4
  }[value] || 0;
}

function deriveRecheckVerdict(summary) {
  if (summary.severityUp.length || summary.newFindings.length > summary.fixed.length) {
    return 'regressed';
  }
  if (summary.fixed.length > summary.newFindings.length) {
    return 'improved';
  }
  return 'unchanged';
}

function deriveHealth(runs, openFindings, latestRecheck) {
  if (!runs.length) {
    return 'empty';
  }
  if (latestRecheck && latestRecheck.verdict === 'regressed') {
    return 'regressed';
  }
  if (openFindings.size) {
    return 'active';
  }
  return 'clean';
}

function appendFindingLines(lines, heading, items, formatter) {
  if (!items.length) {
    return;
  }
  lines.push('', heading);
  for (const item of items) {
    lines.push(formatter(item));
  }
}

module.exports = {
  saveRunCommand,
  recheckCommand,
  statusCommand,
  listRunsCommand,
  showRunCommand,
  pruneCommand,
  clearCommand,
  compareRuns
};

function hydrateRun(run) {
  if (!run || !Array.isArray(run.findings)) {
    return run;
  }

  return {
    ...run,
    repo: typeof run.repo === 'string' ? { name: run.repo, root: run.repoRoot } : run.repo,
    findings: run.findings.map((finding) => normalizeFinding(finding))
  };
}
