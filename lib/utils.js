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

module.exports = {
  nowIso,
  sha1,
  truncate,
  unique,
  normalizeWhitespace,
  estimateTokens
};
