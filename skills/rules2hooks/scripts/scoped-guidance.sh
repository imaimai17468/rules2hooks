#!/usr/bin/env bash
#
# Point the model at a guidance file once per session, as additionalContext,
# when the session reaches a file its `paths` cover, runs a command its
# `commands` name, or fires an event its `events` list.
#
# Run it from PreToolUse, PostToolUse and UserPromptSubmit, and from
# SessionStart for `clear` and `compact`, which makes it name every file again.
# Before a call, the paths and the command the call names decide; after a Bash
# call, the files git lists as changed decide, which covers a write whose
# command named no path.
#
#   scoped-guidance.sh --check   report each guidance file no trigger reaches,
#                                exiting 1 when there is one
#
# Needs bash 3.2 or later, awk, sed, grep and git, so it runs wherever Claude
# Code runs its hooks, with no language runtime to install. The context is
# advisory, so on a hook call every failure exits 0 and prints nothing.

set -u

GUIDANCE_DIR=${SCOPED_GUIDANCE_DIR:-.claude/hooks/guidance}
HOOK_EVENTS="PreToolUse PostToolUse UserPromptSubmit"
TMP_DIR=${SCOPED_GUIDANCE_TMP:-${TMPDIR:-/tmp}}
TMP_DIR=${TMP_DIR%/}
SEP=$(printf '\036')
TAB=$(printf '\t')

# ------------------------------------------------------------------- payload

