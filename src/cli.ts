import { createHelpCommand } from "./commands/help.ts"
import type { Command } from "./types.ts"

const commands = new Map<string, Command>()

export function registerCommand(command: Command) {
  commands.set(command.name, command)
}

async function run() {
  const help = createHelpCommand(commands)
  commands.set("help", help)

  const [commandName, ...rest] = process.argv.slice(2)

  if (!commandName || commandName === "--help" || commandName === "-h") {
    help.run([])
    return
  }

  const command = commands.get(commandName)

  if (!command) {
    console.error(`Unknown command: ${commandName}`)
    console.error(`Run "swiz help" to see available commands.`)
    process.exitCode = 1
    return
  }

  try {
    await command.run(rest)
  } catch (err) {
    console.error(String(err))
    process.exitCode = 1
  }
}

export { commands, run }
