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

# ── Unset pre-existing aliases for shimmed commands ────────────────────────────
# Pre-existing aliases (e.g. alias grep='grep --color=auto') cause zsh/bash parse
# errors when defining functions of the same name.
builtin unalias \
  cd grep egrep fgrep find cp perl sed awk vim vi nano emacs \
  npm npx yarn pnpm bun node ts-node python python3 touch rm git gh \
  _swiz_ensure_bun_path _swiz_declared_pm _swiz_is_global_pm_operation \
  _swiz_package_dir _swiz_detect_pm \
  _swiz_detect_runtime _swiz_detect_runner \
  _swiz_is_agent_process _swiz_is_agent_env _swiz_get_setting _swiz_guard \
  _swiz_pm_guard _swiz_has_function _swiz_chain_existing _swiz_run_git _swiz_run_gh \
  2>/dev/null || true

# ── Dependency check ──────────────────────────────────────────────────────────
# swiz hooks and the shim redirect commands to bun. The shim is sourced from
# .zshenv before a login shell reaches .zprofile, so recover the standard Bun
# install locations before deciding that Bun is unavailable.

_swiz_ensure_bun_path() {
  command -v bun >/dev/null 2>&1 && return 0

  local candidate
  for candidate in \
    "${BUN_INSTALL:-${HOME:-}/.bun}/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      PATH="${candidate%/bun}:$PATH"
      export PATH
      return 0
    fi
  done

  return 1
}

if ! _swiz_ensure_bun_path; then
  printf '\033[31mswiz: bun is not installed or not on PATH.\033[0m\n' >&2
  printf 'swiz hooks require bun to run. Install it:\n' >&2
  printf '  curl -fsSL https://bun.sh/install | bash\n\n' >&2
fi

# ── Project convention detection ──────────────────────────────────────────────
# Prefer an explicit packageManager declaration, then walk up from CWD for
# lockfile signals. Conflicting npm and non-npm lockfiles are ambiguous, so the
# shell shim fails open and leaves the canonical hook detector to decide.

_swiz_declared_pm() {
  local package_json="$1/package.json"
  [[ -f "$package_json" ]] || return 0

  command bun -e '
    const supported = new Set(["bun", "pnpm", "yarn", "npm"])
    try {
      const packageJson = await Bun.file(Bun.argv.at(-1)).json()
      const value = typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : ""
      if (supported.has(value)) process.stdout.write(value)
    } catch {}
  ' "$package_json" 2>/dev/null
}

