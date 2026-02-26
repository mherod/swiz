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

_swiz_is_agent() {
  # Non-interactive shell is almost certainly an agent
  [[ $- != *i* ]] && return 0
  # Known agent environment indicators
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
    printf 'swiz: Do not use `%s`. %s\n' "$cmd" "$msg" >&2
    return 0
  else
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

# ── Package managers (project uses bun) ──────────────────────────────────────

npm() {
  local subcmd="${1:-}"
  case "$subcmd" in
    install|i|add|ci|uninstall|remove|rm|un|r|update|up|upgrade|dedupe|rebuild|link)
      _swiz_guard npm "bun ${subcmd}" \
        "Use \`bun\` instead of npm. bun is the project-standard runtime." "$@" && return 1 ;;
    run|start|test|t)
      _swiz_guard npm "bun run" \
        "Use \`bun run <script>\` instead." "$@" && return 1 ;;
    exec)
      _swiz_guard npm bunx \
        "Use \`bunx <pkg>\` instead of \`npm exec\`." "$@" && return 1 ;;
    *)
      ;; # allow npm info, npm view, etc.
  esac
  command npm "$@"
}

npx() {
  _swiz_guard npx bunx \
    "Use \`bunx\` instead of npx." "$@" && return 1
  command npx "$@"
}

yarn() {
  _swiz_guard yarn bun \
    "Use \`bun\` instead of yarn. bun is the project-standard runtime." "$@" && return 1
  command yarn "$@"
}

pnpm() {
  _swiz_guard pnpm bun \
    "Use \`bun\` instead of pnpm. bun is the project-standard runtime." "$@" && return 1
  command pnpm "$@"
}

# ── Runtimes (project uses bun) ──────────────────────────────────────────────

node() {
  _swiz_guard node bun \
    "Use \`bun\` instead of node — native TypeScript, faster startup." "$@" && return 1
  command node "$@"
}

ts-node() {
  _swiz_guard ts-node bun \
    "Use \`bun\` instead of ts-node — native TypeScript, no compilation step." "$@" && return 1
  command ts-node "$@"
}

python() {
  _swiz_guard python bun \
    "Use \`bun\` instead of python — consistent runtime across environments." "$@" && return 1
  command python "$@"
}

python3() {
  _swiz_guard python3 bun \
    "Use \`bun\` instead of python3 — consistent runtime across environments." "$@" && return 1
  command python3 "$@"
}

# ── Destructive commands ─────────────────────────────────────────────────────

rm() {
  _swiz_guard rm "trash" \
    "Use \`trash <path>\` for recoverable deletion, or \`mv <path> ~/.Trash/\`." "$@" && return 1
  command rm "$@"
}

# ── Git security ─────────────────────────────────────────────────────────────
# Blocks unsafe git patterns that agents abuse: --no-verify, --trailer
# injection, Co-authored-by signatures, AI generation markers.
#
# Adopted from ~/.shell_common. Only defined if no existing git() wrapper is
# present (e.g. .shell_common already sourced in interactive shells). This
# ensures the shim provides coverage in non-interactive agent shells without
# clobbering the user's own wrapper.

_swiz_has_function() {
  # Portable check for bash and zsh
  type "$1" 2>/dev/null | command grep -q 'function'
}

if ! _swiz_has_function git; then
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

  command git "$@"
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
fi

# ── GitHub CLI security ──────────────────────────────────────────────────────
# Blocks --admin flag which bypasses repository protection rules.
# Only defined if no existing gh() wrapper is present.

if ! _swiz_has_function gh; then
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

  command gh "$@"
}
fi
