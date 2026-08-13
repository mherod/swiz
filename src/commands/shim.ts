import { dirname, join } from "node:path"
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../ansi.ts"
import { getHomeDir } from "../home.ts"
import type { Command } from "../types.ts"

const MARKER_START = "# >>> swiz shim >>>"
const MARKER_END = "# <<< swiz shim <<<"

export interface ShellProfile {
  name: string
  path: string
  description: string
  required: boolean
}

export interface ShimInstallationOptions {
  home?: string
  shell?: string
  shimPath?: string
  profileNames?: string[]
  dryRun?: boolean
}

export interface ShimChangeResult {
  changedProfiles: string[]
  backupPaths: string[]
}

export interface ShimProfileStatus extends ShellProfile {
  exists: boolean
  installed: boolean
  current: boolean
}

export interface ShimInstallationStatus {
  healthy: boolean
  profiles: ShimProfileStatus[]
  missingProfiles: string[]
  outdatedProfiles: string[]
}

export function getShimPath(): string {
  return join(dirname(Bun.main), "hooks", "shim.sh")
}

function allProfiles(home: string): ShellProfile[] {
  return [
    {
      name: ".zshenv",
      path: join(home, ".zshenv"),
      description: "all zsh invocations (interactive + non-interactive)",
      required: true,
    },
    {
      name: ".zshrc",
      path: join(home, ".zshrc"),
      description: "interactive zsh only",
      required: false,
    },
    {
      name: ".bashrc",
      path: join(home, ".bashrc"),
      description: "interactive bash and inherited non-interactive shells",
      required: true,
    },
    {
      name: ".bash_profile",
      path: join(home, ".bash_profile"),
      description: "login bash and inherited non-interactive shells",
      required: true,
    },
  ]
}

export function detectProfiles(
  home = getHomeDir(),
  shell = process.env.SHELL ?? ""
): ShellProfile[] {
  const profiles = allProfiles(home)
  if (shell.endsWith("zsh")) return profiles.filter((profile) => profile.name.startsWith(".zsh"))
  return profiles.filter((profile) => profile.name.startsWith(".bash"))
}

function resolveOptions(options: ShimInstallationOptions = {}): {
  home: string
  shell: string
  shimPath: string
} {
  return {
    home: options.home ?? getHomeDir(),
    shell: options.shell ?? process.env.SHELL ?? "",
    shimPath: options.shimPath ?? getShimPath(),
  }
}

function shellDoubleQuote(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&")
}

function shimBlock(profile: ShellProfile, shimPath: string): string {
  const quotedPath = shellDoubleQuote(shimPath)
  const lines = [MARKER_START]
  if (profile.name.startsWith(".bash")) {
    lines.push(`export BASH_ENV="${quotedPath}"`)
    lines.push('[ -f "$BASH_ENV" ] && source "$BASH_ENV"')
  } else {
    lines.push(`[ -f "${quotedPath}" ] && source "${quotedPath}"`)
  }
  lines.push(MARKER_END)
  return lines.join("\n")
}

async function readProfile(path: string): Promise<{ exists: boolean; content: string }> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { exists: false, content: "" }
  return { exists: true, content: await file.text() }
}

function hasShimBlock(content: string): boolean {
  return content.includes(MARKER_START)
}

function removeShimBlock(content: string): string {
  const lines = content.split("\n")
  const result: string[] = []
  let inside = false

  for (const line of lines) {
    if (line.includes(MARKER_START)) {
      inside = true
      continue
    }
    if (line.includes(MARKER_END)) {
      inside = false
      continue
    }
    if (!inside) result.push(line)
  }

  const cleaned = result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
  return cleaned ? `${cleaned}\n` : ""
}

function withShimBlock(content: string, block: string): string {
  const cleaned = removeShimBlock(content).trimEnd()
  return `${cleaned}${cleaned ? "\n\n" : ""}${block}\n`
}

async function writeProfileWithBackup(
  profile: ShellProfile,
  previous: { exists: boolean; content: string },
  nextContent: string
): Promise<string | null> {
  let backupPath: string | null = null
  if (previous.exists) {
    backupPath = `${profile.path}.bak`
    await Bun.write(backupPath, previous.content)
  }
  await Bun.write(profile.path, nextContent)
  return backupPath
}

