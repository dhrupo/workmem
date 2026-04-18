'use strict';

const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function unique(values) {
  return Array.from(new Set(values));
}

function normalizeWhitespace(value) {
  return value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function estimateTokens(value) {
  if (!value) {
    return 0;
  }
  return Math.ceil(value.length / 4);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`*_()[\]{}:;,.!?/\\-]/g, ' ')
    .replace(/\b(missing|lacks|absent)\b/g, 'missing')
    .replace(/\b(check|validation|guard|verification)\b/g, 'check')
    .replace(/\b(handler|route|flow|path)\b/g, 'flow')
    .replace(/\b(the|a|an|and|or|to|for|of|in|on|with)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineBucket(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) {
    return '0-9';
  }
  const start = Math.floor(number / 10) * 10;
  return `${start}-${start + 9}`;
}

function similarity(left, right) {
  const a = new Set(normalizeKey(left).split(' ').filter(Boolean));
  const b = new Set(normalizeKey(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / Math.max(a.size, b.size);
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  nowIso,
  sha1,
  truncate,
  unique,
  normalizeWhitespace,
  estimateTokens,
  normalizeKey,
  lineBucket,
  similarity,
  formatBytes
};