_swiz_package_dir() {
  local dir="$PWD"
  local arg
  while [[ $# -gt 0 ]]; do
    arg="$1"
    shift
    case "$arg" in
      --)
        break
        ;;
      --prefix)
        [[ $# -gt 0 ]] && dir="$1"
        break
        ;;
      --prefix=*)
        dir="${arg#--prefix=}"
        break
        ;;
    esac
  done

  case "$dir" in
    /*) ;;
    *) dir="$PWD/$dir" ;;
  esac
  echo "$dir"
}

_swiz_is_global_pm_operation() {
  local invoked="$1"
  shift

  local arg subcommand="" secondary="" location=""
  local has_global_flag=false
  local expect_location=false
  while [[ $# -gt 0 ]]; do
    arg="$1"
    shift

    if $expect_location; then
      location="$arg"
      expect_location=false
      continue
    fi

    case "$arg" in
      --)
        break
        ;;
      -g|--global)
        has_global_flag=true
        ;;
      --location)
        expect_location=true
        ;;
      --location=*)
        location="${arg#--location=}"
        ;;
      -*)
        ;;
      *)
        if [[ -z "$subcommand" ]]; then
          subcommand="$arg"
        elif [[ -z "$secondary" ]]; then
          secondary="$arg"
        fi
        ;;
    esac
  done

  [[ "$location" == "project" ]] && return 1

  if [[ "$subcommand" == "config" && "$location" == "global" ]]; then
    return 0
  fi

  # Yarn Classic exposes global administration through `yarn global ...`.
  [[ "$invoked" == "yarn" && "$subcommand" == "global" ]] && return 0

  # pnpm config defaults to the global location unless project is explicit.
  [[ "$invoked" == "pnpm" && "$subcommand" == "config" ]] && return 0

  $has_global_flag || return 1

  case "$invoked:$subcommand" in
    npm:install|npm:i|npm:add|npm:uninstall|npm:remove|npm:rm|npm:update|npm:up|npm:list|npm:ls|npm:outdated|npm:root|npm:bin|npm:prefix|npm:link|npm:unlink|npm:config)
      return 0
      ;;
    pnpm:install|pnpm:i|pnpm:add|pnpm:uninstall|pnpm:remove|pnpm:rm|pnpm:update|pnpm:up|pnpm:list|pnpm:ls|pnpm:outdated|pnpm:root|pnpm:bin|pnpm:link|pnpm:unlink)
      return 0
      ;;
    yarn:config)
      return 0
      ;;
    bun:add|bun:install|bun:remove)
      return 0
      ;;
    bun:pm)
      [[ "$secondary" == "bin" ]] && return 0
      ;;
  esac

  return 1
}

_swiz_detect_pm() {
  local dir="${1:-$PWD}"
  while true; do
    local declared
    declared="$(_swiz_declared_pm "$dir")"
    [[ -n "$declared" ]] && { echo "$declared"; return; }

    local has_bun=0 has_pnpm=0 has_yarn=0 has_npm=0
    [[ -f "$dir/bun.lockb" || -f "$dir/bun.lock" ]] && has_bun=1
    [[ -f "$dir/pnpm-lock.yaml" || -f "$dir/shrinkwrap.yaml" ]] && has_pnpm=1
    [[ -f "$dir/yarn.lock" || -f "$dir/.pnp.cjs" || -f "$dir/.pnp.js" ]] && has_yarn=1
    [[ -f "$dir/package-lock.json" || -f "$dir/npm-shrinkwrap.json" ]] && has_npm=1

    if (( has_npm == 1 && (has_bun == 1 || has_pnpm == 1 || has_yarn == 1) )); then
      echo ""
      return
    fi

    (( has_bun == 1 )) && { echo "bun"; return; }
    (( has_pnpm == 1 )) && { echo "pnpm"; return; }
    (( has_yarn == 1 )) && { echo "yarn"; return; }
    (( has_npm == 1 )) && { echo "npm"; return; }
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
  local pm target_dir
  target_dir="$(_swiz_package_dir "$@")"
  pm="$(_swiz_detect_pm "$target_dir")"
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

_swiz_is_agent_process() {
  # Non-interactive shell is almost certainly an agent
  [[ $- != *i* ]] && return 0
  # Force via env var
  [[ "${SWIZ_SHIM:-}" == "strict" ]] && return 0
  return 1
}

_swiz_is_agent_env() {
  # Known agent environment indicators (from AGENTS array in src/agents.ts)
  [[ -n "${CURSOR_TRACE_ID:-}" ]] && return 0
  [[ -n "${CLAUDE_CODE:-}" ]] && return 0
  local parent_cmd
  parent_cmd="$(command ps -p $PPID -o command= 2>/dev/null || true)"
  case "$parent_cmd" in
    *claude*|*cursor*|*gemini*|*codex*|*agy*|*antigravity*) return 0 ;;
  esac
  return 1
}

_swiz_get_setting() {
  local key="$1"
  local val=""
  local conf_file
  
  for conf_file in "$PWD/.swiz/config.json" "${HOME:-}/.swiz/settings.json"; do
    if [[ -f "$conf_file" ]]; then
      if command -v jq >/dev/null 2>&1; then
        val="$(command jq -r ".$key // empty" "$conf_file" 2>/dev/null)"
      else
        val="$(command grep -Eo "\"$key\"\s*:\s*[^,}]*" "$conf_file" 2>/dev/null | command sed 's/.*:[[:space:]]*//' | tr -d '\" ')"
      fi
      if [[ -n "$val" && "$val" != "null" ]]; then
        echo "$val"
        return 0
      fi
    fi
  done
  echo ""
}

# Core guard function. Returns 0 (true) if the command should be blocked.
_swiz_guard() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && return 1

  local cmd="$1" alt="$2" msg="$3"
  shift 3

  if _swiz_is_agent_process; then
    # shellcheck disable=SC2016
    printf 'swiz: Do not use `%s`. %s\n' "$cmd" "$msg" >&2
    return 0
  elif _swiz_is_agent_env; then
    # shellcheck disable=SC2016
    printf '\033[33mswiz: consider `%s` instead of `%s`\033[0m\n' "$alt" "$cmd" >&2
    return 1
  else
    return 1
  fi
}

