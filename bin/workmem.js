#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { runCli, parseArgs, formatError } = require('../lib/index.js');

function printHelp() {
  console.log(`
workmem - Recheck-backed working memory for AI coding workflows

Usage:
  workmem init [options]
  workmem build-context [options]
  workmem save-run [options]
  workmem recheck [options]
  workmem compress [options]
  workmem status [options]

Commands:
  init             Create repo-local .workmem config and ignore scaffolding
  build-context    Build a compact context packet from git, repo rules, and memory
  save-run         Save a run/report into local workmem storage
  recheck          Compare a run with previous saved state
  compress         Compress a file or stdin into a smaller technical summary
  status           Show repo-local workmem state and recent runs

Common options:
  --repo <path>       Repo path (default: current directory)
  --format <name>     text, markdown, or json
  --output <path>     Write result to a file
  -h, --help          Show help
  -v, --version       Show version

init options:
  --base <ref>        Default base ref to store in .workmem/config.json
  --ignore <a,b,c>    Extra ignored paths to store in repo config

build-context options:
  --base <ref>        Base ref for diff (default: auto)
  --head <ref>        Head ref for diff (default: HEAD)
  --staged            Use staged changes only
  --files <a,b,c>     Limit scope to specific files
  --task <text>       Task description to include in the packet
  --mode <name>       balanced, aggressive, terse
  --max-files <n>     Max changed files to include in detail

save-run options:
  --input <path>      JSON or markdown/text input file
  --task <text>       Task name/summary
  --kind <name>       review, debug, summary, decision (default: review)
  --branch <name>     Override git branch
  --commit <sha>      Override git commit

recheck options:
  --input <path>      Compare this run file against the latest saved run
  --run-id <id>       Recheck against a specific saved run

compress options:
  --input <path>      Input file path (default: stdin)
  --mode <name>       balanced, aggressive, terse

Examples:
  workmem build-context --base origin/main --task "Review payment diff"
  workmem save-run --input review.json --task "Razorpay review"
  workmem recheck --input review-fixed.json
  workmem compress --input CLAUDE.md --mode terse
  workmem status
`);
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  if (parsed.version) {
    const pkg = require('../package.json');
    console.log(pkg.version);
    process.exit(0);
  }

  if (parsed.help || !parsed.command) {
    printHelp();
    process.exit(parsed.help ? 0 : 1);
  }

  try {
    const result = runCli(parsed, process.cwd());
    const rendered = typeof result === 'string' ? result : result.rendered;

    if (parsed.output) {
      fs.writeFileSync(path.resolve(process.cwd(), parsed.output), rendered);
    }

    console.log(rendered);
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }
}

main();