function selectProfiles(
  options: ShimInstallationOptions,
  includeOptional: boolean
): ShellProfile[] {
  const resolved = resolveOptions(options)
  const available = detectProfiles(resolved.home, resolved.shell)
  if (options.profileNames && options.profileNames.length > 0) {
    const selected = options.profileNames.map((name) =>
      available.find((profile) => profile.name === name)
    )
    const missingIndex = selected.indexOf(undefined)
    if (missingIndex >= 0) {
      throw new Error(
        `Unknown profile: ${options.profileNames[missingIndex]}\nAvailable: ${available
          .map((profile) => profile.name)
          .join(", ")}`
      )
    }
    return selected as ShellProfile[]
  }
  return includeOptional ? available : available.filter((profile) => profile.required)
}

export async function inspectShimInstallation(
  options: ShimInstallationOptions = {}
): Promise<ShimInstallationStatus> {
  const { shimPath } = resolveOptions(options)
  const profiles = selectProfiles(options, true)
  const statuses = await Promise.all(
    profiles.map(async (profile): Promise<ShimProfileStatus> => {
      const { exists, content } = await readProfile(profile.path)
      const installed = hasShimBlock(content)
      return {
        ...profile,
        exists,
        installed,
        current: installed && content.includes(shimBlock(profile, shimPath)),
      }
    })
  )
  const required = statuses.filter((profile) => profile.required)
  return {
    healthy: required.length > 0 && required.every((profile) => profile.current),
    profiles: statuses,
    missingProfiles: required
      .filter((profile) => !profile.installed)
      .map((profile) => profile.path),
    outdatedProfiles: required
      .filter((profile) => profile.installed && !profile.current)
      .map((profile) => profile.path),
  }
}

export async function ensureShimInstallation(
  options: ShimInstallationOptions = {}
): Promise<ShimChangeResult> {
  const { shimPath } = resolveOptions(options)
  const profiles = selectProfiles(options, false)
  const changedProfiles: string[] = []
  const backupPaths: string[] = []

  for (const profile of profiles) {
    const previous = await readProfile(profile.path)
    const nextContent = withShimBlock(previous.content, shimBlock(profile, shimPath))
    if (previous.exists && previous.content === nextContent) continue
    const backupPath = options.dryRun
      ? null
      : await writeProfileWithBackup(profile, previous, nextContent)
    changedProfiles.push(profile.path)
    if (backupPath) backupPaths.push(backupPath)
  }

  return { changedProfiles, backupPaths }
}

export async function uninstallShimInstallation(
  options: Pick<ShimInstallationOptions, "home" | "dryRun"> = {}
): Promise<ShimChangeResult> {
  const home = options.home ?? getHomeDir()
  const changedProfiles: string[] = []
  const backupPaths: string[] = []

  for (const profile of allProfiles(home)) {
    const previous = await readProfile(profile.path)
    if (!previous.exists || !hasShimBlock(previous.content)) continue
    const backupPath = options.dryRun
      ? null
      : await writeProfileWithBackup(profile, previous, removeShimBlock(previous.content))
    changedProfiles.push(profile.path)
    if (backupPath) backupPaths.push(backupPath)
  }

  return { changedProfiles, backupPaths }
}

async function showStatus(): Promise<void> {
  const shell = process.env.SHELL ?? "unknown"
  const shimPath = getShimPath()
  const status = await inspectShimInstallation({ shell, shimPath })

  console.log(`\n  ${BOLD}swiz shim${RESET}\n`)
  console.log(`  Shell: ${shell}`)
  console.log(`  Shim:  ${shimPath}\n`)

  for (const profile of status.profiles) {
    if (!profile.exists) {
      console.log(`  ${DIM}${profile.name}: not found${RESET}`)
    } else if (profile.current) {
      console.log(
        `  ${GREEN}●${RESET} ${profile.name}: ${GREEN}installed${RESET} ${DIM}(${profile.description})${RESET}`
      )
    } else if (profile.installed) {
      console.log(`  ${YELLOW}●${RESET} ${profile.name}: ${YELLOW}outdated${RESET}`)
    } else {
      console.log(
        `  ${DIM}○${RESET} ${profile.name}: not installed ${DIM}(${profile.description})${RESET}`
      )
    }
  }

  if (!status.healthy) {
    console.log(`\n  ${DIM}Run \`swiz doctor --fix\` to repair the shim installation.${RESET}`)
  }

  console.log(
    `\n  ${DIM}The shim intercepts unsafe command forms while leaving read-only operations available.${RESET}`
  )
  console.log(`  ${DIM}In agent context (non-interactive shell): unsafe forms are blocked.${RESET}`)
  console.log(
    `  ${DIM}In human context (interactive shell):     warnings only, command proceeds.${RESET}`
  )
  console.log(`\n  ${DIM}Bypass: SWIZ_BYPASS=1 <command>, or: command <command>${RESET}\n`)
}

