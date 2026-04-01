#!/usr/bin/env bash
# swiz shell shim — intercepts commands that AI agents should not use directly.
#
# Sourced from your shell profile to enforce coding standards at the shell level.
# Works regardless of which agent is running — no hook event support required.
#
# Behaviour:
#   Non-interactive shell (agent context) → command is BLOCKED
#   Interactive shell (human)             → warning printed, command proceeds
#
# Bypass:    SWIZ_BYPASS=1 grep ...
# Real cmd:  command grep ...
# Uninstall: swiz shim uninstall

# ── Dependency check ──────────────────────────────────────────────────────────
# swiz hooks and the shim redirect commands to bun. Warn once if it's missing.

if ! command -v bun >/dev/null 2>&1; then
  printf '\033[31mswiz: bun is not installed or not on PATH.\033[0m\n' >&2
  printf 'swiz hooks require bun to run. Install it:\n' >&2
  printf '  curl -fsSL https://bun.sh/install | bash\n\n' >&2
fi

# ── Project convention detection ──────────────────────────────────────────────
# Walk up from CWD to find the lockfile that identifies the project's PM.
# Called per-command (fast — just stat checks).

_swiz_detect_pm() {
  local dir="$PWD"
  while true; do
    [[ -f "$dir/bun.lockb" || -f "$dir/bun.lock" ]] && { echo "bun"; return; }
    [[ -f "$dir/pnpm-lock.yaml" || -f "$dir/shrinkwrap.yaml" ]] && { echo "pnpm"; return; }
    [[ -f "$dir/yarn.lock" || -f "$dir/.pnp.cjs" || -f "$dir/.pnp.js" ]] && { echo "yarn"; return; }
    [[ -f "$dir/package-lock.json" || -f "$dir/npm-shrinkwrap.json" ]] && { echo "npm"; return; }
    local parent
    parent="$(command dirname "$dir")"
    [[ "$parent" == "$dir" ]] && break
    dir="$parent"
  done
  echo ""
}

_swiz_detect_runtime() {
  local pm
  pm="$(_swiz_detect_pm)"
  [[ "$pm" == "bun" ]] && echo "bun" || echo "node"
}

_swiz_detect_runner() {
  local pm
  pm="$(_swiz_detect_pm)"
  case "$pm" in
    bun)  echo "bunx" ;;
    pnpm) echo "pnpm dlx" ;;
    yarn) echo "yarn dlx" ;;
    *)    echo "npx" ;;
  esac
}

# ── Agent detection ──────────────────────────────────────────────────────────
# Mirrors the logic in src/detect.ts:isRunningInAgent() for shell context.
# The TypeScript version is used by hooks and commands (src/commands/status.ts).
# This bash version is for shell-level enforcement before tools are invoked.

_swiz_is_agent() {
  # Non-interactive shell is almost certainly an agent
  [[ $- != *i* ]] && return 0
  # Known agent environment indicators (from AGENTS array in src/agents.ts)
  [[ -n "${CURSOR_TRACE_ID:-}" ]] && return 0
  [[ -n "${CLAUDE_CODE:-}" ]] && return 0
  # Force via env var
  [[ "${SWIZ_SHIM:-}" == "strict" ]] && return 0
  return 1
}

# Core guard function. Returns 0 (true) if the command should be blocked.
_swiz_guard() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && return 1

  local cmd="$1" alt="$2" msg="$3"
  shift 3

  if _swiz_is_agent; then
    # shellcheck disable=SC2016
    printf 'swiz: Do not use `%s`. %s\n' "$cmd" "$msg" >&2
    return 0
  else
    # shellcheck disable=SC2016
    printf '\033[33mswiz: consider `%s` instead of `%s`\033[0m\n' "$alt" "$cmd" >&2
    return 1
  fi
}

# ── Search tools ──────────────────────────────────────────────────────────────

grep() {
  _swiz_guard grep rg \
    "Use \`rg\` (ripgrep) — faster, respects .gitignore, better defaults." "$@" && return 1
  command grep "$@"
}

egrep() {
  _swiz_guard egrep "rg -P" \
    "Use \`rg\` (ripgrep) with Perl-compatible regex." "$@" && return 1
  command egrep "$@"
}

fgrep() {
  _swiz_guard fgrep "rg -F" \
    "Use \`rg -F\` (ripgrep, fixed-string mode)." "$@" && return 1
  command fgrep "$@"
}

find() {
  _swiz_guard find fd \
    "Use \`fd\` — faster, respects .gitignore. Or use the Glob tool." "$@" && return 1
  command find "$@"
}

# ── File editing (agents should use Edit/StrReplace tool) ────────────────────

