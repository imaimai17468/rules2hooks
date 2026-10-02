# rules2hooks

[日本語](README.ja.md)

A Claude Code skill that moves `.claude/rules/*.md` into guidance files a hook points the model at, so a rule reaches the session that edits matching files through Bash, not only the one that opens them with the Read tool.

## The problem

Claude Code loads a rule with `paths:` frontmatter when the Read tool opens a matching file ([docs](https://code.claude.com/docs/en/memory)). A session that works through the shell instead (`sed -n 1,80p src/app/page.tsx`, `cat`, a python heredoc that rewrites three files, a codegen script) never loads it.

In the transcripts of [imaimai-front-templete](https://github.com/imaimai17468/imaimai-front-templete), nearly every read and write under `src/` went through Bash, and 15 of the 39 sessions that touched `src/` worked without ever loading the React, design or data-fetching rules that cover it ([#308](https://github.com/imaimai17468/imaimai-front-templete/pull/308)). Rules without `paths:` had the opposite cost: the writing-style rule was loaded in full at every launch, including sessions that edited no document and published no commit or PR.

## What changes

```
before                                  after
.claude/rules/react.md     (paths)      .claude/hooks/guidance/react.md     paths: src/**/*.tsx
.claude/rules/prose.md     (always)     .claude/hooks/guidance/prose.md     paths: "**/*.md"
                                                                            commands: git commit, gh pr create
.claude/rules/replies.md   (always)     .claude/hooks/guidance/replies.md   events: UserPromptSubmit
                                        .claude/hooks/scoped-guidance.mjs
```

Nothing loads the guidance files at launch. The hook reads their frontmatter on each Read, Edit, Write and Bash call and on each prompt. The first time a session reaches what a file names, the model gets one line:

```
.claude/hooks/guidance/react.md applies because this session reached src/app/page.tsx. Read .claude/hooks/guidance/react.md completely before continuing. This hook names it once per session.
```

| Key | Reached when |
|---|---|
| `paths` | a tool call names a matching file, a Bash command contains a matching path, or git reports a matching file as changed after a Bash call |
| `commands` | a Bash command runs the phrase (`git commit`, `gh pr create`) |
| `events` | `UserPromptSubmit`, `PreToolUse` or `PostToolUse` fires |

The hook names the file instead of pasting its text, because `additionalContext` over 10,000 characters is saved to a file and the model sees a preview. Three rules for one `.tsx` file came to 43.1 KB and arrived cut to 2 KB.

## Install

As a Claude Code plugin:

```
/plugin marketplace add imaimai17468/rules2hooks
/plugin install rules2hooks@rules2hooks
```

With the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add imaimai17468/rules2hooks
```

Or copy `skills/rules2hooks/` into `~/.claude/skills/` or your project's `.claude/skills/`.

## Use

In the project to migrate:

```
> migrate .claude/rules to hooks
```

The skill walks through eight steps: inventory the rules, measure how many past sessions each one missed, decide each file's triggers, `git mv` the files, install the hook into `.claude/settings.json` next to your existing hooks, repoint every `.claude/rules` reference, verify, and report. [SKILL.md](skills/rules2hooks/SKILL.md) has the details.

The measurement also runs on its own, before you decide anything. From the project root:

```sh
node <path-to-skill>/scripts/measure.mjs
```

It reads the project's transcripts in `~/.claude/projects/` and prints one line per path-scoped rule: how many sessions touched a covered file, and how many of those never opened one with Read.

## Requirements and limits

- Node 20 or later and git. The hook uses only `node:` built-ins and is copied into the project, so the project does not depend on this skill staying installed.
- Each hooked tool call starts Node, about 67 ms per call on the machine it was measured on. Once every file has been pointed at, the rest of the session returns without reading any file.
- A hook adds context and does not block. A rule triggered by `git commit` arrives while that first commit is already running, so the skill adds a "read the writing guidance before drafting" step to the workflows that write commit messages and PR bodies.
- Path detection in Bash commands is a pattern match. A path inside a grep pattern counts as a touch, which costs one unneeded pointer.
- Hooks run only in Claude Code. Cursor, Codex and other agents get no pointers and need to open the guidance file themselves.

[references/pitfalls.md](skills/rules2hooks/references/pitfalls.md) covers these in more depth.

## Development

```sh
node --test test/*.test.mjs
```

## License

MIT
