# Pitfalls

Each of these came up while running the migration on a real project (imaimai17468/imaimai-front-templete, PRs #308 and #311).

## The hook names the file instead of injecting its text

`additionalContext` over 10,000 characters is written to a file, and the model sees a preview of it. On the source project, the three rules a single `.tsx` file reached came to 43.1 KB and arrived as a 2 KB preview. A Read of the file returns it whole, so the hook sends one line per rule:

```
.claude/hooks/guidance/react.md applies because this session reached src/app/page.tsx. Read .claude/hooks/guidance/react.md completely before continuing. This hook names it once per session.
```

The model then spends one Read per rule per session. Keep each guidance file to what the project decided, so that Read stays short.

## A hook adds context and does not block

PreToolUse context arrives alongside the call, not before it. For `paths` that is fine: the session that reads `src/a.tsx` with `sed` gets the pointer before it writes anything. For `commands` it is late. `git commit -m "..."` carries its message in the command, so the writing rule reaches the session after the first commit message is already written.

On the source project, workers that never edited a `.md` file published their first commit and PR body without the writing rule. The fix was a line in the ticket workflow skill: Read the writing guidance before drafting a commit message or PR body. Do the same in every skill or agent definition that writes text for others.

A blocking design (exit code 2 on the first `git commit` until the file is read) is possible, but it turns a missing Read into a failed command and a retry, and it needs a reliable signal that the Read happened. This skill does not do that.

## Once per session, per agent

Markers are directories in the OS temp directory named `claude-scoped-guidance-<session_id>-<agent_id>-<file>`. `mkdir` creates and tests in one step, so when Claude Code issues several tool calls at once, exactly one of them gets the pointer.

A subagent has its own `agent_id` and its own markers, because it does not share the parent's context: the parent having read `react.md` does nothing for the subagent.

A compaction or `/clear` keeps the session id and drops the guidance the model read. The `SessionStart` entry (matcher `compact|clear`) deletes the session's markers at that point, so each file is named again when the session next reaches it. A resumed session keeps its markers, because the transcript it resumes still holds the reads.

After every file has been pointed at, the hook writes a `.complete-<count>` marker and the rest of the session returns immediately. `<count>` is the number of guidance files, so adding a file mid-session makes the hook look again. A subagent never fires `UserPromptSubmit`, so files reached only by that event are left out of its count; without that, its count would never complete.

## Cost per tool call

The hook runs on every Read, Edit, Write and Bash call. Against a project with six guidance files, on the machine this was written on, a call took about 36 ms when nothing matched and 46 ms when it printed a pointer. It reads the payload in one awk pass and every guidance file in another, so the cost grows little with the number of files. Once a session has been pointed at every file, a call finds the completion marker and exits before reading anything, in about 8 ms.

PostToolUse on Bash runs `git ls-files` and `git diff --cached`, which is fast on most repositories. On a very large monorepo, drop the PostToolUse entry and rely on the PreToolUse path scan.

## Typos fail silently

A file whose frontmatter names no trigger, or an event the hook does not answer (`UserPromptSubmitt`, `SessionStart`), reaches no session and produces no error. `bash .claude/hooks/scoped-guidance.sh --check` reports both and exits 1. Run it in CI or a pre-commit hook.

## Editors other than Claude Code

Hooks run only in Claude Code. Cursor, Codex and other agents that read `AGENTS.md` get no pointers. If the project used `.cursor/rules/*.mdc` symlinks into `.claude/rules/`, those break when the files move. Say in `AGENTS.md` where the guidance lives and that those sessions open the file their work needs.

## A rule that is needed before any file is touched

`paths` fires when a file is named. A design question asked before any file is opened ("what spacing should cards use?") reaches no trigger. Keep one line in `CLAUDE.md` for such rules: "open `.claude/hooks/guidance/design.md` when deciding a UI question".

## Keeping the files in `.claude/rules/` instead

An intermediate setup keeps the rules where they are and adds the hook for Bash access only, skipping files Claude Code already loaded through Read. The source project shipped that (PR #308) and moved everything later the same day (PR #311), because the rules without `paths` were still loaded in full at every launch and the two loading paths had to be kept in agreement. Moving the files gives one path to reason about.