sed() {
  _swiz_guard sed "Edit tool" \
    "Use the Edit/StrReplace tool for file modifications. Sed produces unreviewed changes." "$@" && return 1
  command sed "$@"
}

awk() {
  _swiz_guard awk "Edit tool" \
    "Use the Edit/StrReplace tool for file processing. Awk is unreliable for edits." "$@" && return 1
  command awk "$@"
}

# ── Package managers (project-aware) ─────────────────────────────────────────
# Detect the project's PM from lockfiles. If you're already using the right
# one, it passes through. If not, you're told what this project uses.

_swiz_pm_guard() {
  local invoked="$1"; shift
  local pm
  pm="$(_swiz_detect_pm)"

  # No lockfile found — can't enforce, allow
  [[ -z "$pm" ]] && return 1
  # Already using the project's PM — allow
  [[ "$invoked" == "$pm" ]] && return 1

  _swiz_guard "$invoked" "$pm" \
    "This project uses \`$pm\` (detected from lockfile). Use \`$pm\` instead." "$@"
}

npm() {
  _swiz_pm_guard npm "$@" && return 1
  command npm "$@"
}

npx() {
  local runner
  runner="$(_swiz_detect_runner)"
  [[ "$runner" == "npx" ]] && { command npx "$@"; return $?; }
  _swiz_guard npx "$runner" \
    "This project uses \`$runner\` instead of npx." "$@" && return 1
  command npx "$@"
}

yarn() {
  _swiz_pm_guard yarn "$@" && return 1
  command yarn "$@"
}

pnpm() {
  _swiz_pm_guard pnpm "$@" && return 1
  command pnpm "$@"
}

bun() {
  _swiz_pm_guard bun "$@" && return 1
  command bun "$@"
}

# ── Runtimes (project-aware) ─────────────────────────────────────────────────
# Only block node/ts-node if the project uses bun. Python is always redirected
# to the project's runtime.

node() {
  local rt
  rt="$(_swiz_detect_runtime)"
  [[ "$rt" == "node" ]] && { command node "$@"; return $?; }
  _swiz_guard node "$rt" \
    "This project uses \`$rt\`. Use \`$rt\` instead of node." "$@" && return 1
  command node "$@"
}

ts-node() {
  local rt
  rt="$(_swiz_detect_runtime)"
  [[ "$rt" == "node" ]] && { command ts-node "$@"; return $?; }
  _swiz_guard ts-node "$rt" \
    "This project uses \`$rt\` with native TypeScript. Use \`$rt\` instead." "$@" && return 1
  command ts-node "$@"
}

python() {
  local rt
  rt="$(_swiz_detect_runtime)"
  _swiz_guard python "$rt" \
    "Use \`$rt\` instead of python — consistent runtime across environments." "$@" && return 1
  command python "$@"
}

python3() {
  local rt
  rt="$(_swiz_detect_runtime)"
  _swiz_guard python3 "$rt" \
    "Use \`$rt\` instead of python3 — consistent runtime across environments." "$@" && return 1
  command python3 "$@"
}

# ── File creation (agents should use Write tool) ─────────────────────────────

touch() {
  _swiz_guard touch "Write tool" \
    "Use the Write tool to create files. It is tracked, reviewable, and works for empty files." "$@" && return 1
  command touch "$@"
}

# ── Destructive commands ─────────────────────────────────────────────────────

rm() {
  _swiz_guard rm "trash" \
    "Use \`trash <path>\` for recoverable deletion, or \`mv <path> ~/.Trash/\`." "$@" && return 1
  command rm "$@"
}

# ── Chaining helper ──────────────────────────────────────────────────────────
# If a function already exists (e.g. from .shell_common), rename it so the
# swiz wrapper can chain through it. Swiz is the authority — its guards
# always run first, then the previous wrapper (if any) handles the rest.

_swiz_has_function() {
  type "$1" 2>/dev/null | command grep -q 'function'
}

_swiz_chain_existing() {
  local name="$1" chain="_swiz_chain_${1}"
  if _swiz_has_function "$name"; then
    eval "$(declare -f "$name" | command sed "1s/^${name} /${chain} /")"
  fi
}

# Passthrough: call the chained wrapper if it exists, otherwise command directly
_swiz_run_git() {
  if _swiz_has_function _swiz_chain_git; then
    _swiz_chain_git "$@"
  else
    command git "$@"
  fi
}

_swiz_run_gh() {
  if _swiz_has_function _swiz_chain_gh; then
    _swiz_chain_gh "$@"
  else
    command gh "$@"
  fi
}

# Save existing wrappers before we override them
_swiz_chain_existing git
_swiz_chain_existing gh