# The string values of the payload fields this hook reads, each followed by
# \036, in a single pass. A field is the first unescaped "key" in the JSON, so
# `command` is tool_input's. Escapes are decoded except \uXXXX, which no path
# or phrase needs.
payload_fields() {
  awk -v sep="$SEP" '
    function field(text, key,    needle, start, i, pos, rest, out, j, c, e) {
      needle = "\"" key "\""
      start = 1
      while ((i = index(substr(text, start), needle)) > 0) {
        pos = start + i - 1
        if (pos == 1 || substr(text, pos - 1, 1) != "\\") break
        start = pos + length(needle)
      }
      if (i == 0) return ""
      rest = substr(text, pos + length(needle))
      if (!match(rest, /^[ \t\r\n]*:[ \t\r\n]*"/)) return ""
      rest = substr(rest, RLENGTH + 1)
      out = ""
      for (j = 1; j <= length(rest); j++) {
        c = substr(rest, j, 1)
        if (c == "\"") break
        if (c == "\\") {
          j++
          e = substr(rest, j, 1)
          if (e == "n") out = out "\n"
          else if (e == "t") out = out "\t"
          else if (e == "r") out = out "\r"
          else if (e == "u") out = out "\\u"
          else out = out e
        } else {
          out = out c
        }
      }
      return out
    }
    { text = text $0 "\n" }
    END {
      n = split("hook_event_name session_id agent_id cwd tool_name source file_path notebook_path command", keys, " ")
      for (k = 1; k <= n; k++) printf "%s%s", field(text, keys[k]), sep
    }'
}

# ---------------------------------------------------------------- frontmatter

# One line per trigger across the given files: `file<TAB>key<TAB>item<TAB>ere`,
# the key being paths, commands or events. A comma-separated string, a flow
# list and a block list are all read, so no YAML parser loads on every tool
# call. For paths the ERE matches a project-relative path; for commands it
# matches a line that runs the phrase as a command of its own.
read_triggers() {
  awk -v q="'" '
    function escape(s,    out, k, c) {
      out = ""
      for (k = 1; k <= length(s); k++) {
        c = substr(s, k, 1)
        if (index(".^$*+?()[]{}|\\", c)) out = out "\\" c; else out = out c
      }
      return out
    }
    # `**` crosses directories, `*` and `?` stay inside one, `{a,b}` picks
    # one, and `[...]` is a character class. `*.md` matches a root file only.
    function glob_ere(g,    out, k, c, cl, body) {
      out = ""
      for (k = 1; k <= length(g); k++) {
        c = substr(g, k, 1)
        if (c == "*" && substr(g, k + 1, 1) == "*") {
          if (substr(g, k + 2, 1) == "/") { out = out "(.*/)?"; k += 2 } else { out = out ".*"; k += 1 }
        } else if (c == "*") out = out "[^/]*"
        else if (c == "?") out = out "[^/]"
        else if (c == "{" && (cl = index(substr(g, k), "}")) > 0) {
          body = substr(g, k + 1, cl - 2)
          gsub(/,/, "|", body)
          out = out "(" glob_body(body) ")"
          k += cl - 1
        } else if (c == "[" && (cl = index(substr(g, k + 1), "]")) > 0) {
          body = substr(g, k + 1, cl - 1)
          if (substr(body, 1, 1) == "!") body = "^" substr(body, 2)
          out = out "[" body "]"
          k += cl
        } else out = out escape(c)
      }
      return "^" out "$"
    }
    function glob_body(b,    out, k, c) {
      out = ""
      for (k = 1; k <= length(b); k++) {
        c = substr(b, k, 1)
        if (c == "*") out = out "[^/]*"
        else if (c == "?") out = out "[^/]"
        else if (c == "|") out = out "|"
        else out = out escape(c)
      }
      return out
    }
    function phrase_ere(p) {
      return "(^|[;&|({]|(^|[^[:alnum:]_])(then|do|else|time)[[:space:]])[[:space:]]*([[:alnum:]_]+=[^[:space:]]*[[:space:]]+)*" escape(p) "([[:space:];&|)}]|$)"
    }
    function unquote(s,    first, last) {
      gsub(/^[ \t]+|[ \t\r]+$/, "", s)
      first = substr(s, 1, 1); last = substr(s, length(s), 1)
      if (length(s) >= 2 && first == last && (first == "\"" || first == q)) s = substr(s, 2, length(s) - 2)
      return s
    }
    function emit(key, s,    ere) {
      s = unquote(s)
      if (s == "") return
      ere = key == "paths" ? glob_ere(s) : key == "commands" ? phrase_ere(s) : ""
      print FILENAME "\t" key "\t" s "\t" ere
    }
    FNR == 1 { inside = ($0 ~ /^---[ \t\r]*$/); block = ""; next }
    !inside { next }
    /^---[ \t\r]*$/ { inside = 0; next }
    {
      if (block != "" && $0 ~ /^[ \t]+-[ \t]+/) { line = $0; sub(/^[ \t]+-[ \t]+/, "", line); emit(block, line); next }
      block = ""
      if (match($0, /^(paths|commands|events):/)) {
        key = substr($0, 1, RLENGTH - 1)
        value = substr($0, RLENGTH + 1)
        gsub(/^[ \t]+|[ \t\r]+$/, "", value)
        if (value == "") { block = key; next }
        if (value ~ /^\[.*\]$/) value = substr(value, 2, length(value) - 2)
        else value = unquote(value)
        # Split on commas outside braces, so `src/*.{ts,tsx}` stays one item.
        depth = 0; item = ""
        for (k = 1; k <= length(value); k++) {
          c = substr(value, k, 1)
          if (c == "{") depth++
          else if (c == "}" && depth > 0) depth--
          if (c == "," && depth == 0) { emit(key, item); item = "" } else item = item c
        }
        emit(key, item)
      }
    }' "$@"
}

has_frontmatter() {
  head -n 1 "$1" | grep -qE '^---[[:space:]]*$' &&
    tail -n +2 "$1" | grep -qE '^---[[:space:]]*$'
}

is_hook_event() {
  case " $HOOK_EVENTS " in *" $1 "*) return 0 ;; esac
  return 1
}

# --------------------------------------------------------------- tool calls

# Path-like words in a command: a run of path characters ending in an
# extension. A word that names no file the command opens, such as a path in a
# grep pattern, costs one pointer line and nothing more.
paths_in_command() {
  printf '%s\n' "$1" | grep -oE '[[:alnum:]_.${}@~/-]*\.[A-Za-z][[:alnum:]_]*' || true
}

# Set REL to a path relative to the project root, or to nothing where the
# path lies outside it.
project_relative() {
  local written=$1 cwd=$2 project=$3 full part out=""
  REL=""
  case $written in
    '$CLAUDE_PROJECT_DIR/'*) written="$project/${written#\$CLAUDE_PROJECT_DIR/}" ;;
    '${CLAUDE_PROJECT_DIR}/'*) written="$project/${written#\$\{CLAUDE_PROJECT_DIR\}/}" ;;
  esac
  case $written in /*) full=$written ;; *) full="$cwd/$written" ;; esac
  local IFS=/
  for part in $full; do
    case $part in
      '' | .) ;;
      ..) out=${out%/*} ;;
      *) out="$out/$part" ;;
    esac
  done
  case $out in
    "$project"/*) REL=${out#"$project"/} ;;
  esac
}

changed_files() {
  git -C "$1" ls-files --modified --others --exclude-standard 2>/dev/null
  git -C "$1" diff --name-only --cached --relative 2>/dev/null
}

# Set REASON to why the call brings the file into scope, or to nothing.
# Events are checked first, then paths, then commands.
reason_for() {
  local file=$1 event=$2 command=$3 paths=$4 triggers=$5 f key item ere path line
  REASON=""
  while IFS=$TAB read -r f key item ere; do
    [ "$f" = "$file" ] && [ "$key" = events ] && [ "$item" = "$event" ] && { REASON="fired $event"; return; }
  done <<< "$triggers"
  if [ -n "$paths" ]; then
    while IFS=$TAB read -r f key item ere; do
      [ "$f" = "$file" ] && [ "$key" = paths ] || continue
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        if [[ $path =~ $ere ]]; then REASON="reached $path"; return; fi
      done <<< "$paths"
    done <<< "$triggers"
  fi
  [ -n "$command" ] || return
  while IFS=$TAB read -r f key item ere; do
    [ "$f" = "$file" ] && [ "$key" = commands ] || continue
    while IFS= read -r line; do
      if [[ $line =~ $ere ]]; then REASON="ran \`$item\`"; return; fi
    done <<< "$command"
  done <<< "$triggers"
}

# Whether a file has a trigger this hook answers. With an agent id, a file
# only `UserPromptSubmit` reaches is left out: a subagent receives no prompt.
counts_for_completion() {
  local file=$1 agent=$2 triggers=$3 f key item ere
  while IFS=$TAB read -r f key item ere; do
    [ "$f" = "$file" ] || continue
    case $key in
      paths | commands) return 0 ;;
      events)
        is_hook_event "$item" || continue
        { [ -z "$agent" ] || [ "$item" != UserPromptSubmit ]; } && return 0 ;;
    esac
  done <<< "$triggers"
  return 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}

# --------------------------------------------------------------------- check

run_check() {
  local project=$1 file name problems=0 f key item ere has unanswered triggers
  shopt -s nullglob
  for file in "$project/$GUIDANCE_DIR"/*.md; do
    name=${file##*/}
    if ! has_frontmatter "$file"; then
      echo "$GUIDANCE_DIR/$name: has no frontmatter, so no trigger can bring it in" >&2
      problems=$((problems + 1)); continue
    fi
    has="" unanswered=""
    triggers=$(read_triggers "$file")
    while IFS=$TAB read -r f key item ere; do
      [ -n "$key" ] || continue
      if [ "$key" = events ] && ! is_hook_event "$item"; then unanswered="$unanswered${unanswered:+, }$item"; else has=1; fi
    done <<< "$triggers"
    if [ -n "$unanswered" ]; then
      echo "$GUIDANCE_DIR/$name: events names $unanswered, which this hook does not answer (it answers ${HOOK_EVENTS// /, })" >&2
      problems=$((problems + 1))
    elif [ -z "$has" ]; then
      echo "$GUIDANCE_DIR/$name: names none of paths, commands or events, so no session reaches it" >&2
      problems=$((problems + 1))
    fi
  done
  [ "$problems" -eq 0 ] && echo "$GUIDANCE_DIR: every file has a trigger this hook answers"
  [ "$problems" -eq 0 ]
}

