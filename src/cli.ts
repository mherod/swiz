import { CONFIGURABLE_AGENTS } from "./agents.ts"
import { createHelpCommand } from "./commands/help.ts"
import { stderrLog } from "./debug.ts"
import { suggest } from "./fuzzy.ts"
import { tryReplayPendingMutations } from "./issue-store.ts"
import { validateDispatchRoutes } from "./manifest.ts"
import type { Command } from "./types.ts"

const commands = new Map<string, Command>()

export function registerCommand(command: Command): void {
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

function resolveCommand(
  commandName: string | undefined,
  help: Command
): { command: Command; name: string; rest: string[] } | null {
  const rest = process.argv.slice(3)
  if (!commandName || commandName === "--help" || commandName === "-h") {
    void help.run(rest)
    return null
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
    return null
  }

  if (rest[0] === "--help" || rest[0] === "-h") {
    void help.run([commandName])
    return null
  }

  return { command, name: commandName, rest }
}

async function run(): Promise<void> {
  const help = createHelpCommand(commands)
  commands.set("help", help)

  const { DISPATCH_ROUTES } = await import("./dispatch/index.ts")
  validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)

  const [commandName] = process.argv.slice(2)
  const resolved = resolveCommand(commandName, help)
  if (!resolved) return

  const warnings = collectUnknownOptionWarnings(
    resolved.name,
    resolved.rest,
    resolved.command.options ?? []
  )
  if (warnings.length > 0) {
    for (const w of warnings) stderrLog("CLI error handler — unknown option warnings", w)
    process.exitCode = 1
    return
  }

  await tryReplayPendingMutations()

  try {
    await resolved.command.run(resolved.rest)
  } catch (err) {
    stderrLog("CLI error handler — uncaught exception", String(err))
    process.exitCode = 1
  }
}

export { commands, run }
