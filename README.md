# Workmem

Recheck-backed working memory for AI coding workflows.

`workmem` is a local CLI that helps reduce token usage before you send context to an AI agent. It does that by:

- compressing diffs, notes, and repo rules into a smaller context packet
- saving findings and decisions from previous runs
- rechecking what changed so you do not resend stale context

Short version:

`Compress context. Remember what matters. Recheck before reuse.`

## Why

When you use AI repeatedly on the same branch, task, or debugging session, most token waste comes from:

- sending the same repo instructions again
- resending large diffs
- repeating already known findings
- losing continuity between runs

`workmem` is a local layer in front of the agent. It builds a smaller packet first, then helps you compare the next run against the last one.

## Benchmark

Observed packet-building example from a large branch/worktree workflow:

| Input | Estimated tokens |
| --- | ---: |
| Raw diff + notes + repo rules | 124980 |
| Workmem packet | 421 |
| Reduction | 99%+ |

Simple view:

```text
Before  | ################################################## 124980
After   | # 421
```

This benchmark is for the packet-building stage, not a claim about total model cost in every workflow.

## Install

```bash
npm install -g workmem
```

or run it without a global install:

```bash
npx workmem --help
```

Requirements:

- Node.js 18+
- `git`

## Quick Start

Inside any git repo:

```bash
workmem init --base origin/main
workmem build-context --task "Inspect current branch" --target codex
```

Save an AI run:

```bash
workmem save-run --input report.json --task "Initial analysis"
```

Recheck the next run:

```bash
workmem recheck --input report-fixed.json
```

Show local status:

```bash
workmem status
```

## How It Works

### 1. Build a context packet

```bash
workmem build-context --base origin/main --task "Inspect current branch" --target codex
```

This collects and compresses:

- branch diff vs base
- staged changes
- worktree changes
- untracked files
- repo rules like `README.md`, `AGENTS.md`, `CLAUDE.md`
- previous saved run summaries

Useful options:

- `--repo <path>`
- `--base <ref>`
- `--head <ref>`
- `--staged`
- `--files a,b,c`
- `--task "..."`
- `--mode balanced|aggressive|terse`
- `--target generic|codex|claude|cursor`
- `--max-files 12`
- `--rank risk|size|recent`
- `--show-ranking`
- `--format text|markdown|json`
- `--output packet.md`

### 2. Save a run

```bash
workmem save-run --input report.json --task "Initial analysis"
```

By default, the run kind is `review`. You can override it:

```bash
workmem save-run --input debug.json --kind debug
workmem save-run --input summary.md --kind summary
workmem save-run --input decision.json --kind decision
workmem save-run --input run.json --kind debug --source claude
```

### 3. Recheck the next run

```bash
workmem recheck --input report-fixed.json --against latest-same-task
```

This compares the current run with the previous saved run and classifies:

- fixed findings
- still-present findings
- newly introduced findings
- severity increases
- severity decreases

You can also compare the latest two saved runs:

```bash
workmem recheck
```

Baseline selectors:

- `--against latest`
- `--against latest-same-kind`
- `--against latest-same-task`
- `--against run:<id>`

### 4. Compress a file or note

```bash
workmem compress --input AGENTS.md --type rules --mode terse
```

Modes:

- `balanced`
- `aggressive`
- `terse`

Types:

- `notes`
- `logs`
- `rules`
- `report`

Compression preserves:

- code fences
- inline code
- markdown headings

### 5. Show status

```bash
workmem status
```

This shows:

- repo
- branch
- commit
- saved run count
- saved packet count
- saved recheck count
- open findings
- store size
- store path
- latest run summary

### 6. Inspect and maintain memory

List runs:

```bash
workmem list-runs
```

Show one run:

```bash
workmem show-run --run-id <id>
```

Show repo config:

```bash
workmem config
```

Preview cleanup:

```bash
workmem prune --keep 20 --dry-run
```

Clear repo memory:

```bash
workmem clear --yes
```

## Works With Any AI Agent

`workmem` is not tied to one agent.

It can sit in front of:

- Codex
- Claude Code
- Cursor
- Cline
- any other agent that you use through files or terminal workflows

Targeted packet renderers are available with:

```bash
workmem build-context --target codex
workmem build-context --target claude
workmem build-context --target cursor
```

For saved runs, `workmem` accepts:

### JSON inputs

Standard shape:

```json
{
  "summary": "Current branch has a few follow-up issues.",
  "findings": [
    {
      "severity": "important",
      "confidence": "high",
      "file": "src/example.js",
      "line": 42,
      "title": "State change may not handle retry path correctly",
      "evidence": "Retry flow skips the previous guard.",
      "explanation": "This can produce duplicate actions in a repeated execution path."
    }
  ]
}
```

It also accepts common alternative arrays such as:

- `issues`
- `comments`
- `observations`
- `problems`
- `warnings`

### Markdown or text inputs

`workmem` can extract findings from a `Findings` section like this:

```md
## Findings

- [important] src/example.js:42 Retry path may skip the previous guard
- [low] README.md:12 Installation note should mention the environment requirement
```

## Storage

Global storage:

```text
~/.codex/memories/workmem/
```

Override it when needed:

```bash
WORKMEM_HOME=/custom/path/workmem workmem status
```

Repo-local config:

```text
.workmem/config.json
```

Running `workmem init` creates:

- `.workmem/config.json`
- `.workmem/ignore`
- `.workmem/snapshots/`
- `.git/info/exclude` entry for `.workmem/`

## Core Workflow

1. `workmem init`
2. `workmem build-context`
3. send the packet to your preferred agent
4. `workmem save-run`
5. `workmem recheck`
6. `workmem status`
7. `workmem prune` when local history grows

## What Developers Can Do With It

Developers can use `workmem` for:

- pre-review context reduction
- debugging loops across multiple AI attempts
- compressing long logs before sending them to an agent
- saving architecture or refactor decisions locally
- reducing repeated repo instructions across sessions
- comparing two iterations of an investigation
- building compact task packets for any coding agent
- keeping branch-specific memory without pushing that memory into git

## Commands

```bash
workmem init
workmem build-context
workmem save-run
workmem recheck
workmem compress
workmem status
workmem list-runs
workmem show-run
workmem prune
workmem clear
workmem config
```

## License

MIT
