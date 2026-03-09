import { CONFIGURABLE_AGENTS } from "./agents.ts"
import { createHelpCommand } from "./commands/help.ts"
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
    options.flatMap((o) => o.flags.split(/[\s,]+/).filter((t) => t.startsWith("-")))
  )
  const knownFlags = new Set([...GLOBAL_FLAGS, ...commandFlags])
  const warnings: string[] = []
  for (const arg of rest) {
    if (!arg.startsWith("-") || knownFlags.has(arg)) continue
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
  const { DISPATCH_ROUTES } = await import("./commands/dispatch.ts")
  validateDispatchRoutes(DISPATCH_ROUTES, CONFIGURABLE_AGENTS)

  const [commandName, ...rest] = process.argv.slice(2)

  if (!commandName || commandName === "--help" || commandName === "-h") {
    help.run([])
    return
  }

  const command = commands.get(commandName)

  if (!command) {
    const hint = suggest(commandName, commands.keys())
    console.error(`Unknown command: ${commandName}${hint ? ` (did you mean: "${hint}"?)` : ""}`)
    console.error(`Run "swiz help" to see available commands.`)
    process.exitCode = 1
    return
  }

  if (rest[0] === "--help" || rest[0] === "-h") {
    help.run([commandName])
    return
  }

  // Fuzzy flag suggestions — warn on unknown flags before delegating to command
  const unknownOptionWarnings = collectUnknownOptionWarnings(
    commandName,
    rest,
    command.options ?? []
  )
  if (unknownOptionWarnings.length > 0) {
    for (const warning of unknownOptionWarnings) console.error(warning)
    process.exitCode = 1
    return
  }

  // Best-effort: drain any offline issue mutations before running commands
  await tryReplayPendingMutations()

  try {
    await command.run(rest)
  } catch (err) {
    console.error(String(err))
    process.exitCode = 1
  }
}

export { commands, run }
