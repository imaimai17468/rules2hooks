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

// The frontmatter, glob and path rules below read a rule the way the hook does.

const LIST_ITEM = /^\s+-\s+/u;
const QUOTED = /^(?<quote>["'])(?<inner>.*)\k<quote>$/u;

const unquote = (value) => {
  const trimmed = value.trim();
  return QUOTED.exec(trimmed)?.groups?.inner ?? trimmed;
};

const blockItems = (after) => {
  const end = after.findIndex((line) => !LIST_ITEM.test(line));
  return after
    .slice(0, end === -1 ? after.length : end)
    .map((line) => unquote(line.replace(LIST_ITEM, "")));
};

/** Split on commas outside braces, so `src/*.{ts,tsx}` stays one item. */
const splitItems = (value) => {
  const items = [""];
  let depth = 0;
  for (const char of value) {
    if (char === "{") depth += 1;
    if (char === "}" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) items.push("");
    else items[items.length - 1] += char;
  }
  return items;
};

const inlineItems = (inline) => {
  const flow = inline.startsWith("[") && inline.endsWith("]");
  return splitItems(flow ? inline.slice(1, -1) : unquote(inline)).map(unquote);
};

/**
 * The items under one frontmatter key, in three spellings: one
 * comma-separated string, a flow list, and a block list. Only these keys are
 * read, so no YAML parser loads on every tool call.
 */
const readList = (frontmatter, key) => {
  const prefix = `${key}:`;
  const lines = frontmatter.split(/\r?\n/u);
  const at = lines.findIndex((line) => line.startsWith(prefix));
  if (at === -1) {
    return [];
  }
  const inline = lines[at].slice(prefix.length).trim();
  const items =
    inline === "" ? blockItems(lines.slice(at + 1)) : inlineItems(inline);
  return items.filter((item) => item !== "");
};

/** The frontmatter block of a file, or `undefined` where it has none. */
const frontmatterOf = (text) =>
  /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.groups?.body;

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A glob as a regular expression over a `/`-separated project-relative path.
 * `**` crosses directories, `*` and `?` stay inside one, `{a,b}` picks one, and
 * `[...]` is a character class. `*.md` matches a root file only, as
 * `path.matchesGlob` reads it.
 */
const globToRegExp = (glob) => {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      source += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        source += "\\{";
      } else {
        const options = glob.slice(i + 1, close).split(",");
        source += `(?:${options.map((option) => globToRegExp(option).source.slice(1, -1)).join("|")})`;
        i = close;
      }
    } else if (char === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        source += "\\[";
      } else {
        const body = glob.slice(i + 1, close).replace(/^!/u, "^");
        source += `[${body}]`;
        i = close;
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, "u");
};

const matchesGlob = (candidate, glob) =>
  globToRegExp(glob).test(candidate.split(path.sep).join("/"));

/**
 * A run of path characters ending in an extension. It reads
 * `Path("src/app/page.tsx")` inside a python heredoc and
 * `sed -n 1,20p src/routes/index.tsx` alike. A word it reads that names no
 * file the command opens, such as a path inside a grep pattern, costs one
 * pointer line and nothing more.
 */
const PATH_IN_COMMAND = /[\w.${}@~[\]/-]*\.[A-Za-z]\w*/gu;

/** The paths a tool call names, as the call wrote them. */
const namedPaths = (toolInput) => {
  const direct = [toolInput.file_path, toolInput.notebook_path].filter(
    (value) => typeof value === "string"
  );
  const command =
    typeof toolInput.command === "string"
      ? (toolInput.command.match(PATH_IN_COMMAND) ?? [])
      : [];
  return [...direct, ...command];
};

const PROJECT_DIR_VARIABLE =
  /^(?:\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})\//u;

/**
 * A path relative to the project root, which is what `paths` are written
 * against, or `undefined` where it lies outside the project.
 */
const projectRelative = (written, cwd, projectDir) => {
  const expanded = written.replace(PROJECT_DIR_VARIABLE, `${projectDir}/`);
  const relative = path.relative(projectDir, path.resolve(cwd, expanded));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
};


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
      : [{ file: path.relative(projectDir, file).split(path.sep).join("/"), patterns }];
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