async function install(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run")
  const shell = process.env.SHELL ?? ""
  const profiles = detectProfiles(getHomeDir(), shell)
  const targetName = args.find((arg) => arg.startsWith("."))
  const selected = targetName
    ? profiles.filter((profile) => profile.name === targetName)
    : profiles.filter((profile) => profile.required)
  if (selected.length === 0) {
    throw new Error(
      targetName
        ? `Unknown profile: ${targetName}\nAvailable: ${profiles.map((profile) => profile.name).join(", ")}`
        : "Could not determine shell profile."
    )
  }

  console.log(`\n  ${BOLD}swiz shim install${dryRun ? " (dry run)" : ""}${RESET}\n`)
  for (const profile of selected) {
    console.log(`  Target: ${profile.path} ${DIM}(${profile.description})${RESET}`)
  }
  console.log()

  if (dryRun) {
    for (const profile of selected) {
      console.log(`  ${GREEN}+ Ensure shim block in ${profile.name}:${RESET}`)
      console.log(`  ${DIM}${shimBlock(profile, getShimPath())}${RESET}\n`)
    }
    console.log("  No changes written.\n")
    return
  }

  const result = await ensureShimInstallation({
    shell,
    shimPath: getShimPath(),
    profileNames: selected.map((profile) => profile.name),
  })
  if (result.changedProfiles.length === 0) {
    console.log(`  ${GREEN}✓ Shim installation is already current${RESET}\n`)
  } else {
    for (const path of result.changedProfiles) {
      console.log(`  ${GREEN}✓ Installed shim in ${path}${RESET}`)
    }
    for (const path of result.backupPaths) {
      console.log(`  ${DIM}Backup: ${path}${RESET}`)
    }
    console.log()
  }

  console.log(`  ${DIM}Restart your shell to apply changes.${RESET}\n`)
  console.log("  Shimmed commands: grep, egrep, fgrep, find, sed, awk,")
  console.log("                    npm, npx, yarn, pnpm, bun, node, ts-node,")
  console.log("                    python, python3, touch, rm, git, gh\n")
  console.log(`  ${DIM}Agent context → blocked. Interactive → warning only.${RESET}`)
  console.log(`  ${DIM}Bypass: SWIZ_BYPASS=1 <command>, or: command <command>${RESET}\n`)
}

async function uninstall(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run")
  console.log(`\n  ${BOLD}swiz shim uninstall${dryRun ? " (dry run)" : ""}${RESET}\n`)

  if (dryRun) {
    let found = 0
    for (const profile of allProfiles(getHomeDir())) {
      const { exists, content } = await readProfile(profile.path)
      if (!exists || !hasShimBlock(content)) continue
      console.log(`  ${RED}- Would remove shim from ${profile.name}${RESET}`)
      found++
    }
    if (found === 0) console.log(`  ${DIM}No shim blocks found in any profile.${RESET}`)
    console.log()
    return
  }

  const result = await uninstallShimInstallation()
  if (result.changedProfiles.length === 0) {
    console.log(`  ${DIM}No shim blocks found in any profile.${RESET}`)
  } else {
    for (const path of result.changedProfiles) {
      console.log(`  ${GREEN}✓ Removed shim from ${path}${RESET}`)
    }
    for (const path of result.backupPaths) {
      console.log(`  ${DIM}Backup: ${path}${RESET}`)
    }
    console.log(`\n  ${DIM}Restart your shell to apply changes.${RESET}`)
  }
  console.log()
}

export const shimCommand: Command = {
  name: "shim",
  description: "Install shell-level command interception for agents",
  usage: "swiz shim [install | uninstall | status] [--dry-run]",
  options: [
    { flags: "install [profile]", description: "Install or refresh the shell shim" },
    { flags: "uninstall", description: "Remove shim blocks from every supported profile" },
    { flags: "status", description: "Show shim installation health (default action)" },
    { flags: "--dry-run", description: "Preview changes without writing to disk" },
  ],
  async run(args) {
    const subcommand = args[0]
    const rest = args.slice(1)

    switch (subcommand) {
      case "install":
        return install(rest)
      case "uninstall":
        return uninstall(rest)
      case "status":
      case undefined:
        return showStatus()
      default:
        throw new Error(
          `Unknown subcommand: ${subcommand}\nUsage: swiz shim [install | uninstall | status] [--dry-run]`
        )
    }
  },
}
