#!/usr/bin/env node

/**
 * Count, from this project's Claude Code transcripts, the sessions that worked
 * on files a path-scoped rule covers without the Read tool ever opening one of
 * them. Claude Code loads a rule with `paths` when Read opens a matching file,
 * so those sessions are the ones the rule did not reach.
 *
 *   node measure.mjs [--rules .claude/rules] [--transcripts <dir>] [--json]
 *
 * The transcripts default to ~/.claude/projects/<project path with every
 * character but letters and digits replaced by "-">. Each `.jsonl` file under
 * that directory, subagent transcripts included, counts as one session.
 *
 * A path is read off a Bash command by the same pattern the hook uses, so a
 * path named only inside a grep pattern counts as a touch. Treat the numbers
 * as an estimate of reach and read a few sessions before quoting them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  frontmatterOf,
  matchesGlob,
  namedPaths,
  projectRelative,
  readList,
} from "./scoped-guidance.mjs";

const argValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};

export const defaultTranscriptDir = (projectDir) =>
  path.join(
    os.homedir(),
    ".claude",
    "projects",
    projectDir.replaceAll(/[^A-Za-z0-9]/gu, "-")
  );

const walk = (dir, suffix) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full, suffix);
    }
    return entry.name.endsWith(suffix) ? [full] : [];
  });
};

/** The rules under `rulesDir` that carry `paths`, with their patterns. */
export const pathScopedRules = (projectDir, rulesDir) =>
  walk(path.join(projectDir, rulesDir), ".md").flatMap((file) => {
    const patterns = readList(frontmatterOf(fs.readFileSync(file, "utf8")) ?? "", "paths");
    return patterns.length === 0
      ? []
      : [{ file: path.relative(projectDir, file), patterns }];
  });

/** Each tool call one transcript records, as `{ name, input, cwd }`. */
export const toolCalls = (jsonl) =>
  jsonl.split("\n").flatMap((line) => {
    if (line.trim() === "") {
      return [];
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return [];
    }
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) {
      return [];
    }
    return entry.message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ cwd: entry.cwd, input: block.input ?? {}, name: block.name }));
  });

/**
 * How one session met one rule: `touched` when any tool call named a file the
 * rule covers, `read` when the Read tool opened one, and `bashOnly` when it
 * touched without reading.
 */
export const sessionReach = (calls, rule, projectDir) => {
  const covered = (written, cwd) => {
    const relative = projectRelative(written, cwd ?? projectDir, projectDir);
    return relative !== undefined && rule.patterns.some((p) => matchesGlob(relative, p));
  };
  const touchingCalls = calls.filter((call) =>
    namedPaths(call.input).some((written) => covered(written, call.cwd))
  );
  const read = touchingCalls.some((call) => call.name === "Read");
  return {
    bashOnly: touchingCalls.length > 0 && !read,
    read,
    touched: touchingCalls.length > 0,
  };
};

export const measure = (projectDir, rulesDir, transcriptDir) => {
  const rules = pathScopedRules(projectDir, rulesDir);
  const sessions = walk(transcriptDir, ".jsonl").map((file) =>
    toolCalls(fs.readFileSync(file, "utf8"))
  );
  return {
    rules: rules.map((rule) => {
      const reaches = sessions.map((calls) => sessionReach(calls, rule, projectDir));
      return {
        file: rule.file,
        patterns: rule.patterns,
        touchedSessions: reaches.filter((r) => r.touched).length,
        unreachedSessions: reaches.filter((r) => r.bashOnly).length,
      };
    }),
    sessions: sessions.length,
    transcriptDir,
  };
};

const report = (result) => {
  const lines = [`${result.sessions} transcripts under ${result.transcriptDir}`];
  if (result.rules.length === 0) {
    lines.push("No rule with `paths` was found.");
  }
  for (const rule of result.rules) {
    lines.push(
      `${rule.file} (${rule.patterns.join(", ")}): ${rule.touchedSessions} sessions touched a covered file, ${rule.unreachedSessions} of them never opened one with Read`
    );
  }
  return lines.join("\n");
};

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const result = measure(
    projectDir,
    argValue("--rules") ?? ".claude/rules",
    argValue("--transcripts") ?? defaultTranscriptDir(projectDir)
  );
  console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : report(result));
}