# ── Navigation ────────────────────────────────────────────────────────────────

cd() {
  if [[ -n "${SWIZ_BYPASS:-}" ]]; then
    builtin cd "$@"
    return $?
  fi

  if _swiz_is_agent_env; then
    if _swiz_is_agent_process; then
      printf 'swiz: Do not use `cd`. Changing directory loses workspace context.\n' >&2
      printf 'Instead, use absolute paths, tool directory flags (like -C or --prefix), or workspace filters.\n' >&2
      return 1
    else
      printf 'swiz: Warning: `cd` loses workspace context for agents.\n' >&2
      builtin cd "$@"
      return $?
    fi
  else
    builtin cd "$@"
    return $?
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


cp() {
  _swiz_guard cp ditto \
    "Use \`ditto <source> <destination>\` instead (preserves metadata and handles directories cleanly)." "$@" && return 1
  command cp "$@"
}

perl() {
  _swiz_guard perl "Edit tool" \
    "Do not use perl to read or modify files. Instead, use the Read or Edit tools for robust file operations." "$@" && return 1
  command perl "$@"
}

sed() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && { command sed "$@"; return $?; }

  local arg
  for arg in "$@"; do
    [[ "$arg" == "--" ]] && break
    case "$arg" in
      -i|--in-place|--in-place=*|-i*|-[^-]*i*)
        _swiz_guard sed "Edit tool" \
          "In-place sed edits are blocked. Use the Edit/StrReplace tool for reviewable changes." "$@" && return 1
        ;;
    esac
  done
  command sed "$@"
}

awk() {
  _swiz_guard awk "Edit tool" \
    "Use the Edit/StrReplace tool for file processing. Awk is unreliable for edits." "$@" && return 1
  command awk "$@"
}

vim() {
  _swiz_guard vim "Edit tool" \
    "Terminal editors are non-interactive in agent subshells and will hang. Use the Edit/StrReplace tool instead." "$@" && return 1
  command vim "$@"
}

vi() {
  _swiz_guard vi "Edit tool" \
    "Terminal editors are non-interactive in agent subshells and will hang. Use the Edit/StrReplace tool instead." "$@" && return 1
  command vi "$@"
}

nano() {
  _swiz_guard nano "Edit tool" \
    "Terminal editors are non-interactive in agent subshells and will hang. Use the Edit/StrReplace tool instead." "$@" && return 1
  command nano "$@"
}

emacs() {
  _swiz_guard emacs "Edit tool" \
    "Terminal editors are non-interactive in agent subshells and will hang. Use the Edit/StrReplace tool instead." "$@" && return 1
  command emacs "$@"
}

# ── Package managers (project-aware) ─────────────────────────────────────────
# Detect the project's PM from lockfiles. If you're already using the right
# one, it passes through. If not, you're told what this project uses.

_swiz_pm_guard() {
  local invoked="$1"; shift

  # Explicitly global administration does not inspect or mutate this project's
  # dependency graph, so the cwd's package-manager policy does not apply.
  _swiz_is_global_pm_operation "$invoked" "$@" && return 1

  local pm target_dir
  target_dir="$(_swiz_package_dir "$@")"
  pm="$(_swiz_detect_pm "$target_dir")"

  # No lockfile found — can't enforce, allow
  [[ -z "$pm" ]] && return 1
  # Already using the project's PM — allow
  [[ "$invoked" == "$pm" ]] && return 1

  _swiz_guard "$invoked" "$pm" \
    "Project signals indicate \`$pm\` is the expected package manager. Use \`$pm\` instead." "$@"
}

npm() {
  _swiz_pm_guard npm "$@" && return 1
  command npm "$@"
}

