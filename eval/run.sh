#!/usr/bin/env bash
# Measure whether a path-scoped rule is followed when Claude edits through Bash,
# with the rule in .claude/rules/ ("before") and behind the hook ("after").
#
#   eval/run.sh [trials per arm, default 10] [parallel runs, default 5]
#
# Needs an authenticated `claude` CLI. Each trial is a fresh clone with its own
# session id, so no trial sees another's markers. Prints one line per trial and
# the count per arm.

set -euo pipefail

TRIALS=${1:-10}
PARALLEL=${2:-5}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rules2hooks-eval-XXXXXX")
MARK="// reviewed-by: frontend-rule"
PROMPT="Add a boolean loading prop to src/components/UserCard.tsx that renders 'Loading...' when true. Read and edit files only through the Bash tool (cat, sed, python). Do not use the Read, Edit or Write tools. Do not commit."

make_fixture() {
  local dir=$1
  mkdir -p "$dir/.claude/rules" "$dir/src/components"
  cat > "$dir/.claude/rules/frontend.md" <<RULE
---
paths: src/**/*.tsx
---

# Frontend

Every \`.tsx\` file under \`src/\` starts with the line \`$MARK\` as its first line. Add it when you edit a file that lacks it.
RULE
  cat > "$dir/src/components/UserCard.tsx" <<'TSX'
export function UserCard({ name }: { name: string }) {
  return <div className="card">{name}</div>;
}
TSX
  git -C "$dir" init -q
  git -C "$dir" add -A
  git -C "$dir" -c user.email=eval@example.com -c user.name=eval commit -qm before
  git -C "$dir" branch -q before

  mkdir -p "$dir/.claude/hooks/guidance"
  git -C "$dir" mv .claude/rules/frontend.md .claude/hooks/guidance/frontend.md
  cp "$REPO/skills/rules2hooks/scripts/scoped-guidance.mjs" "$dir/.claude/hooks/"
  local cmd='node "$CLAUDE_PROJECT_DIR"/.claude/hooks/scoped-guidance.mjs'
  cat > "$dir/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "$(printf '%s' "$cmd" | sed 's/"/\\"/g')", "timeout": 15 }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "$(printf '%s' "$cmd" | sed 's/"/\\"/g')", "timeout": 15 }] }]
  }
}
JSON
  git -C "$dir" add -A
  git -C "$dir" -c user.email=eval@example.com -c user.name=eval commit -qm after
  git -C "$dir" branch -q after
}

trial() {
  local arm=$1 n=$2 dir="$WORK/$1-$2"
  git clone -q --branch "$arm" "$WORK/fixture" "$dir"
  (cd "$dir" && timeout 300 claude -p --session-id "$(node -e 'console.log(crypto.randomUUID())')" "$PROMPT" --allowedTools=Bash,Read >/dev/null 2>&1) || true
  if [ "$(head -1 "$dir/src/components/UserCard.tsx")" = "$MARK" ]; then
    echo "$arm $n followed"
  else
    echo "$arm $n missed"
  fi
}

export -f trial
export WORK MARK PROMPT

make_fixture "$WORK/fixture"
for i in $(seq 1 "$TRIALS"); do printf 'before %s\nafter %s\n' "$i" "$i"; done \
  | xargs -P "$PARALLEL" -L 1 bash -c 'trial "$0" "$1"' \
  | tee "$WORK/results.txt"

for arm in before after; do
  echo "$arm: $(grep -c "^$arm .* followed" "$WORK/results.txt" || true) of $TRIALS followed the rule"
done
echo "trials kept in $WORK"
