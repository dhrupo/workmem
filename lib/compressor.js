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
  [/\bKeep tests focused on\b/gi, 'Test:']
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
  if (inputPath && /(agents\.md|readme\.md|claude\.md|copilot-instructions\.md|reviewer\.yml|workmem\.yml)$/i.test(inputPath)) {
    return 'rules';
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
  const headingCount = (input.match(/^#{1,3}\s+/gm) || []).length;
  const listCount = (input.match(/^[-*]\s+/gm) || []).length;
  return headingCount >= 2 || (headingCount >= 1 && listCount >= 3);
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
  return rendered.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function compressSection(section, mode) {
  const content = section.lines.join('\n').trim();
  if (!section.heading && !content) {
    return '';
  }

  if (!content) {
    return section.heading || '';
  }

  const blocks = parseMarkdownBlocks(section.lines);
  const sectionType = classifySection(section.heading, content);
  const renderedBlocks = [];

  for (const block of blocks) {
    const rendered = compressMarkdownBlock(block, mode, sectionType);
    if (rendered) {
      renderedBlocks.push(rendered);
    }
  }

  const limited = limitBlocks(renderedBlocks, sectionType, mode);
  if (!limited.length) {
    return section.heading || '';
  }

  return [section.heading, limited.join('\n\n')].filter(Boolean).join('\n\n');
}

function parseMarkdownBlocks(lines) {
  const blocks = [];
  let current = [];
  let fence = false;
  let table = false;

  function flush() {
    if (!current.length) {
      return;
    }
    const raw = current.join('\n').trimEnd();
    current = [];
    if (!raw.trim()) {
      return;
    }
    blocks.push(classifyBlock(raw));
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      current.push(line);
      fence = !fence;
      if (!fence) {
        flush();
      }
      continue;
    }

    if (fence) {
      current.push(line);
      continue;
    }

    if (/^\|.*\|$/.test(line.trim())) {
      current.push(line);
      table = true;
      continue;
    }

    if (table && !line.trim()) {
      flush();
      table = false;
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function classifyBlock(raw) {
  const trimmed = raw.trim();
  if (/^```/.test(trimmed)) {
    return { type: 'fence', raw: trimmed };
  }
  if (/^\|.*\|$/m.test(trimmed) && trimmed.split('\n').length >= 2) {
    return { type: 'table', raw: trimmed };
  }
  if (/^(\d+\.|[-*])\s+/m.test(trimmed)) {
    return { type: 'list', raw: trimmed };
  }
  return { type: 'paragraph', raw: trimmed };
}

function compressMarkdownBlock(block, mode, sectionType) {
  if (block.type === 'fence') {
    return compressCodeFence(block.raw, mode);
  }
  if (block.type === 'table') {
    return compressTable(block.raw, mode);
  }
  if (block.type === 'list') {
    return renderCompressedList(block.raw, mode, sectionType);
  }
  return renderCompressedParagraph(block.raw, mode, sectionType);
}

function renderCompressedList(raw, mode, sectionType) {
  const items = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^(\d+\.|[-*])\s+/, '').trim())
    .filter(Boolean);

  if (shouldGroupInlineItems(items)) {
    const label = inferInlineListLabel(sectionType, items);
    return `- ${label}: ${items.slice(0, maxBulletsForMode(mode)).join(', ')}`;
  }

  const compressed = dedupeBullets(items.map((item) => shrinkSentence(item, mode)));
  const limit = sectionType === 'commands' ? Math.max(3, maxBulletsForMode(mode) - 1) : maxBulletsForMode(mode);
  return compressed.slice(0, limit).map((item) => `- ${item}`).join('\n');
}

function renderCompressedParagraph(paragraph, mode, sectionType) {
  const cleaned = paragraph.replace(/\n+/g, ' ').trim();
  if (!cleaned || /^[A-Z][^.!?]{0,40}:$/.test(cleaned)) {
    return '';
  }

  if (sectionType === 'commands') {
    const commands = compressCommandsParagraph(cleaned, mode);
    if (commands.length) {
      return commands.map((item) => `- ${item}`).join('\n');
    }
  }

  if (sectionType === 'structure') {
    const structure = compressStructureParagraph(cleaned, mode);
    if (structure.length) {
      return structure.map((item) => `- ${item}`).join('\n');
    }
  }

  if (sectionType === 'warnings') {
    return `- ${shrinkSentence(cleaned, mode)}`;
  }

  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (!sentences.length) {
    return '';
  }

  const keep = mode === 'balanced' ? 1 : 2;
  const transformed = sentences.slice(0, keep).map((sentence) => shrinkSentence(sentence, mode));
  return transformed.join(' ');
}

function classifySection(heading, paragraph) {
  const normalizedHeading = String(heading || '').replace(/^#+\s*/, '').toLowerCase();
  const source = `${normalizedHeading} ${paragraph}`.toLowerCase();
  const codeSpanCount = (paragraph.match(/`[^`\n]+`/g) || []).length;
  const commandSpanCount = (paragraph.match(/`[^`\n]+ [^`\n]+`/g) || []).length;

  if (/why|overview|benchmark|license/.test(normalizedHeading)) {
    return 'general';
  }
  if (/quick start|install|usage/.test(normalizedHeading)) {
    return 'commands';
  }
  if (/project structure|architecture|directory|module organization|storage|contributor notes/.test(normalizedHeading)) {
    return 'structure';
  }
  if (/what developers can do|works with any ai agent|core workflow/.test(normalizedHeading)) {
    return 'general';
  }
  if (/build|test|command|options/.test(normalizedHeading)) {
    return 'commands';
  }
  if (/warning|avoid|never|do not|don't/.test(normalizedHeading)) {
    return 'warnings';
  }

  if (/build|test|command/.test(source) || commandSpanCount >= 2 || (codeSpanCount >= 2 && /\brun\b|\bbuild\b|\bphpunit\b|\bphpcs\b/.test(source))) {
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

function compressCodeFence(raw, mode) {
  const lines = raw.split('\n');
  const fence = lines[0] || '```';
  const language = fence.replace(/```/, '').trim().toLowerCase();
  const body = lines.slice(1, -1);

  if (!body.length) {
    return raw;
  }

  if (language === 'json') {
    return compressJsonFence(fence, body, lines[lines.length - 1] || '```');
  }

  if (language === 'bash' || language === 'sh' || language === 'zsh') {
    return compressShellFence(fence, body, lines[lines.length - 1] || '```', mode);
  }

  if (body.length > 8 && (mode === 'balanced' || mode === 'aggressive')) {
    const kept = body.slice(0, mode === 'balanced' ? 6 : 4);
    kept.push('# ...');
    return [fence, ...kept, lines[lines.length - 1] || '```'].join('\n');
  }

  return raw;
}

function compressJsonFence(openFence, bodyLines, closeFence) {
  const body = bodyLines.join('\n').trim();
  try {
    const parsed = JSON.parse(body);
    const compact = JSON.stringify(compactJsonValue(parsed), null, 2);
    return [openFence, compact, closeFence].join('\n');
  } catch (error) {
    return [openFence, ...bodyLines.slice(0, 10), closeFence].join('\n');
  }
}

function compactJsonValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 2).map((item) => compactJsonValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const keys = Object.keys(value).slice(0, 6);
  const output = {};
  for (const key of keys) {
    output[key] = compactJsonValue(value[key]);
  }
  return output;
}

function compressShellFence(openFence, bodyLines, closeFence, mode) {
  const trimmed = bodyLines.map((line) => line.trim()).filter(Boolean);
  const keep = mode === 'balanced' ? 4 : 3;
  const unique = Array.from(new Set(trimmed)).slice(0, keep);
  if (unique.length === 1) {
    return `Command: \`${unique[0]}\``;
  }
  if (unique.length === 2) {
    return `Commands: \`${unique[0]}\`, \`${unique[1]}\``;
  }
  return [openFence, ...unique, closeFence].join('\n');
}

function compressTable(raw, mode) {
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= 4) {
    return raw;
  }
  const keep = mode === 'balanced' ? 4 : 3;
  return lines.slice(0, keep).join('\n');
}

function limitBlocks(blocks, sectionType, mode) {
  const limit = sectionType === 'general'
    ? (mode === 'balanced' ? 4 : 3)
    : (mode === 'balanced' ? 5 : 4);
  return blocks.slice(0, limit);
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
    .replace(/^\s*or run it without a global install:\s*$/i, 'Run without install:')
    .replace(/^\s*Inside any git repo:\s*$/i, 'Run inside a git repo:')
    .replace(/^\s*Save an AI run:\s*$/i, 'Save a run:')
    .replace(/^\s*Recheck the next run:\s*$/i, 'Recheck the next run:')
    .replace(/^\s*Show local status:\s*$/i, 'Show status:')
    .replace(/^\s*This collects and compresses:\s*$/i, 'Collects:')
    .replace(/^\s*Useful options:\s*$/i, 'Key options:')
    .replace(/^\s*It also accepts common alternative arrays such as:\s*$/i, 'Also accepts:')
    .replace(/^\s*Targeted packet renderers are available with:\s*$/i, 'Renderer targets:')
    .replace(/\bIt does that by:\s*/gi, 'By: ')
    .replace(/\bso you do not resend\b/gi, 'to avoid resending')
    .replace(/\bso you don\'t resend\b/gi, 'to avoid resending')
    .replace(/\bShort version:\s*/gi, '')
    .replace(/\bmost token waste comes from:\s*/i, 'Main token waste:')
    .replace(/\bthat are\b/gi, 'that are')
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

function shouldGroupInlineItems(items) {
  if (!items.length || items.length > 8) {
    return false;
  }

  const inlineCodeItems = items.filter((item) => /^`[^`]+`$/.test(item) || /^`--[^`]+`$/.test(item));
  if (inlineCodeItems.length === items.length) {
    return true;
  }

  const optionItems = items.filter((item) => /^`--[^`]+`/.test(item));
  return optionItems.length >= Math.min(4, items.length);
}

function inferInlineListLabel(sectionType, items) {
  if (items.some((item) => /^`--/.test(item))) {
    return 'Options';
  }
  if (sectionType === 'commands') {
    return 'Commands';
  }
  return 'Items';
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
  return Math.max(0, Number((((before - after) / before) * 100).toFixed(1)));
}

function formatReduction(reductionPercent, beforeTokens) {
  if (!beforeTokens) {
    return 'No input to compress';
  }
  return `${reductionPercent}%`;
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
      `- Reduction: ${formatReduction(result.reductionPercent, result.beforeTokens)}`,
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
    `Reduction: ${formatReduction(result.reductionPercent, result.beforeTokens)}`,
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
