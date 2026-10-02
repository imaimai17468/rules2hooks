/**
 * Drive skills/rules2hooks/scripts/scoped-guidance.sh through the payloads
 * Claude Code sends it, and compare what it prints. Every case gets its own
 * scratch project and its own marker directory.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const HOOK = path.resolve(import.meta.dirname, "../skills/rules2hooks/scripts/scoped-guidance.sh");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rules2hooks-test-"));

const REACT = "---\npaths: src/**/*.tsx\n---\n\n# React\n";
const PROSE = "---\ncommands: git commit, gh pr create\n---\n\n# Prose\n";
const REPLIES = "---\nevents: UserPromptSubmit\n---\n\n# Replies\n";

let projects = 0;

const makeProject = (rules) => {
  projects += 1;
  const dir = path.join(ROOT, `p${projects}`);
  fs.mkdirSync(path.join(dir, ".claude/hooks/guidance"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp"));
  for (const [file, text] of Object.entries(rules)) {
    fs.writeFileSync(path.join(dir, ".claude/hooks/guidance", file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

const hook = (dir, payload, args = []) =>
  spawnSync("bash", [HOOK, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, SCOPED_GUIDANCE_TMP: path.join(dir, "tmp") },
    input: typeof payload === "string" ? payload : JSON.stringify({ cwd: dir, session_id: "s1", ...payload }),
  });

const bash = (dir, command, extra = {}) =>
  hook(dir, { hook_event_name: "PreToolUse", tool_input: { command }, tool_name: "Bash", ...extra }).stdout;

/** The context the hook printed, or "" when it printed nothing. */
const contextOf = (stdout) =>
  stdout === "" ? "" : JSON.parse(stdout).hookSpecificOutput.additionalContext;

const pointer = (rule, reason) =>
  `.claude/hooks/guidance/${rule} applies because this session ${reason}. Read .claude/hooks/guidance/${rule} completely before continuing. This hook names it once per session.`;

describe("paths", () => {
  const cases = [
    ["sed -n 1,9p src/app.tsx", "reached src/app.tsx"],
    ["cat src/a/b/c.tsx", "reached src/a/b/c.tsx"],
    ["python3 - <<'EOF'\nwith open('src/page.tsx', 'w') as f: f.write(s)\nEOF", "reached src/page.tsx"],
    ["cat $CLAUDE_PROJECT_DIR/src/x.tsx", "reached src/x.tsx"],
    ["cat lib/app.tsx", undefined],
    ["cat src/app.ts", undefined],
  ];
  for (const [command, reason] of cases) {
    it(`should ${reason ? `print "${reason}"` : "print nothing"} when Bash runs ${JSON.stringify(command)}`, () => {
      const dir = makeProject({ "react.md": REACT });
      assert.equal(contextOf(bash(dir, command)), reason ? pointer("react.md", reason) : "");
    });
  }

  it("should read file_path when the tool is Edit", () => {
    const dir = makeProject({ "react.md": REACT });
    const out = hook(dir, { hook_event_name: "PreToolUse", tool_input: { file_path: `${dir}/src/a.tsx` }, tool_name: "Edit" });
    assert.equal(contextOf(out.stdout), pointer("react.md", "reached src/a.tsx"));
  });

  it("should read notebook_path when the tool is NotebookEdit", () => {
    const dir = makeProject({ "nb.md": "---\npaths: \"**/*.ipynb\"\n---\n" });
    const out = hook(dir, { hook_event_name: "PreToolUse", tool_input: { notebook_path: "n/a.ipynb" }, tool_name: "NotebookEdit" });
    assert.equal(contextOf(out.stdout), pointer("nb.md", "reached n/a.ipynb"));
  });

  it("should resolve a relative path against cwd", () => {
    const dir = makeProject({ "react.md": REACT });
    assert.equal(contextOf(bash(dir, "cat page.tsx", { cwd: `${dir}/src` })), pointer("react.md", "reached src/page.tsx"));
  });

  it("should ignore a path outside the project", () => {
    const dir = makeProject({ "any.md": "---\npaths: \"**/*.tsx\"\n---\n" });
    assert.equal(bash(dir, "cat /etc/x.tsx ../other/y.tsx"), "");
  });
});

describe("frontmatter spellings", () => {
  const spellings = [
    ["a comma-separated string", "paths: lib/*.ts, src/*.tsx"],
    ["a flow list", 'paths: ["lib/*.ts", "src/*.tsx"]'],
    ["a block list", 'paths:\n  - "lib/*.ts"\n  - src/*.tsx\ndescription: x'],
    ["a brace alternative", "paths: \"src/*.{ts,tsx}\""],
  ];
  for (const [name, frontmatter] of spellings) {
    it(`should read ${name}`, () => {
      const dir = makeProject({ "r.md": `---\n${frontmatter}\n---\n` });
      assert.equal(contextOf(bash(dir, "cat src/a.tsx")), pointer("r.md", "reached src/a.tsx"));
    });
  }

  it("should match a root file only when the glob has no directory", () => {
    const dir = makeProject({ "md.md": "---\npaths: \"*.md\"\n---\n" });
    assert.deepEqual([contextOf(bash(dir, "cat docs/a.md")), contextOf(bash(dir, "cat README.md"))], ["", pointer("md.md", "reached README.md")]);
  });
});

describe("commands", () => {
  const cases = [
    ["git commit -m x", true],
    ["cd a && git commit -m x", true],
    ["GIT_EDITOR=true git commit", true],
    ["if x; then git commit; fi", true],
    ["  git commit", true],
    ['echo "no git commits"', false],
    ["git commit-tree abc", false],
  ];
  for (const [command, expected] of cases) {
    it(`should ${expected ? "" : "not "}point at the rule when Bash runs ${JSON.stringify(command)}`, () => {
      const dir = makeProject({ "prose.md": PROSE });
      assert.equal(contextOf(bash(dir, command)), expected ? pointer("prose.md", "ran `git commit`") : "");
    });
  }
});

describe("events", () => {
  it("should point at a rule when its event fires", () => {
    const dir = makeProject({ "replies.md": REPLIES, "react.md": REACT });
    assert.equal(contextOf(hook(dir, { hook_event_name: "UserPromptSubmit", prompt: "hi" }).stdout), pointer("replies.md", "fired UserPromptSubmit"));
  });
});

describe("once per session", () => {
  it("should name a rule once when Bash names a covered file twice", () => {
    const dir = makeProject({ "react.md": REACT });
    assert.deepEqual([contextOf(bash(dir, "cat src/a.tsx")), bash(dir, "cat src/b.tsx")], [pointer("react.md", "reached src/a.tsx"), ""]);
  });

  it("should name each rule on its own line when one call reaches two", () => {
    const dir = makeProject({ "a.md": REACT, "b.md": REACT });
    assert.equal(contextOf(bash(dir, "cat src/a.tsx")), `${pointer("a.md", "reached src/a.tsx")}\n${pointer("b.md", "reached src/a.tsx")}`);
  });

  it("should name a rule to a subagent its session already reached", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx");
    assert.notEqual(bash(dir, "cat src/a.tsx", { agent_id: "a1" }), "");
  });

  it("should name a rule to another session", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx");
    assert.notEqual(bash(dir, "cat src/a.tsx", { session_id: "s2" }), "");
  });

  it("should mark the session complete once every rule is reached", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx");
    assert.equal(fs.existsSync(path.join(dir, "tmp/claude-scoped-guidance-s1-.complete-1")), true);
  });

  it("should leave a prompt-only rule out of a subagent's completion", () => {
    const dir = makeProject({ "react.md": REACT, "replies.md": REPLIES });
    bash(dir, "cat src/a.tsx", { agent_id: "a1" });
    assert.equal(fs.existsSync(path.join(dir, "tmp/claude-scoped-guidance-s1-a1.complete-2")), true);
  });

  it("should not point at a guidance file the session already opened with Read", () => {
    const dir = makeProject({ "prose.md": "---\npaths: \"**/*.md\"\n---\n" });
    const read = (file) => hook(dir, { hook_event_name: "PreToolUse", tool_input: { file_path: `${dir}/${file}` }, tool_name: "Read" }).stdout;
    assert.deepEqual([read(".claude/hooks/guidance/prose.md"), read("README.md")], ["", ""]);
  });
});

describe("after a Bash call", () => {
  it("should point at a rule when git reports a covered file the command never named", () => {
    const dir = makeProject({ "react.md": REACT });
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/gen.tsx"), "x\n");
    const out = hook(dir, { hook_event_name: "PostToolUse", tool_input: { command: "./codegen" }, tool_name: "Bash" });
    assert.equal(contextOf(out.stdout), pointer("react.md", "reached src/gen.tsx"));
  });
});

describe("SessionStart", () => {
  const start = (dir, source, session = "s1") => hook(dir, { hook_event_name: "SessionStart", session_id: session, source });

  it("should name a rule again after a compaction", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx");
    start(dir, "compact");
    assert.notEqual(bash(dir, "cat src/a.tsx"), "");
  });

  it("should keep the markers when a session resumes", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx");
    start(dir, "resume");
    assert.equal(bash(dir, "cat src/a.tsx"), "");
  });

  it("should leave another session's markers when one session clears", () => {
    const dir = makeProject({ "react.md": REACT });
    bash(dir, "cat src/a.tsx", { session_id: "s2" });
    start(dir, "clear");
    assert.equal(bash(dir, "cat src/a.tsx", { session_id: "s2" }), "");
  });
});

