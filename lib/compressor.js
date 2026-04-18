'use strict';

const fs = require('fs');
const { estimateTokens, normalizeWhitespace } = require('./utils.js');

const FILLER_PATTERNS = [
  /\bI think\b/gi,
  /\bI believe\b/gi,
  /\bjust\b/gi,
  /\bvery\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bin order to\b/gi,
  /\bit is important to note that\b/gi,
  /\bplease note that\b/gi
];

function compressCommand(options) {
  const input = options.input ? fs.readFileSync(options.input, 'utf8') : fs.readFileSync(0, 'utf8');
  const mode = options.mode || 'balanced';
  const result = compressText(input, mode);
  return renderCompression(result, options.format || 'text');
}

function compressText(input, mode) {
  const protectedSpans = extractProtectedSpans(input);
  let working = protectedSpans.text;
  working = dedupeParagraphs(working);
  working = rewriteProse(working, mode);
  working = restoreProtectedSpans(working, protectedSpans.spans);
  working = normalizeWhitespace(working);

  return {
    mode,
    input,
    output: working,
    beforeTokens: estimateTokens(input),
    afterTokens: estimateTokens(working),
    reductionPercent: calculateReduction(estimateTokens(input), estimateTokens(working))
  };
}

function extractProtectedSpans(input) {
  const spans = [];
  let index = 0;

  const text = input.replace(/```[\s\S]*?```|`[^`\n]+`|^#+ .*$/gm, (match) => {
    const token = `__WORKMEM_PROTECTED_${index}__`;
    spans.push({ token, value: match });
    index += 1;
    return token;
  });

  return { text, spans };
}

function restoreProtectedSpans(input, spans) {
  let output = input;
  for (const span of spans) {
    output = output.replace(span.token, span.value);
  }
  return output;
}

function dedupeParagraphs(input) {
  const seen = new Set();
  const paragraphs = input.split(/\n{2,}/);
  const kept = [];

  for (const paragraph of paragraphs) {
    const key = normalizeWhitespace(paragraph).toLowerCase();
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(paragraph.trim());
  }

  return kept.join('\n\n');
}

function rewriteProse(input, mode) {
  const lines = input.split('\n');

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('__WORKMEM_PROTECTED_')) {
      return line;
    }

    let output = line;

    for (const pattern of FILLER_PATTERNS) {
      output = output.replace(pattern, '');
    }

    output = output.replace(/\bthat are\b/gi, 'that are');
    output = output.replace(/\bdo not\b/gi, "don't");
    output = output.replace(/\bcannot\b/gi, "can't");

    if (mode === 'aggressive' || mode === 'terse') {
      output = output
        .replace(/\bthe\b/gi, '')
        .replace(/\ba\b/gi, '')
        .replace(/\ban\b/gi, '')
        .replace(/\s{2,}/g, ' ');
    }

    if (mode === 'terse') {
      output = output
        .replace(/\bThis means\b/gi, 'Means')
        .replace(/\bThere is\b/gi, 'Has')
        .replace(/\bThere are\b/gi, 'Have');
    }

    return output.trimEnd();
  }).join('\n');
}

function calculateReduction(before, after) {
  if (!before) {
    return 0;
  }
  return Math.max(0, Math.round(((before - after) / before) * 100));
}

function renderCompression(result, format) {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }

  if (format === 'markdown') {
    return [
      '# Workmem Compression',
      '',
      `- Mode: \`${result.mode}\``,
      `- Estimated tokens before: ${result.beforeTokens}`,
      `- Estimated tokens after: ${result.afterTokens}`,
      `- Reduction: ${result.reductionPercent}%`,
      '',
      '## Output',
      '',
      result.output
    ].join('\n');
  }

  return [
    'Compression Summary',
    `Mode: ${result.mode}`,
    `Estimated tokens before: ${result.beforeTokens}`,
    `Estimated tokens after: ${result.afterTokens}`,
    `Reduction: ${result.reductionPercent}%`,
    '',
    'Output',
    result.output
  ].join('\n');
}

module.exports = {
  compressCommand,
  compressText
};
