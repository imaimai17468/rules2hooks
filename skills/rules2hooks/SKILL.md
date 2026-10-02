---
name: rules2hooks
description: Move a project's `.claude/rules/*.md` into guidance files that a hook points the model at when a tool call reaches the files, commands, or events each one names. Use when asked to migrate or retire `.claude/rules/`, when path-scoped rules are not being followed because the agent reads and writes through Bash, python, sed or heredocs instead of the Read tool, when always-loaded rules cost context on every launch, or when asked to measure whether rules reach the sessions that need them.
---

# rules2hooks

Claude Code loads a rule with `paths` frontmatter when the Read tool opens a matching file. A session that opens and writes files through Bash (`sed -n`, `cat`, a python heredoc, a codegen script) never triggers that load, so the rule is absent exactly where the work happens. A rule without `paths` has the opposite cost: it is loaded in full at every launch, whether the session needs it or not.

This skill moves each rule into `.claude/hooks/guidance/`, where nothing loads it automatically, and installs `scripts/scoped-guidance.mjs` as a hook. The hook reads each file's frontmatter and, the first time a session reaches what it names, adds one line of context telling the model to Read that file:

| Key | Reached when |
|---|---|
| `paths` | a Read, Edit, Write or NotebookEdit call names a matching file, a Bash command contains a matching path, or a file git reports as changed after a Bash call matches |
| `commands` | a Bash command runs the phrase as a command (`git commit`, `gh pr create`) |
| `events` | the hook event fires (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`) |

Paths are globs relative to the project root (`src/**/*.tsx`, `**/*.md`). A file may combine keys; any one of them brings it in.

Work through the steps in order. `<skill-dir>` below is the directory holding this SKILL.md. Report each step you could not run as "not run" in the final report.

## 1. Inventory the rules

List every file under `.claude/rules/` (recursively) and, for each, its frontmatter `paths` and its size in bytes. Also note:

- symlinks into `.claude/rules/` from elsewhere (`.cursor/rules/*.mdc` mirrors, shared rule repos);
- every file that mentions `.claude/rules` (`grep -rn "\.claude/rules" --exclude-dir=node_modules --exclude-dir=.git .`), because each will need its reference moved in step 6;
- any hook already in `.claude/settings.json` that reads `.claude/rules/` or points the model at rules. Step 5 replaces it, so note its files, its tests, and anything that enforces a rule by quoting its path (a Stop hook that checks reply shape, for example);
- whether `~/.claude/rules/` exists. Those are the user's rules, outside the project. Leave them alone and say so in the report.

## 2. Measure reach (optional, recommended)

Before changing anything, measure how often the current rules missed. From the project root:

```sh
node <skill-dir>/scripts/measure.mjs
```

It reads this project's transcripts under `~/.claude/projects/` and prints, for each rule with `paths`, how many sessions touched a covered file and how many of those never opened one with the Read tool. Those are sessions the rule did not reach. Pass `--transcripts <dir>` where the transcripts live elsewhere and `--json` for machine-readable output. Paths are read off Bash commands by pattern, so open two or three of the counted sessions before quoting the number. Put the number in the commit message or PR body: it is the reason for the change. When it finds no transcripts, or no session touched a covered file, say that and quote no number.

## 3. Decide each rule's triggers

Read each rule and decide what should bring it in. `references/choosing-triggers.md` has the decision table and worked examples. In short:

- A rule with `paths` keeps them as they are.
- A rule without `paths` was loaded every launch. Ask what work it governs and give it the trigger for that work: `**/*.md` and `commands: git commit, gh pr create` for a writing-style rule, `events: UserPromptSubmit` for a rule about the shape of replies to the user.
- A short principle that must hold in every turn, whatever the session touches, does not belong in a hooked file. Move it into `CLAUDE.md` or `AGENTS.md` instead, and keep it to the sentence that must always be there.
- Content that restates the official docs of a library, or something a linter or type checker already rejects, can be deleted rather than moved. The migration is a good moment to cut it.

Write the decisions down as a table (file, old trigger, new trigger, reason) before moving anything. Show the table to the user when a rule is ambiguous; otherwise carry on.

## 4. Move the files

```sh
mkdir -p .claude/hooks/guidance
git mv .claude/rules/<name>.md .claude/hooks/guidance/<name>.md
```

Flatten subdirectories (`.claude/rules/frontend/react.md` becomes `.claude/hooks/guidance/frontend-react.md`), because the hook reads `*.md` directly under its directory only. Then edit each file's frontmatter to the triggers decided in step 3. Keep `description:` if it was there; the hook ignores it, and it helps a reader choose a file. Drop keys only another tool read, such as Cursor's `globs:` and `alwaysApply:`.

Remove `.claude/rules/` once it is empty. If the project keeps Cursor mirrors of the rules, delete them and any script or CI step that checks them, and note in `AGENTS.md` that a Cursor session gets no pointers and should open the guidance file its work needs. Update the docs that described the mirrors too.

## 5. Install the hook

Copy the script into the project, so the project does not depend on where this skill is installed:

```sh
cp <skill-dir>/scripts/scoped-guidance.mjs .claude/hooks/scoped-guidance.mjs
```

Merge these entries into `.claude/settings.json`. Add to the existing `hooks` arrays rather than replacing them; read the file first and keep every hook already there.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scoped-guidance.mjs", "timeout": 15 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scoped-guidance.mjs", "timeout": 15 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scoped-guidance.mjs", "timeout": 15 }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact|clear",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/scoped-guidance.mjs", "timeout": 15 }]
      }
    ]
  }
}
```

If step 1 found a hook that already does this job, remove its settings entries, its files and its tests rather than running both: left in place, it keeps scanning a directory that no longer exists on every call.

The `SessionStart` entry makes the hook name every file again after `/clear` or a compaction, which keep the session id and drop what the model read. Leave out the `UserPromptSubmit` entry when no guidance file lists that event, and the `PostToolUse` entry when no file has `paths`. The script needs Node 20 or later and git. If the project already runs hooks through another runtime (bun, deno), use it in the command and in the step 7 checks; the script uses only `node:` built-ins. The copied script is now project code, so add it to the lint, format or coverage configuration where those gates would reject it.

## 6. Repoint references and close the gaps

- Go through every `.claude/rules/` reference found in step 1 and sort it by what it is. Prose that names the path (`CLAUDE.md`, `AGENTS.md`, README, skills, agent definitions) takes the new path. Code that walks the directory (a frontmatter checker, a dead-code or lint config, test fixtures, a gate script) needs its logic pointed at `.claude/hooks/guidance/` and its tests updated. Text the application renders to users is a product change; update it and say so in the report.
- A hook adds context and does not block the call. A rule brought in by `commands: git commit` therefore arrives while the commit with its message is already running. Where a skill or workflow writes a commit message, PR body or review, add a step that Reads the writing guidance before drafting. `references/pitfalls.md` covers this and the other gaps.
- Where the old setup relied on a rule being always loaded (an agent definition that says "follow the rules", a skill that assumes the style guide is in context), name the guidance file it should Read.

## 7. Verify

Run each check and include its output in the report.

```sh
# every guidance file has a trigger the hook answers
node .claude/hooks/scoped-guidance.mjs --check

# a Bash call that names a covered file gets a pointer
# pick a real file: git ls-files | grep -m1 -E '<a pattern from one paths list, as a regex>'
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"verify-1","cwd":"'"$PWD"'","tool_name":"Bash","tool_input":{"command":"sed -n 1,20p src/app/page.tsx"}}' \
  | CLAUDE_PROJECT_DIR="$PWD" node .claude/hooks/scoped-guidance.mjs

# the same call again prints nothing: once per session
```

Then confirm `.claude/settings.json` still parses (`node -e 'JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"))'`) and run the repository's own checks, since step 6 edited its tests and gate scripts. Where they cannot run in this environment, report them as "not run" rather than passed. Markers live in the OS temp directory as `claude-scoped-guidance-<session>-<agent>-*`; delete the `verify-1` ones afterwards.

## 8. Report

Open the report with what moved and what the measurement in step 2 found. Then give the trigger table from step 3, the files whose references changed, and anything left for the user (user-level rules, Cursor sessions, a rule you deleted rather than moved).