npx() {
  local runner
  runner="$(_swiz_detect_runner "$@")"
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
    # Don't chain if it's already our wrapper
    if declare -f "$name" | command grep -q "_swiz_run_${name}"; then
      return 0
    fi
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

  # Identify the git subcommand after global options such as `-C <dir>`.
  # Iterate values directly: bash arrays are zero-based while zsh arrays are
  # one-based, so indirect positional indexing is not portable between them.
  local git_cmd=""
  local arg
  local skip_global_value=false
  local git_cmd_args=()
  for arg in "${args[@]}"; do
    if [[ -z "$git_cmd" ]]; then
      if $skip_global_value; then
        skip_global_value=false
        continue
      fi
      case "$arg" in
        -C|-c|--git-dir|--work-tree|--namespace|--config-env)
          skip_global_value=true
          ;;
        --git-dir=*|--work-tree=*|--namespace=*|--config-env=*|--exec-path=*|-*)
          ;;
        *)
          git_cmd="$arg"
          ;;
      esac
      continue
    fi
    git_cmd_args+=("$arg")
  done

  # Block --no-verify on commit and push
  if [[ "$git_cmd" == "commit" || "$git_cmd" == "push" ]]; then
    for arg in "${git_cmd_args[@]}"; do
      [[ "$arg" == "--" ]] && break
      if [[ "$arg" == "--no-verify" || "$arg" == --no-verify=* ]]; then
        printf 'swiz: git %s --no-verify is blocked.\n' "$git_cmd" >&2
        printf 'This flag bypasses pre-commit hooks and other safety mechanisms.\n' >&2
        printf 'Address the underlying issue flagged by the hooks instead.\n' >&2
        return 1
      fi
    done
  fi

  # Block unsafe force pushes while allowing lease-based safety flags.
  if [[ "$git_cmd" == "push" ]]; then
    local push_cooldown
    push_cooldown="$(_swiz_get_setting "pushCooldownMinutes")"
    if [[ -n "$push_cooldown" && "$push_cooldown" -gt 0 ]]; then
      if _swiz_is_agent_process || _swiz_is_agent_env; then
        printf 'swiz: git push is blocked by push-cooldown-minutes (%s mins).\n' "$push_cooldown" >&2
        printf 'Use `swiz push-wait origin <branch>` to safely manage push pacing.\n' >&2
        return 1
      fi
    fi

    local is_delete=false
    for arg in "${git_cmd_args[@]}"; do
      [[ "$arg" == "--" ]] && break
      if [[ "$arg" == "--force" || ( "$arg" == -[^-]* && "${arg#-}" == *f* ) ]]; then
        printf 'swiz: git push --force is blocked.\n' >&2
        printf 'Use --force-with-lease to avoid overwriting unseen remote work.\n' >&2
        return 1
      fi
      if [[ "$arg" == "--delete" || "$arg" == "-d" ]]; then
        is_delete=true
      fi
    done

    local default_branch
    default_branch="$(_swiz_get_setting "defaultBranch")"
    : "${default_branch:=main}"

    if $is_delete; then
      for target in "${git_cmd_args[@]}"; do
        if [[ "$target" == "main" || "$target" == "master" || "$target" == "$default_branch" ]]; then
          printf 'swiz: Deleting the primary remote branch (%s) is blocked.\n' "$target" >&2
          return 1
        fi
      done
    fi

    local strict_mode
    strict_mode="$(_swiz_get_setting "strictNoDirectMain")"
    if [[ "$strict_mode" == "true" && "$is_delete" != "true" ]]; then
      local current_branch
      current_branch="$(command git branch --show-current 2>/dev/null)"
      local pushed_to_default=false
      local has_refspec=false
      
      for arg in "${git_cmd_args[@]}"; do
        [[ "$arg" == -* ]] && continue
        if [[ "$arg" == "$default_branch" || "$arg" == *:$default_branch ]]; then
          pushed_to_default=true
          has_refspec=true
        elif [[ "$arg" != "origin" && "$arg" != "upstream" ]]; then
          has_refspec=true
        fi
      done
      
      if ! $has_refspec; then
         if [[ "$current_branch" == "$default_branch" ]]; then
           pushed_to_default=true
         fi
      fi

      if $pushed_to_default; then
        printf 'swiz: Direct pushes to the default branch (%s) are blocked by settings.\n' "$default_branch" >&2
        printf 'strict-no-direct-main is enabled. Use feature branches and PRs instead.\n' >&2
        return 1
      fi
    fi
  fi

  # Block deleting primary local branches
  if [[ "$git_cmd" == "branch" ]]; then
    for arg in "${git_cmd_args[@]}"; do
      if [[ "$arg" == "-d" || "$arg" == "-D" || "$arg" == "--delete" ]]; then
        for target in "${git_cmd_args[@]}"; do
          if [[ "$target" == "main" || "$target" == "master" ]]; then
            printf 'swiz: Deleting the primary branch (%s) is blocked.\n' "$target" >&2
            return 1
          fi
        done
      fi
    done
  fi

  # Block dangerous git subcommands
  case "$git_cmd" in
    stash)
      local stash_action=""
      for arg in "${git_cmd_args[@]}"; do
        stash_action="$arg"
        break
      done
      case "$stash_action" in
        list|show)
          # Read-only inspection — allow
          ;;
        *)
          printf 'swiz: Do not use raw `git stash` mutations. They can rewrite the shared checkout or mutate hidden Git recovery state, including deleting a recovery entry.\n' >&2
          printf 'Commit work-in-progress instead: git commit -m "wip: ..."\n' >&2
          printf 'For a classified disposable stash, use: swiz stash retire <full-oid>\n' >&2
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

  # Block adding large files if configured
  if [[ "$git_cmd" == "add" ]]; then
    local block_kb
    block_kb="$(_swiz_get_setting "largeFileSizeBlockKb")"
    if [[ -n "$block_kb" && "$block_kb" -gt 0 ]]; then
      local block_bytes=$((block_kb * 1024))
      for arg in "${git_cmd_args[@]}"; do
        [[ "$arg" == -* ]] && continue
        if [[ -e "$arg" ]]; then
          local oversized
          oversized="$(command find "$arg" -type f -size +${block_bytes}c -print -quit 2>/dev/null)"
          if [[ -n "$oversized" ]]; then
             printf 'swiz: git add is blocked. File exceeds large-file-size-block-kb (%s KB).\n' "$block_kb" >&2
             printf 'File: %s\n' "$oversized" >&2
             return 1
          fi
        fi
      done
    fi
  fi

  # Block git reset --hard
  if [[ "$git_cmd" == "reset" ]]; then
    for arg in "${git_cmd_args[@]}"; do
      if [[ "$arg" == "--hard" || "$arg" == --hard=* ]]; then
        printf 'swiz: Do not use `git reset --hard`. It destroys uncommitted changes.\n' >&2
        printf 'Use `git revert <hash>` or `git reset HEAD~1` (soft, keeps changes staged).\n' >&2
        return 1
      fi
    done
  fi

  # Block git checkout -- <file> (discards changes)
  if [[ "$git_cmd" == "checkout" ]]; then
    for arg in "${git_cmd_args[@]}"; do
      if [[ "$arg" == "--" ]]; then
        printf 'swiz: Do not use `git checkout -- <file>`. It discards file changes.\n' >&2
        printf 'Use the Edit tool to undo specific changes, or `git revert <hash>`.\n' >&2
        return 1
      fi
    done
  fi

  # Block committing staged files containing absolute home directory path
  if [[ "$git_cmd" == "commit" ]]; then
    local home_path="${HOME:-}"
    home_path="${home_path%/}"
    if [[ -n "$home_path" && "$home_path" != "/" ]]; then
      if command git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local staged_files
        staged_files="$(command git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)"
        if [[ -n "$staged_files" ]]; then
          local home_matches
          home_matches="$(command git diff --cached --name-only --diff-filter=ACMR -z 2>/dev/null | command xargs -0 command git grep --cached -F -l -z -e "$home_path" -- 2>/dev/null | tr '\0' '\n' | command grep -v '^$')"
          if [[ -n "$home_matches" ]]; then
            printf 'swiz: BLOCKED: staged file content contains your absolute home directory.\n\n' >&2
            printf 'Affected staged files:\n' >&2
            echo "$home_matches" | command sed 's/^/  - /' >&2
            printf '\nReplace the absolute path with `~`, `$HOME`, or a repository-relative path.\n' >&2
            printf 'Then re-stage every affected file with `git add` and retry the commit.\n' >&2
            return 1
          fi
        fi
      fi
    fi
  fi

  # Block co-authored and AI-signed commits
  if [[ "$git_cmd" == "commit" ]]; then
    local commit_msg=""
    local message_value=""
    set -- "${git_cmd_args[@]}"
    while [[ $# -gt 0 ]]; do
      arg="$1"
      shift
      [[ "$arg" == "--" ]] && break
      message_value=""
      case "$arg" in
        -m|--message)
          if [[ $# -gt 0 ]]; then
            message_value="$1"
            shift
          fi
          ;;
        --message=*)
          message_value="${arg#--message=}"
          ;;
        -[^-]*m*)
          message_value="${arg#*m}"
          if [[ -z "$message_value" && $# -gt 0 ]]; then
            message_value="$1"
            shift
          fi
          ;;
        -F|--file|-C|--reuse-message|-c|--reedit-message)
          if [[ $# -gt 0 ]]; then
            local val="$1"
            shift
            if [[ -f "$val" ]] && [[ "$arg" == "-F" || "$arg" == "--file" ]]; then
              message_value="$(command cat "$val" 2>/dev/null)"
            else
              message_value="[EXTERNAL_MSG_SOURCE]"
            fi
          fi
          ;;
      esac
      if [[ -n "$message_value" ]]; then
        commit_msg="${commit_msg}${commit_msg:+$'\n\n'}${message_value}"
      fi
    done

    if [[ -n "$commit_msg" ]]; then
      if printf '%s' "$commit_msg" | command grep -qi "Co-authored-by:"; then
        printf 'swiz: Co-authored commits are blocked.\n' >&2
        printf 'Create commits without co-author attribution.\n' >&2
        return 1
      fi
      if printf '%s' "$commit_msg" | command grep -qisE "generated.*with.*claude.*code"; then
        printf 'swiz: AI-generation signatures in commit messages are blocked.\n' >&2
        printf 'Write your own commit messages.\n' >&2
        return 1
      fi
    else
      printf 'swiz: Warning: Co-authored commits are not allowed. Please ensure your commit message doesn'\''t contain '\''Co-authored-by:'\'' lines.\n' >&2
    fi
  fi

  # Delegate to chained wrapper or raw git
  _swiz_run_git "${args[@]}"
}

# ── GitHub CLI security ──────────────────────────────────────────────────────

gh() {
  [[ -n "${SWIZ_BYPASS:-}" ]] && { command gh "$@"; return $?; }

  local gh_cmd="$1"
  local gh_subcmd="$2"
  
  if [[ "$gh_cmd" == "issue" && "$gh_subcmd" == "close" ]]; then
    local issue_close_gate
    issue_close_gate="$(_swiz_get_setting "issueCloseGate")"
    if [[ "$issue_close_gate" == "true" ]]; then
      echo "swiz: gh issue close is blocked by issue-close-gate setting." >&2
      echo "Use \`swiz issue close <number>\` instead, which handles required confirmations." >&2
      return 1
    fi
  fi

  case "$*" in
    *--admin*)
      echo "Error: gh --admin is blocked for security reasons" >&2
      echo "This flag bypasses repository protection rules and required checks" >&2
      echo "Please ensure PRs pass all required checks and obtain proper approvals" >&2
      return 1
      ;;
    *--skip-status-check*)
      local ignore_ci
      ignore_ci="$(_swiz_get_setting "ignoreCi")"
      if [[ "$ignore_ci" != "true" ]]; then
        echo "Error: gh --skip-status-check is blocked for security reasons" >&2
        echo "This flag bypasses required CI/CD status checks" >&2
        echo "Please wait for all required checks to pass before merging" >&2
        return 1
      fi
      ;;
  esac

  _swiz_run_gh "$@"
}

# ── Daemon health ────────────────────────────────────────────────────────────
# If the daemon's launch agent plist is missing, try to heal it in the background.
if [[ ! -f "$HOME/Library/LaunchAgents/com.swiz.daemon.plist" ]]; then
  if command -v swiz >/dev/null 2>&1; then
    (command swiz daemon --install >/dev/null 2>&1 &)
  fi
fi
