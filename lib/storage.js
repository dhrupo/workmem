'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getHomeStoreRoot() {
  const explicit = process.env.WORKMEM_HOME;
  if (explicit) {
    return ensureDir(explicit);
  }

  return ensureDir(path.join(os.homedir(), '.codex', 'memories', 'workmem'));
}

function getRepoHash(repoRoot) {
  return crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 12);
}

function getRepoStore(repoRoot) {
  const root = path.join(getHomeStoreRoot(), 'repos', getRepoHash(repoRoot));
  ensureDir(root);
  ensureDir(path.join(root, 'runs'));
  ensureDir(path.join(root, 'findings'));
  ensureDir(path.join(root, 'packets'));
  ensureDir(path.join(root, 'summaries'));
  ensureDir(path.join(root, 'rechecks'));
  return root;
}

function getRepoStoreByRoot(root) {
  ensureDir(root);
  ensureDir(path.join(root, 'runs'));
  ensureDir(path.join(root, 'findings'));
  ensureDir(path.join(root, 'packets'));
  ensureDir(path.join(root, 'summaries'));
  ensureDir(path.join(root, 'rechecks'));
  return root;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs.readdirSync(dirPath)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => path.join(dirPath, entry));
}

function getLatestJson(dirPath) {
  const files = listJsonFiles(dirPath);
  if (!files.length) {
    return null;
  }

  return readJson(files[files.length - 1]);
}

function deleteFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function deleteDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

module.exports = {
  ensureDir,
  getHomeStoreRoot,
  getRepoHash,
  getRepoStore,
  getRepoStoreByRoot,
  writeJson,
  readJson,
  listJsonFiles,
  getLatestJson,
  deleteFile,
  deleteDir,
  getDirSize
};