# ---------------------------------------------------------------------- hook

run_hook() {
  local event session agent cwd tool source file_path notebook_path command
  {
    IFS= read -r -d "$SEP" event
    IFS= read -r -d "$SEP" session
    IFS= read -r -d "$SEP" agent
    IFS= read -r -d "$SEP" cwd
    IFS= read -r -d "$SEP" tool
    IFS= read -r -d "$SEP" source
    IFS= read -r -d "$SEP" file_path
    IFS= read -r -d "$SEP" notebook_path
    IFS= read -r -d "$SEP" command
  } < <(payload_fields)
  session=${session//[^A-Za-z0-9_-]/}
  agent=${agent//[^A-Za-z0-9_-]/}

  if [ "$event" = SessionStart ]; then
    case $source in
      clear | compact) [ -n "$session" ] && rm -rf "$TMP_DIR/claude-scoped-guidance-$session-"* ;;
    esac
    return 0
  fi
  is_hook_event "$event" || return 0

  local project=${CLAUDE_PROJECT_DIR:-$cwd}
  [ -n "$cwd" ] || cwd=$project
  shopt -s nullglob
  local files=("$project/$GUIDANCE_DIR"/*.md)
  local count=${#files[@]}
  [ "$count" -gt 0 ] || return 0

  local prefix=""
  [ -n "$session$agent" ] && prefix="$TMP_DIR/claude-scoped-guidance-$session-$agent"
  local complete="$prefix.complete-$count"
  if [ -n "$prefix" ] && [ -d "$complete" ]; then return 0; fi

  local paths="" written named
  case $event in
    UserPromptSubmit) command="" ;;
    PostToolUse)
      [ -n "$command" ] && paths=$(changed_files "$project")
      command="" ;;
    PreToolUse)
      named="$file_path"$'\n'"$notebook_path"
      [ -n "$command" ] && named="$named"$'\n'"$(paths_in_command "$command")"
      while IFS= read -r written; do
        [ -n "$written" ] || continue
        project_relative "$written" "$cwd" "$project"
        [ -n "$REL" ] && paths="$paths$REL"$'\n'
      done <<< "$named" ;;
  esac

  local triggers file name marker context="" all_reached=1
  triggers=$(read_triggers "${files[@]}")
  for file in "${files[@]}"; do
    name=${file##*/}
    marker="$prefix-${name//[^A-Za-z0-9_-]/}"
    # A guidance file the session opened with Read needs no pointer.
    if [ -n "$prefix" ] && [ "$tool" = Read ]; then
      case $'\n'"$paths" in *$'\n'"$GUIDANCE_DIR/$name"$'\n'*) mkdir "$marker" 2>/dev/null ;; esac
    fi
    reason_for "$file" "$event" "$command" "$paths" "$triggers"
    if [ -n "$REASON" ]; then
      # mkdir tests and claims in one step, so of calls issued together
      # exactly one names the file.
      if [ -z "$prefix" ] || mkdir "$marker" 2>/dev/null; then
        context="$context${context:+$'\n'}$GUIDANCE_DIR/$name applies because this session $REASON. Read $GUIDANCE_DIR/$name completely before continuing. This hook names it once per session."
      fi
    fi
    if [ -n "$prefix" ] && [ ! -d "$marker" ] && counts_for_completion "$file" "$agent" "$triggers"; then
      all_reached=0
    fi
  done
  [ -n "$prefix" ] && [ "$all_reached" -eq 1 ] && mkdir -p "$complete"

  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$event" "$(json_escape "$context")"
}

if [ "${1:-}" = --check ]; then
  run_check "${CLAUDE_PROJECT_DIR:-$PWD}"
  exit
fi
run_hook 2>/dev/null
exit 0
