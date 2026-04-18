'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const bin = path.join(__dirname, '..', 'bin', 'workmem.js');
const repo = '/Volumes/Projects/workmem';
const reviewOne = path.join(__dirname, 'fixtures', 'review-1.json');
const reviewTwo = path.join(__dirname, 'fixtures', 'review-2.json');

function run(args) {
  return execFileSync('node', [bin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
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

console.log('smoke tests passed');
