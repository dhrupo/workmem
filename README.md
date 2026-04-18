# Workmem

Local working-memory and context-compression CLI for AI coding workflows.

`workmem` is a local-first tool for developers who repeatedly use AI on the same repo, task, or investigation. It helps reduce token waste by compressing context before inference, saving structured run memory after inference, and rechecking old findings before reuse.

## What It Does

- builds compact context packets from git diff, repo rules, and previous runs
- saves run outputs into local structured memory
- rechecks new runs against previous findings
- compresses markdown/text into smaller technical summaries
- shows repo-local workmem status

## Validation

`workmem` has been tested locally against real WPManageNinja repositories:

- `fluentform`
- `fluent-player`

Live validation covered:

- repo initialization with `.workmem/`
- packet building from committed, staged, worktree, and untracked changes
- packet token reduction visibility
- saving a run from generic JSON input
- rechecking a follow-up markdown report
- clean-repo behavior with no changed files

Example live result from `fluentform`:

- changed files detected: `2`
- estimated raw diff tokens: about `124980`
- estimated packet tokens: about `421`

That means the current packet builder is doing the intended job: compressing a very large branch/worktree context into a much smaller technical packet before it reaches an AI agent.

## Core Idea

This is not a generic memory database. It is a narrow coding-workflow tool for:

- diffs
- findings
- repo rules
- task summaries
- logs
- decisions

The product thesis is:

`Compress context. Remember what matters. Recheck before reuse.`

## Install

Published npm install:

```bash
npm install -g workmem
```

or without installing globally:

```bash
npx workmem --help
```

Development install:

```bash
git clone https://github.com/dhrupo/workmem.git
cd workmem
npm install
npm link
```

Now `workmem` should be available globally:

```bash
workmem --help
```

## Requirements

- Node.js 18+
- `git`

## Storage

Workmem stores local state under:

```text
~/.codex/memories/workmem/
```

Override this with:

```bash
WORKMEM_HOME=/custom/path/workmem workmem status
```

Per-repo data is stored separately and keyed by repo path hash.

Repo-local configuration lives in:

```text
.workmem/config.json
```

## Commands

### Initialize a repo

```bash
workmem init --base origin/dev
```

This creates:

- `.workmem/config.json`
- `.workmem/ignore`
- `.workmem/snapshots/`
- `.git/info/exclude` entry for `.workmem/`

### Build a context packet

```bash
workmem build-context --base origin/main --task "Review payment diff"
```

Useful options:

- `--repo <path>`
- `--base <ref>`
- `--head <ref>`
- `--staged`
- `--files a,b,c`
- `--task "..." `
- `--mode balanced|aggressive|terse`
- `--max-files 12`
- `--format text|markdown|json`
- `--output packet.md`

Default scanning includes:

- committed branch diff vs base
- staged changes
- worktree changes
- untracked files

### Save a run

Save a JSON report from another tool, or a text/markdown summary:

```bash
workmem save-run --input review.json --task "Razorpay review"
```

By default, `workmem` uses `review` as the run kind. Override it with:

```bash
workmem save-run --input debug.json --kind debug
workmem save-run --input summary.md --kind summary
workmem save-run --input decision.json --kind decision
```

For JSON input, `workmem` expects a structure like:

```json
{
  "summary": "Payment verification change looks risky.",
  "findings": [
    {
      "severity": "important",
      "confidence": "high",
      "file": "src/Payments/RazorPayProcessor.php",
      "line": 231,
      "title": "Fallback amount may break mismatch detection",
      "evidence": "Verification now prefers base_amount over amount.",
      "explanation": "This can accept or reject the wrong total when surcharge data is incomplete."
    }
  ]
}
```

It also accepts common alternative JSON shapes from other agents, such as:

- `issues`
- `comments`
- `observations`
- `problems`
- `warnings`

This is intentional: `workmem` is meant to work with outputs from different AI agents, not only one fixed reviewer format.

For markdown/text reports, `workmem` can extract findings from a section like:

```md
## Findings

- [important] buglist.md:1 Local bug notes should not ship accidentally
- [low] assets/js/fluent_gutenblock.js:1 Rebuild note should mention the matching source file
```

### Recheck against the previous run

```bash
workmem recheck --input review-fixed.json
```

This compares the current run against the latest saved run for the repo and classifies:

- fixed findings
- still-present findings
- newly introduced findings

If the current input includes a `kind`, or if you pass `--kind`, that kind is preserved during recheck. It is not limited to review-only workflows.

You can also compare the latest two saved runs:

```bash
workmem recheck
```

### Compress a file or stdin

```bash
workmem compress --input CLAUDE.md --mode terse
```

Modes:

- `balanced`
- `aggressive`
- `terse`

Compression preserves:

- code fences
- inline code
- markdown headings

### Show status

```bash
workmem status
```

Shows:

- current repo/branch/commit
- saved run count
- saved finding count
- saved packet count
- latest run summary

## Typical Workflow

1. Build a packet from the current repo state:

```bash
workmem init --base origin/dev
workmem build-context --task "Review current branch"
```

2. Run your AI tool with that packet.

3. Save the AI output:

```bash
workmem save-run --input review.json --task "Review current branch"
```

This can be output from:

- Codex
- Claude Code
- Cursor
- Cline
- any other agent, as long as you save either:
  - a simple JSON report with findings/issues/comments-style arrays
  - or a markdown/text report with a `Findings` section

4. Fix issues and run the AI again.

5. Recheck the new output:

```bash
workmem recheck --input review-fixed.json
```

## npm Release

Before publishing:

```bash
npm test
npm pack --dry-run
```

Then publish:

```bash
npm publish
```

## Roadmap

- stronger git-aware freshness checks
- better log compression
- richer finding invalidation rules
- optional editor and agent integrations

## License

MIT
