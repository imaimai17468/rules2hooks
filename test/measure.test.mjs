import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { defaultTranscriptDir, measure } from "../skills/rules2hooks/scripts/measure.mjs";

const line = (cwd, name, input) =>
  JSON.stringify({
    cwd,
    message: { content: [{ id: "t", input, name, type: "tool_use" }] },
    type: "assistant",
  });

describe("measure", () => {
  it("should count a session that touched a covered file only through Bash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rules2hooks-measure-"));
    const project = path.join(root, "project");
    const transcripts = path.join(root, "transcripts");
    fs.mkdirSync(path.join(project, ".claude/rules"), { recursive: true });
    fs.mkdirSync(transcripts);
    fs.writeFileSync(path.join(project, ".claude/rules/react.md"), "---\npaths: src/**/*.tsx\n---\n");
    fs.writeFileSync(path.join(project, ".claude/rules/always.md"), "# Always\n");
    fs.writeFileSync(
      path.join(transcripts, "bash.jsonl"),
      `${line(project, "Bash", { command: "cat src/a.tsx" })}\n`
    );
    fs.writeFileSync(
      path.join(transcripts, "read.jsonl"),
      [line(project, "Bash", { command: "cat src/a.tsx" }), line(project, "Read", { file_path: `${project}/src/a.tsx` })].join("\n")
    );
    fs.writeFileSync(path.join(transcripts, "none.jsonl"), `${line(project, "Bash", { command: "ls" })}\n`);

    assert.deepEqual(measure(project, ".claude/rules", transcripts).rules, [
      { file: ".claude/rules/react.md", patterns: ["src/**/*.tsx"], touchedSessions: 2, unreachedSessions: 1 },
    ]);
  });

  it("should name the transcript directory the way Claude Code encodes a project path", () => {
    assert.equal(
      defaultTranscriptDir("/home/u/my.app"),
      path.join(os.homedir(), ".claude/projects/-home-u-my-app")
    );
  });
});
