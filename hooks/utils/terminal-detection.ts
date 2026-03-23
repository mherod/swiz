// Terminal emulator and shell detection for hook scripts.
// Detects the active terminal app and shell from environment variables.

// ─── Terminal emulator detection ─────────────────────────────────────────────

export type TerminalApp =
  | "iterm2"
  | "apple-terminal"
  | "wezterm"
  | "kitty"
  | "alacritty"
  | "hyper"
  | "vscode"
  | "cursor"
  | "windsurf"
  | "ghostty"
  | "warp"
  | "tabby"
  | "rio"
  | "unknown"

export interface TerminalInfo {
  app: TerminalApp
  name: string
  version: string | null
}

/** Map TERM_PROGRAM values to our canonical TerminalApp ids. */
const TERM_PROGRAM_MAP: Record<string, { app: TerminalApp; name: string }> = {
  "iTerm.app": { app: "iterm2", name: "iTerm2" },
  Apple_Terminal: { app: "apple-terminal", name: "Terminal.app" },
  WezTerm: { app: "wezterm", name: "WezTerm" },
  Hyper: { app: "hyper", name: "Hyper" },
  vscode: { app: "vscode", name: "VS Code" },
  ghostty: { app: "ghostty", name: "Ghostty" },
  WarpTerminal: { app: "warp", name: "Warp" },
  Tabby: { app: "tabby", name: "Tabby" },
  rio: { app: "rio", name: "Rio" },
}

/**
 * Env vars that uniquely identify a terminal when TERM_PROGRAM is absent.
 * Checked in order; first match wins.
 */
const ENV_FALLBACKS: { envVar: string; app: TerminalApp; name: string }[] = [
  { envVar: "ITERM_SESSION_ID", app: "iterm2", name: "iTerm2" },
  { envVar: "KITTY_WINDOW_ID", app: "kitty", name: "Kitty" },
  { envVar: "ALACRITTY_LOG", app: "alacritty", name: "Alacritty" },
  { envVar: "ALACRITTY_SOCKET", app: "alacritty", name: "Alacritty" },
  { envVar: "WEZTERM_EXECUTABLE", app: "wezterm", name: "WezTerm" },
  { envVar: "GHOSTTY_RESOURCES_DIR", app: "ghostty", name: "Ghostty" },
  { envVar: "WARP_IS_LOCAL_SHELL_SESSION", app: "warp", name: "Warp" },
  // Editor-embedded terminals set their own identifiers
  { envVar: "CURSOR_TRACE_ID", app: "cursor", name: "Cursor" },
  { envVar: "VSCODE_PID", app: "vscode", name: "VS Code" },
  { envVar: "VSCODE_GIT_ASKPASS_NODE", app: "vscode", name: "VS Code" },
  // Windsurf (Codeium) sets its own bin path
  { envVar: "WINDSURF_BIN", app: "windsurf", name: "Windsurf" },
]

/**
 * Detect the terminal emulator hosting the current process.
 *
 * Detection order:
 * 1. TERM_PROGRAM (most terminals set this)
 * 2. Terminal-specific env vars (fallback for terminals that don't set TERM_PROGRAM)
 * 3. LC_TERMINAL (set by some terminals as a secondary identifier)
 * 4. "unknown" if nothing matches
 */
export function detectTerminal(
  env: Record<string, string | undefined> = process.env
): TerminalInfo {
  // 1. TERM_PROGRAM — most universal
  const termProgram = env.TERM_PROGRAM
  if (termProgram) {
    const match = TERM_PROGRAM_MAP[termProgram]
    if (match) {
      return { ...match, version: env.TERM_PROGRAM_VERSION ?? null }
    }
  }

  // 2. Terminal-specific env vars
  for (const { envVar, app, name } of ENV_FALLBACKS) {
    if (env[envVar]) {
      return { app, name, version: env.TERM_PROGRAM_VERSION ?? null }
    }
  }

  // 3. LC_TERMINAL — some terminals set this as secondary
  const lcTerminal = env.LC_TERMINAL
  if (lcTerminal) {
    const lower = lcTerminal.toLowerCase()
    if (lower.includes("iterm"))
      return { app: "iterm2", name: "iTerm2", version: env.LC_TERMINAL_VERSION ?? null }
    if (lower.includes("wezterm")) return { app: "wezterm", name: "WezTerm", version: null }
  }

  return { app: "unknown", name: "Unknown", version: null }
}

// ─── Shell detection ─────────────────────────────────────────────────────────

export type ShellType = "zsh" | "bash" | "fish" | "nushell" | "pwsh" | "dash" | "sh" | "unknown"

export interface ShellInfo {
  shell: ShellType
  name: string
  path: string | null
}

const SHELL_MAP: Record<string, { shell: ShellType; name: string }> = {
  zsh: { shell: "zsh", name: "Zsh" },
  bash: { shell: "bash", name: "Bash" },
  fish: { shell: "fish", name: "Fish" },
  nu: { shell: "nushell", name: "Nushell" },
  nushell: { shell: "nushell", name: "Nushell" },
  pwsh: { shell: "pwsh", name: "PowerShell" },
  "powershell.exe": { shell: "pwsh", name: "PowerShell" },
  dash: { shell: "dash", name: "Dash" },
  sh: { shell: "sh", name: "sh" },
}

/**
 * Detect the user's shell.
 *
 * Detection order:
 * 1. SHELL env var (login shell — most reliable)
 * 2. "unknown" if not set
 */
export function detectShell(env: Record<string, string | undefined> = process.env): ShellInfo {
  const shellPath = env.SHELL
  if (shellPath) {
    const basename = shellPath.split("/").pop() ?? ""
    const match = SHELL_MAP[basename]
    if (match) {
      return { ...match, path: shellPath }
    }
    // Unknown shell binary — return the basename as the name
    return { shell: "unknown", name: basename || "Unknown", path: shellPath }
  }

  return { shell: "unknown", name: "Unknown", path: null }
}

// ─── Combined detection ──────────────────────────────────────────────────────

export interface EnvironmentInfo {
  terminal: TerminalInfo
  shell: ShellInfo
}

/**
 * Detect both terminal emulator and shell in one call.
 */
export function detectEnvironment(
  env: Record<string, string | undefined> = process.env
): EnvironmentInfo {
  return {
    terminal: detectTerminal(env),
    shell: detectShell(env),
  }
}