# ── Git security ─────────────────────────────────────────────────────────────
# Swiz is the authority. These guards always run first, then delegate to any
# existing wrapper (e.g. .shell_common) or directly to `command git`.

git() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && { command git "$@"; return $?; }

  # Strip --trailer arguments (AI tools inject these to sign commits)
  local args=()
  local skip_next=false
  for arg in "$@"; do
    if $skip_next; then
      skip_next=false
      continue
    fi
    case "$arg" in
      --trailer=*) continue ;;
      --trailer) skip_next=true; continue ;;
      *) args+=("$arg") ;;
    esac
  done
  set -- "${args[@]}"

  # Block --no-verify on commit and push
  if [[ "$1" == "commit" || "$1" == "push" ]]; then
    case "$*" in
      *--no-verify*)
        printf 'swiz: git %s --no-verify is blocked.\n' "$1" >&2
        printf 'This flag bypasses pre-commit hooks and other safety mechanisms.\n' >&2
        printf 'Address the underlying issue flagged by the hooks instead.\n' >&2
        return 1
        ;;
    esac
  fi

  # Block dangerous git subcommands
  case "$1" in
    stash)
      case "$2" in
        list|show)
          # Read-only inspection — allow
          ;;
        *)
          printf 'swiz: Do not use `git stash`. Stashed changes are easy to lose.\n' >&2
          printf 'Commit work-in-progress instead: git commit -m "wip: ..."\n' >&2
          return 1
          ;;
      esac
      ;;
    restore)
      printf 'swiz: Do not use `git restore`. It silently discards uncommitted changes.\n' >&2
      printf 'Use the Edit tool to undo specific changes, or `git revert <hash>`.\n' >&2
      return 1
      ;;
    clean)
      printf 'swiz: Do not use `git clean`. It permanently deletes untracked files.\n' >&2
      printf 'Use `trash <path>` for recoverable deletion.\n' >&2
      return 1
      ;;
  esac

  # Block git reset --hard
  if [[ "$1" == "reset" ]]; then
    case "$*" in
      *--hard*)
        printf 'swiz: Do not use `git reset --hard`. It destroys uncommitted changes.\n' >&2
        printf 'Use `git revert <hash>` or `git reset HEAD~1` (soft, keeps changes staged).\n' >&2
        return 1
        ;;
    esac
  fi

  # Block git checkout -- <file> (discards changes)
  if [[ "$1" == "checkout" ]]; then
    case "$*" in
      *" -- "*)
        printf 'swiz: Do not use `git checkout -- <file>`. It discards file changes.\n' >&2
        printf 'Use the Edit tool to undo specific changes, or `git revert <hash>`.\n' >&2
        return 1
        ;;
    esac
  fi

  # Block co-authored and AI-signed commits
  if [[ "$1" == "commit" ]]; then
    local commit_msg=""
    local i=1
    while [[ $i -le $# ]]; do
      eval "local arg=\${$i}"
      if [[ "$arg" == "-m" ]]; then
        i=$((i + 1))
        eval "commit_msg=\${$i}"
        break
      fi
      i=$((i + 1))
    done

    if [[ -n "$commit_msg" ]]; then
      case "$commit_msg" in
        *Co-authored-by:*)
          printf 'swiz: Co-authored commits are blocked.\n' >&2
          printf 'Create commits without co-author attribution.\n' >&2
          return 1
          ;;
      esac
      if echo "$commit_msg" | command grep -qiE "generated.*with.*claude.*code"; then
        printf 'swiz: AI-generation signatures in commit messages are blocked.\n' >&2
        printf 'Write your own commit messages.\n' >&2
        return 1
      fi
    fi
  fi

  # Delegate to chained wrapper or raw git
  _swiz_run_git "$@"
  local git_exit=$?

  # Clean stale lock files when no other git processes are running
  if command git rev-parse --git-dir > /dev/null 2>&1; then
    local git_dir
    git_dir=$(command git rev-parse --git-dir 2>/dev/null)
    if [[ -n "$git_dir" && -f "$git_dir/index.lock" ]]; then
      if ! pgrep -q git 2>/dev/null; then
        command rm -f "$git_dir/index.lock" 2>/dev/null
      fi
    fi
  fi

  return $git_exit
}

# ── GitHub CLI security ──────────────────────────────────────────────────────

gh() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && { command gh "$@"; return $?; }

  case "$*" in
    *--admin*)
      printf 'swiz: gh --admin is blocked.\n' >&2
      printf 'This flag bypasses repository protection rules and required checks.\n' >&2
      printf 'Ensure PRs pass all required checks and obtain proper approvals.\n' >&2
      return 1
      ;;
  esac

  _swiz_run_gh "$@"
}
