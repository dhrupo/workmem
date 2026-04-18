'use strict';

const fs = require('fs');
const { estimateTokens, normalizeWhitespace, truncate } = require('./utils.js');

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

const PHRASE_REWRITES = [
  [/\bUse ([^.]*) for\b/gi, '$1:'],
  [/\bThe build is driven by\b/gi, 'Build:'],
  [/\bBootstrapping starts at\b/gi, 'Entry:'],
  [/\bCompiled output goes to\b/gi, 'Output:'],
  [/\bMigrations live in\b/gi, 'Migrations:'],
  [/\bTreat ([^ ]+) as\b/gi, '$1 ='],
  [/\bFollow existing\b/gi, 'Use'],
  [/\bKeep tests focused on\b/gi, 'Test:'],
  [/\bDo not\b/gi, 'Avoid'],
  [/\bNever\b/gi, 'Avoid']
];

function compressCommand(options) {
  const input = options.input ? fs.readFileSync(options.input, 'utf8') : fs.readFileSync(0, 'utf8');
  const mode = options.mode || 'balanced';
  const type = options.type || detectCompressionType(input, options.input);
  const result = compressText(input, mode, {
    type,
    maxLines: options.maxLines || null,
    maxTokens: options.maxTokens || null
  });
  return renderCompression(result, options.format || 'text');
}

function compressText(input, mode, settings = {}) {
  const type = settings.type || detectCompressionType(input, null);
  const beforeTokens = estimateTokens(input);
  let output = '';

  if (type === 'rules' || looksLikeStructuredDoc(input)) {
    output = compressStructuredMarkdown(input, mode, settings);
  } else if (type === 'logs') {
    output = compressLogs(input, mode, settings);
  } else {
    output = compressPlainText(input, mode, settings);
  }

  output = applyOutputLimits(output, settings);
  const afterTokens = estimateTokens(output);

  return {
    mode,
    type,
    input,
    output,
    beforeTokens,
    afterTokens,
    reductionPercent: calculateReduction(beforeTokens, afterTokens)
  };
}

function detectCompressionType(input, inputPath) {
  if (inputPath && /\.(log|txt)$/i.test(inputPath)) {
    return 'logs';
  }
  if (inputPath && /\.(md|markdown)$/i.test(inputPath)) {
    return 'rules';
  }
  if (looksLikeStructuredDoc(input)) {
    return 'rules';
  }
  return 'notes';
}

function looksLikeStructuredDoc(input) {
  return /^#{1,3}\s+/m.test(input) && /`[^`\n]+`/.test(input);
}

function compressStructuredMarkdown(input, mode, settings) {
  const lines = input.split('\n');
  const sections = [];
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (current.heading || current.lines.length) {
        sections.push(current);
      }
      current = { heading: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }

  if (current.heading || current.lines.length) {
    sections.push(current);
  }

  const rendered = sections.map((section) => compressSection(section, mode, settings)).filter(Boolean);
  return normalizeWhitespace(rendered.join('\n\n'));
}

function compressSection(section, mode) {
  const content = section.lines.join('\n').trim();
  if (!section.heading && !content) {
    return '';
  }

  if (!content) {
    return section.heading || '';
  }

  if (/^```[\s\S]*```$/m.test(content)) {
    return [section.heading, content].filter(Boolean).join('\n\n');
  }

  const bullets = [];
  const paragraphs = content.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    if (/^[-*]\s+/m.test(paragraph)) {
      bullets.push(...compressList(paragraph, mode));
      continue;
    }

    bullets.push(...compressParagraph(paragraph, mode, section.heading));
  }

  const deduped = dedupeBullets(bullets).slice(0, maxBulletsForMode(mode));
  if (!deduped.length) {
    return section.heading || '';
  }

  return [
    section.heading,
    deduped.map((bullet) => `- ${bullet}`).join('\n')
  ].filter(Boolean).join('\n');
}

function compressList(paragraph, mode) {
  return paragraph
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .map((line) => shrinkSentence(line, mode));
}

