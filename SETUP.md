# Setup

## Install Once

```bash
git clone https://github.com/dhrupo/workmem.git
cd workmem
npm install
npm link
```

## Verify

```bash
workmem --help
workmem --version
```

## First Commands

Inside any git repo:

```bash
workmem init --base origin/dev
workmem build-context --task "Inspect current branch"
workmem status
```

If you have a JSON report from another tool:

```bash
workmem save-run --input review.json --task "Initial review"
workmem recheck --input review-fixed.json
```

## Storage Override

Default storage:

```text
~/.codex/memories/workmem/
```

Override when needed:

```bash
WORKMEM_HOME=/custom/path/workmem workmem status
```
