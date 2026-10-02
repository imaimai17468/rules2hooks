#!/usr/bin/env node

/**
 * Point the model at a guidance file once per session, as additionalContext,
 * when the session reaches a file its `paths` cover, runs a command its
 * `commands` name, or fires an event its `events` list.
 *
 * Run it from PreToolUse, PostToolUse and UserPromptSubmit. Before a call, the
 * paths and the command the call names decide; after a Bash call, the files git
 * lists as changed decide, which covers a write whose command named no path.
 *
 * `node scoped-guidance.mjs --check` reports each guidance file that no trigger
 * would ever bring into a session, and exits 1 when there is one.
 *
 * The context is advisory, so on a hook call every failure exits 0 and prints
 * nothing: a hook that cannot decide must not stand between the model and its
 * call.
 *
 * No dependencies beyond Node 20, so it can be copied into any project.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the guidance files live, relative to the project root. */
export const GUIDANCE_DIR =
  process.env.SCOPED_GUIDANCE_DIR ?? ".claude/hooks/guidance";

/** The hook events this hook answers. */
export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit"];

// ---------------------------------------------------------------- frontmatter

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

const inlineItems = (inline) => {
  const flow = inline.startsWith("[") && inline.endsWith("]");
  return (flow ? inline.slice(1, -1) : unquote(inline)).split(",").map(unquote);
};

/**
 * The items under one frontmatter key, in three spellings: one
 * comma-separated string, a flow list, and a block list. Only these keys are
 * read, so no YAML parser loads on every tool call.
 */
