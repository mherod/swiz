import { CONFIGURABLE_AGENTS } from "./agents.ts"
import { createHelpCommand } from "./commands/help.ts"
import { stderrLog } from "./debug.ts"
import { suggest } from "./fuzzy.ts"
import { tryReplayPendingMutations } from "./issue-store.ts"
import { validateDispatchRoutes } from "./manifest.ts"
import type { Command } from "./types.ts"

const commands = new Map<string, Command>()

export function registerCommand(command: Command) {
  commands.set(command.name, command)
}

export function collectUnknownOptionWarnings(
  commandName: string,
  rest: string[],
  options: Command["options"] = []
): string[] {
  const GLOBAL_FLAGS = new Set(["--help", "-h"])
  const commandFlags = new Set(
    options.flatMap((o) =>
      o.flags
        .split(/[\s,]+/)
        .map((t) => t.replace(/^[^-]+/, ""))
        .filter((t) => t.startsWith("-"))
    )
  )
  const knownFlags = new Set([...GLOBAL_FLAGS, ...commandFlags])
  const warnings: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith("-") || knownFlags.has(arg)) continue
    // Skip if the preceding token was a known flag — this arg is its value, not a flag itself
    if (i > 0 && knownFlags.has(rest[i - 1]!)) continue
    const hint = suggest(arg, knownFlags)
    warnings.push(
      `Unknown option: ${arg}${hint ? ` (did you mean: "${hint}"?)` : ""} — run: swiz help ${commandName}`
    )
  }
  return warnings
}

async function run() {
  const help = createHelpCommand(commands)
  commands.set("help", help)

  // Validate manifest/route/agent symmetry before any command runs
  const { DISPATCH_ROUTES } = await import("./dispatch/index.ts")
  validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)

  const [commandName, ...rest] = process.argv.slice(2)

  if (!commandName || commandName === "--help" || commandName === "-h") {
    if (rest.includes("--json")) {
      const cmds = [...commands.entries()]
        .filter(([name]) => name !== "help")
        .map(([name, cmd]) => ({ name, description: cmd.description }))
      console.log(JSON.stringify(cmds, null, 2))
      return
    }
    void help.run([])
    return
  }

  const command = commands.get(commandName)

  if (!command) {
    const hint = suggest(commandName, commands.keys())
    stderrLog(
      "CLI error handler — unknown command",
      `Unknown command: ${commandName}${hint ? ` (did you mean: "${hint}"?)` : ""}`
    )
    stderrLog("CLI error handler — unknown command", `Run "swiz help" to see available commands.`)
    process.exitCode = 1
    return
  }

  if (rest[0] === "--help" || rest[0] === "-h") {
    void help.run([commandName])
    return
  }

  // Fuzzy flag suggestions — warn on unknown flags before delegating to command
  const unknownOptionWarnings = collectUnknownOptionWarnings(
    commandName,
    rest,
    command.options ?? []
  )
  if (unknownOptionWarnings.length > 0) {
    for (const warning of unknownOptionWarnings)
      stderrLog("CLI error handler — unknown option warnings", warning)
    process.exitCode = 1
    return
  }

  // Best-effort: drain any offline issue mutations before running commands
  await tryReplayPendingMutations()

  try {
    await command.run(rest)
  } catch (err) {
    stderrLog("CLI error handler — uncaught exception", String(err))
    process.exitCode = 1
  }
}

export { commands, run }
