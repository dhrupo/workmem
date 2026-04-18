'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const bin = path.join(__dirname, '..', 'bin', 'workmem.js');
const repo = '/Volumes/Projects/workmem';
const reviewOne = path.join(__dirname, 'fixtures', 'review-1.json');
const reviewTwo = path.join(__dirname, 'fixtures', 'review-2.json');
const store = path.join(os.tmpdir(), 'workmem-smoke-store');

fs.rmSync(store, { recursive: true, force: true });

function run(args) {
  return execFileSync('node', [bin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WORKMEM_HOME: store
    }
  });
}

const help = run(['--help']);
if (!help.includes('workmem - Recheck-backed working memory')) {
  throw new Error('help output missing expected header');
}

run(['init', '--repo', repo, '--base', 'origin/main']);

const packet = run(['build-context', '--repo', repo, '--format', 'json']);
const packetJson = JSON.parse(packet);
if (!packetJson.repo || !packetJson.repo.name) {
  throw new Error('packet output missing repo metadata');
}
if (typeof packetJson.metrics.reductionPercent !== 'number') {
  throw new Error('packet output missing reduction metrics');
}

const saved = run(['save-run', '--repo', repo, '--input', reviewOne, '--task', 'Smoke review']);
if (!saved.includes('Run Saved')) {
  throw new Error('save-run did not report success');
}

run(['save-run', '--repo', repo, '--input', reviewTwo, '--task', 'Smoke review rerun']);

const recheck = run(['recheck', '--repo', repo]);
if (!recheck.includes('Still present')) {
  throw new Error('recheck output missing comparison data');
}

const status = run(['status', '--repo', repo]);
if (!status.includes('Saved runs:')) {
  throw new Error('status output missing run count');
}

const listRuns = run(['list-runs', '--repo', repo]);
if (!listRuns.includes('Saved Runs')) {
  throw new Error('list-runs output missing header');
}

const showRun = run(['show-run', '--repo', repo]);
if (!showRun.includes('Run')) {
  throw new Error('show-run output missing header');
}

const showLatestJson = run(['show-run', '--repo', repo, '--run-id', 'latest', '--format', 'json']);
const showLatestPayload = JSON.parse(showLatestJson);
if (!showLatestPayload.id || !Array.isArray(showLatestPayload.findings)) {
  throw new Error('show-run latest json output missing run payload');
}

const config = run(['config', '--repo', repo]);
if (!config.includes('Workmem Config')) {
  throw new Error('config output missing header');
}

const prune = run(['prune', '--repo', repo, '--keep', '1', '--dry-run']);
if (!prune.includes('Prune Preview')) {
  throw new Error('prune output missing preview');
}

const compressed = run(['compress', '--input', path.join(repo, 'README.md'), '--type', 'rules', '--mode', 'balanced', '--format', 'json']);
const compressedJson = JSON.parse(compressed);
if (compressedJson.reductionPercent < 5) {
  throw new Error(`compress reduction too low: ${compressedJson.reductionPercent}%`);
}

const cleared = run(['clear', '--repo', repo, '--yes']);
if (!cleared.includes('Workmem Cleared')) {
  throw new Error('clear output missing confirmation');
}

console.log('smoke tests passed');
