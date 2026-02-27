import type { Command } from "../types.ts"

export function createHelpCommand(commands: Map<string, Command>): Command {
  return {
    name: "help",
    description: "Show available commands",
    usage: "swiz help [command]",
    run(args) {
      const target = args[0]

      if (target) {
        const cmd = commands.get(target)
        if (!cmd) {
          throw new Error(`Unknown command: ${target}`)
        }
        console.log(`\n  ${cmd.name} - ${cmd.description}`)
        if (cmd.usage) console.log(`\n  Usage: ${cmd.usage}`)
        if (cmd.options && cmd.options.length > 0) {
          console.log("\n  Options:\n")
          const maxFlags = Math.max(...cmd.options.map((o) => o.flags.length))
          for (const opt of cmd.options) {
            console.log(`    ${opt.flags.padEnd(maxFlags + 2)} ${opt.description}`)
          }
        }
        console.log()
        return
      }

      console.log("\n  swiz - CLI toolkit\n")
      console.log("  Usage: swiz <command> [options]\n")
      console.log("  Commands:\n")
      for (const cmd of commands.values()) {
        console.log(`    ${cmd.name.padEnd(16)} ${cmd.description}`)
      }
      console.log()
    },
  }
}
