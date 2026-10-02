# Choosing triggers

A trigger decides which sessions get pointed at a guidance file. Too narrow and the session that needs it never hears of it; too wide and the model spends a Read on a file that does not apply. Choose by asking what the session is doing at the moment the rule starts to matter.

## Decision table

| The rule governs | Old frontmatter | New trigger |
|---|---|---|
| Code in a part of the tree (components, API routes, migrations) | `paths: src/**/*.tsx` | keep `paths` as is |
| Code in a part of the tree, and the decision is often made before a file is opened (UI design, schema design) | `paths: ...` | keep `paths`, and add one line to `CLAUDE.md` naming the file to open when deciding such a question |
| How text is written (commit messages, PR bodies, docs, comments) | none (loaded every launch) | `paths: "**/*.md"` and `commands: git commit, gh pr create, gh pr edit, gh pr comment, gh issue create, gh issue comment, gh api` |
| The shape of replies to the user | none | `events: UserPromptSubmit` |
| How to run tests, deploy, or release | none | `commands:` naming the commands that start that work (`bun test`, `wrangler deploy`), or move it into a skill if it is a procedure |
| A principle that must hold in every turn | none | not a hooked file: one sentence in `CLAUDE.md` / `AGENTS.md` |
| What a linter, formatter or type checker already rejects | any | delete it; the tool is the rule |
| What a library's official docs already say | any | delete it, or keep only the decision this project made on top of them |

## `paths`

Globs are matched against the path relative to the project root, with `/` separators.

- `**` crosses directories, so `src/**/*.ts` matches `src/a.ts` and `src/x/y/a.ts`.
- `*` stays inside one directory, so `*.md` matches `README.md` and not `docs/a.md`. Write `**/*.md` for every markdown file.
- `{a,b}` and `[0-9]` work as in most shells.

Three spellings are read: `paths: a, b`, `paths: ["a", "b"]`, and a block list.

```yaml
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
```

A Bash command is scanned for words that look like paths (a run of path characters ending in an extension). A path that only appears inside a grep pattern counts too. That costs one pointer line in a session that did not need it, which is cheaper than missing the session that did.

## `commands`

A phrase matches when the command runs it as a command of its own: at the start of a line, after `;`, `&&`, `||`, `|`, `(`, `{`, or after `then`, `do`, `else`, `time`, past any indentation and `VAR=value` assignments. `git commit` matches `cd app && git commit -m x` and `GIT_EDITOR=true git commit`, and does not match `echo "no git commits"` or `git commit-tree`.

The hook runs before the command and cannot hold it back, so the pointer arrives when the command, message included, is already on its way. For text that is written into the command itself (commit messages, PR bodies), the trigger catches the second commit, not the first. Add a step to the workflow that writes the text: "Read `.claude/hooks/guidance/prose.md` before drafting". See `pitfalls.md`.

## `events`

`UserPromptSubmit` fires on every prompt the user sends, so a file listing it reaches the main session at its first prompt. A subagent receives no prompt of its own and never fires it; the hook accounts for this when deciding a subagent has seen everything.

`PreToolUse` and `PostToolUse` as events fire on the first tool call of any kind, which is close to "always". Prefer `paths` or `commands`.

## Worked examples

A React conventions file that was path-scoped:

```yaml
---
description: Effects, component props and splitting, module organization
paths: src/**/*.ts, src/**/*.tsx
---
```

No change to the frontmatter. It moves, and it now also reaches sessions that edit components with `sed` or a python script.

A writing-style file that had no `paths` and loaded every launch:

```yaml
---
description: How a sentence is built in comments, docs, commit messages and PR bodies
paths: "**/*.md"
commands: git commit, gh pr create, gh pr edit, gh pr comment, gh pr review, gh issue create, gh issue comment, gh api
---
```

A reply-shape file that had no `paths`:

```yaml
---
description: What the first line of a reply holds and how a procedure is numbered
events: UserPromptSubmit
---
```