describe("output", () => {
  it("should escape a quote and a backslash in a path so the output stays JSON", () => {
    const dir = makeProject({ "react.md": REACT });
    const out = hook(dir, { hook_event_name: "PreToolUse", tool_input: { file_path: 'src/a"b\\c.tsx' }, tool_name: "Edit" });
    assert.equal(contextOf(out.stdout), pointer("react.md", 'reached src/a"b\\c.tsx'));
  });

  it("should print nothing and exit 0 when the payload is not JSON", () => {
    const dir = makeProject({ "react.md": REACT });
    const out = hook(dir, "not json");
    assert.deepEqual({ status: out.status, stdout: out.stdout }, { status: 0, stdout: "" });
  });

  it("should print nothing when the project has no guidance directory", () => {
    const dir = makeProject({});
    fs.rmSync(path.join(dir, ".claude/hooks/guidance"), { recursive: true });
    assert.equal(bash(dir, "cat src/a.tsx"), "");
  });
});

describe("--check", () => {
  const check = (rules) => {
    const out = hook(makeProject(rules), "", ["--check"]);
    return { status: out.status, stderr: out.stderr };
  };

  it("should pass when every file has a trigger", () => {
    assert.deepEqual(check({ "react.md": REACT, "replies.md": REPLIES }), { status: 0, stderr: "" });
  });

  it("should report a file without frontmatter", () => {
    assert.deepEqual(check({ "notes.md": "# Notes\n" }), {
      status: 1,
      stderr: ".claude/hooks/guidance/notes.md: has no frontmatter, so no trigger can bring it in\n",
    });
  });

  it("should report an event name the hook does not answer", () => {
    assert.deepEqual(check({ "r.md": "---\nevents: UserPromptSubmitt\n---\n" }), {
      status: 1,
      stderr: ".claude/hooks/guidance/r.md: events names UserPromptSubmitt, which this hook does not answer (it answers PreToolUse, PostToolUse, UserPromptSubmit)\n",
    });
  });

  it("should report frontmatter that names no trigger", () => {
    assert.deepEqual(check({ "r.md": "---\ndescription: x\n---\n" }), {
      status: 1,
      stderr: ".claude/hooks/guidance/r.md: names none of paths, commands or events, so no session reaches it\n",
    });
  });
});
