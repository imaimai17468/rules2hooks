# rules2hooks

[日本語](README.ja.md)

A Claude Code skill for when your `.claude/rules` stop being followed because Claude edits files through Bash and python instead of the Read tool. It moves the rules into guidance files that a hook points the model at whenever a session touches the files they cover, through any tool.

## The problem

You write `.claude/rules/frontend.md` with `paths: src/**/*.tsx`, and for a while Claude follows it. Then the output starts ignoring it. The file is still there, the frontmatter is still right, and nothing reports an error.

Claude Code loads a path-scoped rule when the Read tool opens a matching file ([docs](https://code.claude.com/docs/en/memory)). Current models often skip Read and work through the shell:

```
> Add a loading state to UserCard

● Bash(sed -n 1,80p src/components/UserCard.tsx)
● Bash(python3 - <<'EOF'
       p = Path("src/components/UserCard.tsx")
       p.write_text(p.read_text().replace(...))
       EOF)
● Done. UserCard now shows a skeleton while loading.
```

There is no Read call, so `frontend.md` never entered this session's context. As more of the work goes through Bash, fewer sessions load the rule, and from the outside this looks like the model ignoring instructions.

Rules without `paths:` have the opposite problem. They are loaded in full at every launch, so a commit-message style guide takes up context in a session that never commits, and moving it behind `paths:` would hit the problem above.

## Hooks can add to the prompt

Hooks are usually used to run a formatter or to block a command. They can also add text to what the model reads. When a `PreToolUse`, `PostToolUse` or `UserPromptSubmit` hook prints this JSON, Claude Code adds the `additionalContext` string to the model's context alongside that call ([docs](https://code.claude.com/docs/en/hooks)):

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Read .claude/hooks/guidance/frontend.md before continuing."}}
```

A hook runs on every call its matcher covers, whichever tool the model chose, and it receives the call's arguments: the file path for Read and Edit, the whole command for Bash. In the session above, the hook sees `sed -n 1,80p src/components/UserCard.tsx`, finds a path under `src/**/*.tsx`, and tells the model to read the rule. Whether the rule loads no longer depends on the model choosing Read.

The idea fits in a few lines of shell:

```sh
#!/bin/sh
# PreToolUse: point at frontend.md whenever a call mentions a .tsx file
if jq -r '.tool_input | .file_path // .command // ""' | grep -q '\.tsx'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Read .claude/hooks/guidance/frontend.md before continuing."}}'
fi
```

This version repeats the line on every `.tsx` call and knows one rule. The script this skill installs reads the triggers from each rule's frontmatter, names each rule once per session (once per subagent too), checks what git reports as changed after a Bash call, and can be triggered by a command or a prompt as well as a path.

## What changes

```
before                                  after
.claude/rules/frontend.md  (paths)      .claude/hooks/guidance/frontend.md  paths: src/**/*.tsx
.claude/rules/writing.md   (always)     .claude/hooks/guidance/writing.md   paths: "**/*.md"
                                                                            commands: git commit, gh pr create
.claude/rules/replies.md   (always)     .claude/hooks/guidance/replies.md   events: UserPromptSubmit
                                        .claude/hooks/scoped-guidance.mjs
```

Nothing loads the guidance files at launch. The hook reads their frontmatter on each Read, Edit, Write and Bash call and on each prompt. The first time a session reaches what a file names, the model gets one line:

```
.claude/hooks/guidance/frontend.md applies because this session reached src/app/page.tsx. Read .claude/hooks/guidance/frontend.md completely before continuing. This hook names it once per session.
```

| Key | Reached when |
|---|---|
| `paths` | a tool call names a matching file, a Bash command contains a matching path, or git reports a matching file as changed after a Bash call |
| `commands` | a Bash command runs the phrase (`git commit`, `gh pr create`) |
| `events` | `UserPromptSubmit`, `PreToolUse` or `PostToolUse` fires |

The hook names the file instead of pasting its text, because `additionalContext` over 10,000 characters is saved to a file and the model sees a preview. A few rules covering the same file can pass that limit together, while a Read returns each file whole.

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

## Why not something simpler?

**Put the rules in CLAUDE.md or AGENTS.md.** That file is loaded in full at every launch, so it reaches every session, Bash or not. It also puts every rule into every session: the React conventions in a session that edits a migration, the commit style in one that never commits. Keep in it what must hold in every turn, which is usually a few sentences. The skill's step 3 moves such principles there and hooks the rest.

**Make each rule a skill.** A skill is loaded when the model decides its description matches the task, so whether a convention applies depends on the model choosing to load it. A rule should apply because a file was touched. When many skills are installed, Claude Code also shortens the skill listing to fit a budget, and a description cut from the listing cannot be matched ([docs](https://code.claude.com/docs/en/skills)). Skills fit procedures the user asks for ("deploy", "write a migration"); hooked guidance fits constraints on any edit to certain files.

**Tell the model to always use Read.** That is another instruction the model may not follow, and it is the kind this skill exists because of. A hook runs whatever tool the model picks.

**Block Bash edits with a PreToolUse hook.** It works, at the cost of a refused call and a retry each time, and it takes away multi-file python edits the model is good at. This skill adds context and leaves the call alone.

**Inject the rule's text from the hook.** `additionalContext` over 10,000 characters is saved to a file and the model sees a preview, and a few rules on one file pass that easily. The pointer costs one Read per rule per session and arrives whole.

**Use a linter.** Where a linter, formatter or type checker can check a rule, it should, and the skill's step 3 deletes rules a tool already enforces. The guidance files are for the decisions a tool cannot check.

**Claude Code may fix this.** If path-scoped rules start loading on Bash access, moving back is a `git mv` per file and removing three entries from `.claude/settings.json`. The guidance files keep the same frontmatter keys for paths.

**Does the model follow the pointer?** It is an instruction, so it is not guaranteed. In the end-to-end run behind this README, the model ran `cat` on the guidance file right after the pointer and applied the rule; that one run is all the evidence so far. `measure.mjs` shows how often your current rules miss, so you can judge whether the change is worth it on your project.

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
