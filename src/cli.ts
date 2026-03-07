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
