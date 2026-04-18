#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { runCli, parseArgs, formatError } = require('../lib/index.js');

function printHelp() {
  printCommandHelp(null);
}

function printCommandHelp(command) {
  if (command === 'build-context') {
    console.log(`
workmem build-context

Build a compact context packet from git state, repo rules, and prior memory.

Usage:
  workmem build-context --task "Inspect current branch"

Options:
  --base <ref>
  --head <ref>
  --staged
  --files <a,b,c>
  --task <text>
  --mode <balanced|aggressive|terse>
  --target <generic|codex|claude|cursor>
  --max-files <n>
  --rank <risk|size|recent>
  --show-ranking
  --format <text|markdown|json>
`);
    return;
  }

  if (command === 'save-run') {
    console.log(`
workmem save-run

Save a run/report into local workmem storage.

Usage:
  workmem save-run --input run.json --kind debug --task "Retry analysis"
`);
    return;
  }

  if (command === 'recheck') {
    console.log(`
workmem recheck

Compare the current run against a selected previous baseline.

Usage:
  workmem recheck --input rerun.json --against latest-same-task

Options:
  --input <path>
  --run-id <id>
  --against <latest|latest-same-kind|latest-same-task|run:<id>>
  --kind <name>
  --task <text>
  --format <text|markdown|json>
`);
    return;
  }

  if (command === 'compress') {
    console.log(`
workmem compress

Compress a file or stdin into a smaller technical summary.

Usage:
  workmem compress --input AGENTS.md --type rules --mode terse

Options:
  --input <path>
  --type <notes|logs|rules|report>
  --mode <balanced|aggressive|terse>
  --max-lines <n>
  --max-tokens <n>
  --show-metrics
`);
    return;
  }

  console.log(`
workmem - Recheck-backed working memory for AI coding workflows

Usage:
  workmem init [options]
  workmem build-context [options]
  workmem save-run [options]
  workmem recheck [options]
  workmem compress [options]
  workmem status [options]
  workmem list-runs [options]
  workmem show-run [options]
  workmem prune [options]
  workmem clear [options]
  workmem config [options]

Commands:
  init             Create repo-local .workmem config and ignore scaffolding
  build-context    Build a compact context packet from git, repo rules, and memory
  save-run         Save a run/report into local workmem storage
  recheck          Compare a run with previous saved state
  compress         Compress a file or stdin into a smaller technical summary
  status           Show repo-local workmem state and recent runs
  list-runs        List saved runs for the current repo
  show-run         Show a saved run by id or latest
  prune            Remove old packets or runs
  clear            Remove local workmem storage for a repo
  config           Show repo-local config

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
  --target <name>     generic, codex, claude, cursor
  --max-files <n>     Max changed files to include in detail

save-run options:
  --input <path>      JSON or markdown/text input file
  --task <text>       Task name/summary
  --kind <name>       review, debug, summary, decision (default: review)
  --source <name>     codex, claude, cursor, manual, generic
  --branch <name>     Override git branch
  --commit <sha>      Override git commit

recheck options:
  --input <path>      Compare this run file against the latest saved run
  --run-id <id>       Recheck against a specific saved run
  --against <name>    latest, latest-same-kind, latest-same-task, run:<id>

compress options:
  --input <path>      Input file path (default: stdin)
  --type <name>       notes, logs, rules, report
  --mode <name>       balanced, aggressive, terse

Examples:
  workmem build-context --task "Inspect current branch"
  workmem save-run --input run.json --kind debug --task "Retry analysis"
  workmem recheck --input rerun.json --against latest-same-task
  workmem compress --input AGENTS.md --type rules --mode terse
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
    printCommandHelp(parsed.helpCommand || parsed.command);
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