export const readList = (frontmatter, key) => {
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
export const frontmatterOf = (text) =>
  /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.groups?.body;

/**
 * The triggers a guidance file declares. Event names this hook does not answer
 * are kept here so `--check` can report them, and dropped by `reasonFor`.
 */
export const parseRule = (name, text) => {
  const frontmatter = frontmatterOf(text) ?? "";
  return {
    commands: readList(frontmatter, "commands"),
    events: readList(frontmatter, "events"),
    name,
    patterns: readList(frontmatter, "paths"),
  };
};

const hasTrigger = (rule) =>
  rule.commands.length + rule.patterns.length > 0 ||
  rule.events.some((event) => HOOK_EVENTS.includes(event));

/** Why a guidance file would never reach a session, or `undefined`. */
export const ruleProblem = (rule, text) => {
  if (frontmatterOf(text) === undefined) {
    return "has no frontmatter, so no trigger can bring it in";
  }
  const unanswered = rule.events.filter((event) => !HOOK_EVENTS.includes(event));
  if (unanswered.length > 0) {
    return `events names ${unanswered.join(", ")}, which this hook does not answer (it answers ${HOOK_EVENTS.join(", ")})`;
  }
  if (!hasTrigger(rule)) {
    return "names none of paths, commands or events, so no session reaches it";
  }
  return undefined;
};

// ----------------------------------------------------------------------- glob

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A glob as a regular expression over a `/`-separated project-relative path.
 * `**` crosses directories, `*` and `?` stay inside one, `{a,b}` picks one, and
 * `[...]` is a character class. `*.md` matches a root file only, as
 * `path.matchesGlob` reads it.
 */
export const globToRegExp = (glob) => {
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

export const matchesGlob = (candidate, glob) =>
  globToRegExp(glob).test(candidate.split(path.sep).join("/"));

// ---------------------------------------------------------------- tool calls

/**
 * A run of path characters ending in an extension. It reads
 * `Path("src/app/page.tsx")` inside a python heredoc and
 * `sed -n 1,20p src/routes/index.tsx` alike. A word it reads that names no
 * file the command opens, such as a path inside a grep pattern, costs one
 * pointer line and nothing more.
 */
const PATH_IN_COMMAND = /[\w.${}@~[\]/-]*\.[A-Za-z]\w*/gu;

/** The paths a tool call names, as the call wrote them. */
export const namedPaths = (toolInput) => {
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
export const projectRelative = (written, cwd, projectDir) => {
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

/**
 * Whether the command runs the phrase as a command of its own: at the start of
 * a line, after a separator, a `{`, or a `then`, `do`, `else` or `time`
 * keyword, past any indentation and `VAR=value` assignments. `git commit`
 * matches `cd x && git commit -m y` and `GIT_EDITOR=true git commit`, and not
 * `echo "no git commits"`.
 */
export const runsPhrase = (command, phrase) =>
  new RegExp(
    String.raw`(?:^|[;&|({]|\b(?:then|do|else|time)\b)\s*(?:\w+=\S*\s+)*${escapeRegExp(phrase)}(?:[\s;&|)}]|$)`,
    "mu"
  ).test(command);

/** Why the call brings the rule into scope, or `undefined`. */
export const reasonFor = (rule, facts) => {
  if (rule.events.includes(facts.event)) {
    return `fired ${facts.event}`;
  }
  const matchedPath = facts.paths.find((candidate) =>
    rule.patterns.some((pattern) => matchesGlob(candidate, pattern))
  );
  if (matchedPath !== undefined) {
    return `reached ${matchedPath}`;
  }
  const phrase = rule.commands.find((candidate) =>
    runsPhrase(facts.command, candidate)
  );
  return phrase === undefined ? undefined : `ran \`${phrase}\``;
};

/** Each rule the call brings into scope, in file-name order. */
export const reachesFor = (rules, facts) =>
  rules.flatMap((rule) => {
    const reason = reasonFor(rule, facts);
    return reason === undefined ? [] : [{ reason, rule }];
  });

// -------------------------------------------------------------------- markers

const fileNameSafe = (id) => String(id ?? "").replaceAll(/[^\w-]/gu, "");

/**
 * The prefix of one session's marker names, or `undefined` for a payload with
 * no id, which cannot be counted and is pointed at a rule every time. A
 * subagent carries its own `agent_id` and is counted apart from its session.
 */
export const markerPrefix = (sessionId, agentId, tmpDir) => {
  const session = fileNameSafe(sessionId);
  const agent = fileNameSafe(agentId);
  if (session === "" && agent === "") {
    return undefined;
  }
  return path.join(tmpDir, `claude-scoped-guidance-${session}-${agent}`);
};

export const ruleMarker = (prefix, ruleName) =>
  `${prefix}-${fileNameSafe(ruleName)}`;

/**
 * The marker that answers the rest of a session without reading anything. It
 * carries the count of guidance files, so a file added mid-session changes the
 * name and the hook reads the rules again.
 */
export const completeMarker = (prefix, ruleFileCount) =>
  `${prefix}.complete-${ruleFileCount}`;

/**
 * The rules a session has to reach before it counts as complete. A subagent
 * receives no prompt of its own, so a rule only `UserPromptSubmit` brings in
 * would hold its count open forever.
 */
export const rulesCountedForCompletion = (rules, agentId) =>
  rules.filter(
    (rule) =>
      hasTrigger(rule) &&
      (agentId === "" ||
        rule.patterns.length > 0 ||
        rule.commands.length > 0 ||
        rule.events.some(
          (event) => event !== "UserPromptSubmit" && HOOK_EVENTS.includes(event)
        ))
  );

/**
 * The additionalContext that sends the model to each rule. It names the file
 * rather than carrying its text, because Claude Code saves a long
 * additionalContext to a file and shows the model only a preview, while a Read
 * of the file returns it whole.
 */
export const pointerContext = (reaches) =>
  reaches
    .map(({ reason, rule }) => {
      const file = `${GUIDANCE_DIR}/${rule.name}`;
      return `${file} applies because this session ${reason}. Read ${file} completely before continuing. This hook names it once per session.`;
    })
    .join("\n");

// ---------------------------------------------------------------------- entry

const readRuleFiles = (projectDir) => {
  const dir = path.join(projectDir, GUIDANCE_DIR);
  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  return names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    return { rule: parseRule(name, text), text };
  });
};

const gitLines = (projectDir, args) =>
  execFileSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\n")
    .filter((line) => line !== "");

/**
 * Files that differ from the index, staged files that differ from HEAD, and
 * untracked files git does not ignore.
 */
const changedFiles = (projectDir) => [
  ...gitLines(projectDir, [
    "ls-files",
    "--modified",
    "--others",
    "--exclude-standard",
  ]),
  ...gitLines(projectDir, ["diff", "--name-only", "--cached", "--relative"]),
];

const callFacts = (payload, projectDir) => {
  const event = payload.hook_event_name;
  if (event === "UserPromptSubmit") {
    return { command: "", event, paths: [] };
  }
  const toolInput = payload.tool_input ?? {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (event === "PostToolUse") {
    return { command: "", event, paths: command === "" ? [] : changedFiles(projectDir) };
  }
  const paths = namedPaths(toolInput).flatMap((written) => {
    const relative = projectRelative(written, payload.cwd ?? projectDir, projectDir);
    return relative === undefined ? [] : [relative];
  });
  return { command, event, paths };
};

/**
 * `mkdir` both tests and claims the marker in one step, so of several calls
 * Claude Code issued together exactly one points at the rule.
 */
const claimsFirstReach = (prefix, rule) => {
  if (prefix === undefined) {
    return true;
  }
  try {
    fs.mkdirSync(ruleMarker(prefix, rule.name));
    return true;
  } catch {
    return false;
  }
};

/**
 * The guidance files a Read opens. A session that reads one on its own has
 * what the pointer would send it to, so its marker is claimed without a word.
 */
export const guidanceFilesRead = (rules, paths) =>
  rules.filter((rule) => paths.includes(`${GUIDANCE_DIR}/${rule.name}`));

export const runHook =(stdin, env = process.env, tmpDir = os.tmpdir()) => {
  const payload = JSON.parse(stdin);
  if (!HOOK_EVENTS.includes(payload.hook_event_name)) {
    return "";
  }
  const projectDir = env.CLAUDE_PROJECT_DIR ?? payload.cwd;
  const agentId = payload.agent_id ?? "";
  const prefix = markerPrefix(payload.session_id, agentId, tmpDir);
  const dir = path.join(projectDir, GUIDANCE_DIR);
  const fileCount = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).length;
  if (prefix !== undefined && fs.existsSync(completeMarker(prefix, fileCount))) {
    return "";
  }
  const rules = readRuleFiles(projectDir).map(({ rule }) => rule);
  const facts = callFacts(payload, projectDir);
  if (payload.tool_name === "Read") {
    for (const rule of guidanceFilesRead(rules, facts.paths)) {
      claimsFirstReach(prefix, rule);
    }
  }
  const reaches = reachesFor(rules, facts);
  const reachedFirst = reaches.filter((reach) => claimsFirstReach(prefix, reach.rule));
  if (
    prefix !== undefined &&
    rulesCountedForCompletion(rules, agentId).every((rule) =>
      fs.existsSync(ruleMarker(prefix, rule.name))
    )
  ) {
    fs.mkdirSync(completeMarker(prefix, fileCount), { recursive: true });
  }
  if (reachedFirst.length === 0) {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      additionalContext: pointerContext(reachedFirst),
      hookEventName: payload.hook_event_name,
    },
  });
};

export const runCheck = (projectDir) => {
  const problems = readRuleFiles(projectDir).flatMap(({ rule, text }) => {
    const problem = ruleProblem(rule, text);
    return problem === undefined ? [] : [`${GUIDANCE_DIR}/${rule.name}: ${problem}`];
  });
  return problems;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const isMain = process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes("--check")) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const problems = runCheck(projectDir);
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length === 0) {
      console.log(`${GUIDANCE_DIR}: every file has a trigger this hook answers`);
    }
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    try {
      const printed = runHook(await readStdin());
      if (printed !== "") {
        console.log(printed);
      }
    } catch {
      process.exitCode = 0;
    }
  }
}
