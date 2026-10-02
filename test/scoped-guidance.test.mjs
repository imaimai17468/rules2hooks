import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  globToRegExp,
  matchesGlob,
  namedPaths,
  parseRule,
  projectRelative,
  reachesFor,
  ruleProblem,
  rulesCountedForCompletion,
  runCheck,
  runHook,
  runsPhrase,
} from "../skills/rules2hooks/scripts/scoped-guidance.mjs";

const HOOK = path.resolve(
  import.meta.dirname,
  "../skills/rules2hooks/scripts/scoped-guidance.mjs"
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rules2hooks-test-"));

const makeProject = (name, rules) => {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, ".claude/hooks/guidance"), { recursive: true });
  for (const [file, text] of Object.entries(rules)) {
    fs.writeFileSync(path.join(dir, ".claude/hooks/guidance", file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

const pointer = (rule, reason) =>
  `.claude/hooks/guidance/${rule} applies because this session ${reason}. Read .claude/hooks/guidance/${rule} completely before continuing. This hook names it once per session.`;

const REACT = "---\npaths: src/**/*.tsx\n---\n\n# React\n";
const PROSE = "---\ncommands: git commit, gh pr create\n---\n\n# Prose\n";
const REPLIES = "---\nevents: UserPromptSubmit\n---\n\n# Replies\n";

describe("parseRule", () => {
  it("should read a comma-separated string when paths is inline", () => {
    assert.deepEqual(parseRule("a.md", "---\npaths: a/*.ts, b/*.ts\n---\n").patterns, [
      "a/*.ts",
      "b/*.ts",
    ]);
  });

  it("should read a flow list when paths is bracketed", () => {
    assert.deepEqual(parseRule("a.md", '---\npaths: ["a/*.ts", "b/*.ts"]\n---\n').patterns, [
      "a/*.ts",
      "b/*.ts",
    ]);
  });

  it("should read a block list when paths has items below it", () => {
    assert.deepEqual(
      parseRule("a.md", '---\npaths:\n  - "a/*.ts"\n  - b/*.ts\ndescription: x\n---\n').patterns,
      ["a/*.ts", "b/*.ts"]
    );
  });
});

describe("ruleProblem", () => {
  it("should report a file without frontmatter", () => {
    const text = "# Notes\n";
    assert.equal(ruleProblem(parseRule("n.md", text), text), "has no frontmatter, so no trigger can bring it in");
  });

  it("should report an event name the hook does not answer", () => {
    const text = "---\nevents: UserPromptSubmitt\n---\n";
    assert.match(ruleProblem(parseRule("n.md", text), text), /UserPromptSubmitt/u);
  });

  it("should report frontmatter that names no trigger", () => {
    const text = "---\ndescription: x\n---\n";
    assert.equal(
      ruleProblem(parseRule("n.md", text), text),
      "names none of paths, commands or events, so no session reaches it"
    );
  });

  it("should pass a file with one trigger", () => {
    assert.equal(ruleProblem(parseRule("r.md", REACT), REACT), undefined);
  });
});

describe("matchesGlob", () => {
  const cases = [
    ["src/a/b/c.tsx", "src/**/*.tsx", true],
    ["src/c.tsx", "src/**/*.tsx", true],
    ["lib/c.tsx", "src/**/*.tsx", false],
    ["README.md", "**/*.md", true],
    ["docs/a/README.md", "**/*.md", true],
    ["docs/README.md", "*.md", false],
    ["src/a.ts", "src/*.{ts,tsx}", true],
    ["src/a.css", "src/*.{ts,tsx}", false],
    ["src/a1.ts", "src/a[0-9].ts", true],
  ];
  for (const [candidate, glob, expected] of cases) {
    it(`should answer ${expected} when ${candidate} meets ${glob}`, () => {
      assert.equal(matchesGlob(candidate, glob), expected);
    });
  }

  it("should anchor the pattern at both ends", () => {
    assert.equal(globToRegExp("src/*.ts").source, "^src\\/[^/]*\\.ts$");
  });
});

describe("namedPaths", () => {
  it("should read file_path when the tool is Edit", () => {
    assert.deepEqual(namedPaths({ file_path: "src/a.tsx" }), ["src/a.tsx"]);
  });

  it("should read notebook_path when the tool is NotebookEdit", () => {
    assert.deepEqual(namedPaths({ notebook_path: "n/a.ipynb" }), ["n/a.ipynb"]);
  });

  it("should read a path inside a python heredoc when the tool is Bash", () => {
    const command = "python3 - <<'EOF'\nwith open('src/app/page.tsx', 'w') as f: f.write(s)\nEOF";
    assert.equal(namedPaths({ command }).includes("src/app/page.tsx"), true);
  });
});

describe("projectRelative", () => {
  it("should resolve a path against cwd", () => {
    assert.equal(projectRelative("page.tsx", "/p/src", "/p"), "src/page.tsx");
  });

  it("should expand $CLAUDE_PROJECT_DIR", () => {
    assert.equal(projectRelative("$CLAUDE_PROJECT_DIR/src/a.ts", "/x", "/p"), "src/a.ts");
  });

  it("should drop a path outside the project", () => {
    assert.equal(projectRelative("/etc/hosts.txt", "/p", "/p"), undefined);
  });
});

describe("runsPhrase", () => {
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
    it(`should answer ${expected} when the command is ${JSON.stringify(command)}`, () => {
      assert.equal(runsPhrase(command, "git commit"), expected);
    });
  }
});

describe("reachesFor", () => {
  const rules = [parseRule("prose.md", PROSE), parseRule("react.md", REACT), parseRule("replies.md", REPLIES)];

  it("should name the path that reached a rule", () => {
    assert.deepEqual(
      reachesFor(rules, { command: "", event: "PreToolUse", paths: ["src/a.tsx"] }).map((r) => r.reason),
      ["reached src/a.tsx"]
    );
  });

  it("should name the command that reached a rule", () => {
    assert.deepEqual(
      reachesFor(rules, { command: "gh pr create -t x", event: "PreToolUse", paths: [] }).map((r) => r.reason),
      ["ran `gh pr create`"]
    );
  });

  it("should name the event that reached a rule", () => {
    assert.deepEqual(
      reachesFor(rules, { command: "", event: "UserPromptSubmit", paths: [] }).map((r) => r.rule.name),
      ["replies.md"]
    );
  });
});

describe("rulesCountedForCompletion", () => {
  it("should leave out a prompt-only rule for a subagent", () => {
    const rules = [parseRule("react.md", REACT), parseRule("replies.md", REPLIES)];
    assert.deepEqual(rulesCountedForCompletion(rules, "agent-1").map((r) => r.name), ["react.md"]);
  });
});

describe("runHook", () => {
  const payload = (overrides) =>
    JSON.stringify({
      cwd: "",
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_input: {},
      tool_name: "Bash",
      ...overrides,
    });

  it("should point at a rule once when Bash names a covered file twice", () => {
    const dir = makeProject("once", { "react.md": REACT });
    const tmp = fs.mkdtempSync(path.join(ROOT, "tmp-"));
    const call = payload({ cwd: dir, tool_input: { command: "sed -n 1,9p src/app.tsx" } });
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.deepEqual(
      [runHook(call, env, tmp), runHook(call, env, tmp)],
      [
        JSON.stringify({
          hookSpecificOutput: {
            additionalContext: pointer("react.md", "reached src/app.tsx"),
            hookEventName: "PreToolUse",
          },
        }),
        "",
      ]
    );
  });

  it("should point a subagent at a rule its session already reached", () => {
    const dir = makeProject("subagent", { "react.md": REACT });
    const tmp = fs.mkdtempSync(path.join(ROOT, "tmp-"));
    const env = { CLAUDE_PROJECT_DIR: dir };
    const input = { file_path: `${dir}/src/a.tsx` };
    runHook(payload({ cwd: dir, tool_input: input, tool_name: "Read" }), env, tmp);
    assert.notEqual(
      runHook(payload({ agent_id: "a1", cwd: dir, tool_input: input, tool_name: "Read" }), env, tmp),
      ""
    );
  });

  it("should point at a rule after Bash changes a covered file it never named", () => {
    const dir = makeProject("post", { "react.md": REACT });
    const tmp = fs.mkdtempSync(path.join(ROOT, "tmp-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/gen.tsx"), "x\n");
    const out = runHook(
      payload({ cwd: dir, hook_event_name: "PostToolUse", tool_input: { command: "./codegen" } }),
      { CLAUDE_PROJECT_DIR: dir },
      tmp
    );
    assert.equal(JSON.parse(out).hookSpecificOutput.additionalContext, pointer("react.md", "reached src/gen.tsx"));
  });

  it("should not point at a guidance file the session already opened with Read", () => {
    const dir = makeProject("read-first", { "prose.md": "---\npaths: \"**/*.md\"\n---\n" });
    const tmp = fs.mkdtempSync(path.join(ROOT, "tmp-"));
    const env = { CLAUDE_PROJECT_DIR: dir };
    const read = (file) =>
      runHook(payload({ cwd: dir, tool_input: { file_path: `${dir}/${file}` }, tool_name: "Read" }), env, tmp);
    assert.deepEqual([read(".claude/hooks/guidance/prose.md"), read("README.md")], ["", ""]);
  });

  it("should print nothing and exit 0 when the payload is not JSON", () => {
    const result = spawnSync("node", [HOOK], { encoding: "utf8", input: "not json" });
    assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 0, stdout: "" });
  });
});

describe("runCheck", () => {
  it("should list each file no trigger reaches", () => {
    const dir = makeProject("check", { "notes.md": "# Notes\n", "react.md": REACT });
    assert.deepEqual(runCheck(dir), [
      ".claude/hooks/guidance/notes.md: has no frontmatter, so no trigger can bring it in",
    ]);
  });
});
