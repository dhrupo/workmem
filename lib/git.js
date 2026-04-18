'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(repoPath, args) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function isGitRepo(repoPath) {
  try {
    runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch (error) {
    return false;
  }
}

function getRepoRoot(repoPath) {
  return runGit(repoPath, ['rev-parse', '--show-toplevel']);
}

function getRepoName(repoRoot) {
  return path.basename(repoRoot);
}

function detectBaseRef(repoRoot) {
  const candidates = ['origin/dev', 'origin/development', 'origin/main', 'origin/master', 'main', 'master'];

  for (const ref of candidates) {
    if (refExists(repoRoot, ref)) {
      return ref;
    }
  }

  return refExists(repoRoot, 'HEAD~1') ? 'HEAD~1' : 'HEAD';
}

function getBranch(repoRoot) {
  try {
    return runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (error) {
    try {
      return runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD']);
    } catch (innerError) {
      return 'HEAD';
    }
  }
}

function getHeadCommit(repoRoot) {
  try {
    return runGit(repoRoot, ['rev-parse', 'HEAD']);
  } catch (error) {
    return 'UNBORN';
  }
}

function getChangedFiles(repoRoot, options) {
  if (options.files && options.files.length) {
    return options.files.slice();
  }

  if (options.staged) {
    const output = runGit(repoRoot, ['diff', '--cached', '--name-only']);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  const base = resolveBaseRef(repoRoot, options.base);
  const head = options.head || 'HEAD';
  const output = base === 'HEAD'
    ? getWorktreeNameOnly(repoRoot)
    : runGit(repoRoot, ['diff', '--name-only', `${base}...${head}`]);
  const untracked = getUntrackedFiles(repoRoot);
  const changed = output ? output.split('\n').filter(Boolean) : [];
  return Array.from(new Set(changed.concat(untracked)));
}

function getDiff(repoRoot, options, files) {
  if (options.staged) {
    const args = ['diff', '--cached', '--unified=1'];
    if (files && files.length) {
      args.push('--', ...files);
    }
    return runGit(repoRoot, args);
  }

  const base = resolveBaseRef(repoRoot, options.base);
  const head = options.head || 'HEAD';
  const committed = base === 'HEAD' ? '' : getCommittedDiff(repoRoot, base, head, files);
  const worktree = getWorktreeDiff(repoRoot, files);
  return [committed, worktree].filter(Boolean).join('\n');
}

function getCommittedDiff(repoRoot, base, head, files) {
  const args = ['diff', '--unified=1', `${base}...${head}`];
  if (files && files.length) {
    args.push('--', ...files);
  }
  return runGit(repoRoot, args);
}

function getWorktreeDiff(repoRoot, files) {
  const args = ['diff', '--unified=1'];
  if (files && files.length) {
    args.push('--', ...files);
  }

  try {
    return runGit(repoRoot, args);
  } catch (error) {
    return '';
  }
}

function getWorktreeNameOnly(repoRoot) {
  try {
    return runGit(repoRoot, ['diff', '--name-only']);
  } catch (error) {
    return '';
  }
}

function getUntrackedFiles(repoRoot) {
  try {
    const output = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    return output ? output.split('\n').filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function getFileContent(repoRoot, relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return null;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function getDiffStats(diffText) {
  const lines = diffText ? diffText.split('\n') : [];
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return {
    additions,
    deletions,
    changedLines: additions + deletions
  };
}

function refExists(repoRoot, ref) {
  try {
    runGit(repoRoot, ['rev-parse', '--verify', ref]);
    return true;
  } catch (error) {
    return false;
  }
}

function resolveBaseRef(repoRoot, requestedBase) {
  if (requestedBase && refExists(repoRoot, requestedBase)) {
    return requestedBase;
  }

  return detectBaseRef(repoRoot);
}

module.exports = {
  isGitRepo,
  getRepoRoot,
  getRepoName,
  detectBaseRef,
  resolveBaseRef,
  getBranch,
  getHeadCommit,
  getChangedFiles,
  getDiff,
  getFileContent,
  getDiffStats
};