function compressParagraph(paragraph, mode, heading) {
  const sentences = paragraph
    .replace(/\n+/g, ' ')
    .split(/(?<=[.?!])\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const sectionType = classifySection(heading, paragraph);

  if (sectionType === 'commands') {
    return compressCommandsParagraph(paragraph, mode);
  }

  if (sectionType === 'structure') {
    return compressStructureParagraph(paragraph, mode);
  }

  if (sectionType === 'warnings') {
    return [shrinkSentence(paragraph, mode)];
  }

  const transformed = sentences.map((sentence) => shrinkSentence(sentence, mode));
  return transformed.length > 2 ? transformed.slice(0, 2) : transformed;
}

function classifySection(heading, paragraph) {
  const source = `${heading || ''} ${paragraph}`.toLowerCase();
  const codeSpanCount = (paragraph.match(/`[^`\n]+`/g) || []).length;

  if (/build|test|command/.test(source) || (codeSpanCount >= 2 && /\brun\b|\bbuild\b|\bphpunit\b|\bphpcs\b/.test(source))) {
    return 'commands';
  }
  if (/project structure|architecture|directory|module organization/.test(source) || (codeSpanCount >= 3 && /\//.test(paragraph))) {
    return 'structure';
  }
  if (/avoid|never|do not|don't/.test(source)) {
    return 'warnings';
  }
  return 'general';
}

function compressCommandsParagraph(paragraph, mode) {
  const commands = paragraph.match(/`[^`\n]+`/g) || [];
  if (!commands.length) {
    return [shrinkSentence(paragraph, mode)];
  }

  const label = paragraph.toLowerCase().includes('phpunit')
    ? 'Tests'
    : paragraph.toLowerCase().includes('phpcs')
      ? 'Style'
      : paragraph.toLowerCase().includes('watch')
        ? 'Dev'
        : 'Commands';

  const uniqueCommands = Array.from(new Set(commands));
  let suffix = '';
  const pathMatch = paragraph.match(/\[[^\]]+\]\(([^)]+)\)/);
  if (pathMatch) {
    suffix = ` via ${pathMatch[0]}`;
  }

  return [`${label}: ${uniqueCommands.join(', ')}${suffix}`];
}

function compressStructureParagraph(paragraph, mode) {
  const codeSpans = paragraph.match(/`[^`\n]+`/g) || [];
  if (!codeSpans.length) {
    return [shrinkSentence(paragraph, mode)];
  }

  const first = codeSpans[0];
  const rest = codeSpans.slice(1);
  if (!rest.length) {
    return [shrinkSentence(paragraph, mode)];
  }

  return [`${first}: ${rest.join(', ')}`];
}

function shrinkSentence(sentence, mode) {
  let output = sentence;

  for (const pattern of FILLER_PATTERNS) {
    output = output.replace(pattern, '');
  }

  for (const [pattern, replacement] of PHRASE_REWRITES) {
    output = output.replace(pattern, replacement);
  }

  output = output
    .replace(/\bthat are\b/gi, 'that are')
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (mode === 'aggressive' || mode === 'terse') {
    output = output
      .replace(/\bthe\b/gi, '')
      .replace(/\ba\b/gi, '')
      .replace(/\ban\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  if (mode === 'terse') {
    output = output
      .replace(/\bThis means\b/gi, 'Means')
      .replace(/\bThere is\b/gi, 'Has')
      .replace(/\bThere are\b/gi, 'Have')
      .replace(/\bwith\b/gi, 'w/')
      .trim();
  }

  return output.replace(/\s+([.,:;!?])/g, '$1');
}

function dedupeBullets(bullets) {
  const seen = new Set();
  const results = [];

  for (const bullet of bullets) {
    const key = bullet
      .toLowerCase()
      .replace(/[`*_()[\]{}:;,.!?/\\-]/g, ' ')
      .replace(/\b(the|a|an|and|or|to|for|of|in|on|with)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(bullet);
  }

  return results;
}

function maxBulletsForMode(mode) {
  if (mode === 'terse') {
    return 4;
  }
  if (mode === 'aggressive') {
    return 5;
  }
  return 6;
}

function compressLogs(input, mode, settings) {
  const lines = input.split('\n').map((line) => line.trim()).filter(Boolean);
  const groups = new Map();

  for (const line of lines) {
    const signature = line
      .replace(/\b\d+\b/g, '#')
      .replace(/0x[0-9a-f]+/gi, '0x#')
      .replace(/\s+/g, ' ')
      .trim();
    const entry = groups.get(signature) || { count: 0, sample: line };
    entry.count += 1;
    groups.set(signature, entry);
  }

  const ranked = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const kept = ranked.slice(0, settings.maxLines || maxBulletsForMode(mode) * 2);
  return kept.map((entry) => `- (${entry.count}) ${truncate(entry.sample, 220)}`).join('\n');
}

function compressPlainText(input, mode, settings) {
  const protectedSpans = extractProtectedSpans(input);
  let working = protectedSpans.text;
  working = dedupeParagraphs(working);
  working = rewriteProse(working, mode);
  working = restoreProtectedSpans(working, protectedSpans.spans);
  return normalizeWhitespace(working);
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
    return shrinkSentence(line, mode);
  }).join('\n');
}

function applyOutputLimits(output, settings) {
  let result = output;
  if (settings.maxLines) {
    result = result.split('\n').slice(0, settings.maxLines).join('\n');
  }

  if (settings.maxTokens) {
    const maxChars = settings.maxTokens * 4;
    if (result.length > maxChars) {
      result = truncate(result, maxChars);
    }
  }
  return result;
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
      `- Type: \`${result.type}\``,
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
    `Type: ${result.type}`,
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
  compressText,
  detectCompressionType
};
