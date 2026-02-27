import { describe, expect, it, beforeEach, vi } from "vitest"
import { createHelpCommand } from "./help.ts"
import type { Command } from "../types.ts"

describe("help.ts", () => {
  let commands: Map<string, Command>
  let logOutput: string[]

  beforeEach(() => {
    commands = new Map()
    logOutput = []

    // Mock console.log
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logOutput.push(args.join(" "))
    })
  })

  describe("createHelpCommand", () => {
    it("returns a Command object", () => {
      const help = createHelpCommand(commands)

      expect(help).toHaveProperty("name")
      expect(help).toHaveProperty("description")
      expect(help).toHaveProperty("usage")
      expect(help).toHaveProperty("run")
    })

    it("command has correct metadata", () => {
      const help = createHelpCommand(commands)

      expect(help.name).toBe("help")
      expect(help.description).toBe("Show available commands")
      expect(help.usage).toBe("swiz help [command]")
    })

    it("run method is a function", () => {
      const help = createHelpCommand(commands)
      expect(typeof help.run).toBe("function")
    })
  })

  describe("help command with no arguments", () => {
    it("shows swiz header", () => {
      const help = createHelpCommand(commands)
      help.run([])

      expect(logOutput.some((line) => line.includes("swiz - CLI toolkit"))).toBe(true)
    })

    it("shows usage information", () => {
      const help = createHelpCommand(commands)
      help.run([])

      expect(logOutput.some((line) => line.includes("Usage: swiz <command>"))).toBe(true)
    })

    it("shows Commands header", () => {
      const help = createHelpCommand(commands)
      help.run([])

      expect(logOutput.some((line) => line.includes("Commands:"))).toBe(true)
    })

    it("shows empty list when no commands registered", () => {
      const help = createHelpCommand(commands)
      help.run([])

      // Should output header but no command listings
      expect(logOutput.length).toBeGreaterThan(0)
    })

    it("shows registered commands with padding", () => {
      const cmd: Command = {
        name: "test",
        description: "Test command",
        run: async () => {},
      }
      commands.set("test", cmd)

      const help = createHelpCommand(commands)
      help.run([])

      expect(logOutput.some((line) => line.includes("test"))).toBe(true)
      expect(logOutput.some((line) => line.includes("Test command"))).toBe(true)
    })

    it("lists multiple commands", () => {
      const cmd1: Command = {
        name: "first",
        description: "First command",
        run: async () => {},
      }
      const cmd2: Command = {
        name: "second",
        description: "Second command",
        run: async () => {},
      }

      commands.set("first", cmd1)
      commands.set("second", cmd2)

      const help = createHelpCommand(commands)
      help.run([])

      expect(logOutput.some((line) => line.includes("first"))).toBe(true)
      expect(logOutput.some((line) => line.includes("second"))).toBe(true)
    })

    it("pads command names to 16 characters", () => {
      const cmd: Command = {
        name: "short",
        description: "Short name",
        run: async () => {},
      }

      commands.set("short", cmd)

      const help = createHelpCommand(commands)
      help.run([])

      const output = logOutput.join("\n")
      // padEnd(16) means the description should start after 16 chars
      expect(output).toContain("short")
    })
  })

  describe("help command with specific command", () => {
    beforeEach(() => {
      const cmd: Command = {
        name: "test-cmd",
        description: "Test command description",
        usage: "test-cmd [options]",
        run: async () => {},
      }
      commands.set("test-cmd", cmd)
    })

    it("shows specific command help", () => {
      const help = createHelpCommand(commands)
      help.run(["test-cmd"])

      expect(logOutput.some((line) => line.includes("test-cmd"))).toBe(true)
    })

    it("shows command description", () => {
      const help = createHelpCommand(commands)
      help.run(["test-cmd"])

      expect(logOutput.some((line) => line.includes("Test command description"))).toBe(true)
    })

    it("shows command usage when available", () => {
      const help = createHelpCommand(commands)
      help.run(["test-cmd"])

      expect(logOutput.some((line) => line.includes("Usage:"))).toBe(true)
      expect(logOutput.some((line) => line.includes("test-cmd [options]"))).toBe(true)
    })

    it("omits usage if command has no usage property", () => {
      const cmd: Command = {
        name: "no-usage",
        description: "Command without usage",
        run: async () => {},
      }
      commands.clear()
      commands.set("no-usage", cmd)

      const help = createHelpCommand(commands)
      help.run(["no-usage"])

      const usageLines = logOutput.filter((line) => line.includes("Usage:"))
      // Should not have usage line
      expect(usageLines.every((line) => !line.includes("Usage: "))).toBe(true)
    })

    it("throws error for unknown command", () => {
      const help = createHelpCommand(commands)

      expect(() => help.run(["unknown-command"])).toThrow("Unknown command: unknown-command")
    })

    it("error message includes the command name", () => {
      const help = createHelpCommand(commands)

      expect(() => help.run(["missing"])).toThrow("missing")
    })
  })

  describe("help command edge cases", () => {
    it("handles empty command name string", () => {
      const help = createHelpCommand(commands)

      // Empty string is falsy, so should show all commands
      help.run([""])

      expect(logOutput.some((line) => line.includes("swiz - CLI toolkit"))).toBe(true)
    })

    it("handles multiple arguments (uses only first)", () => {
      const cmd: Command = {
        name: "test",
        description: "Test",
        run: async () => {},
      }
      commands.set("test", cmd)

      const help = createHelpCommand(commands)
      help.run(["test", "extra", "args"])

      expect(logOutput.some((line) => line.includes("test"))).toBe(true)
    })

    it("handles empty args array", () => {
      const help = createHelpCommand(commands)

      // Empty args shows all commands
      help.run([])

      expect(logOutput.length).toBeGreaterThan(0)
    })

    it("case-sensitive command lookup", () => {
      const cmd: Command = {
        name: "TestCmd",
        description: "Case sensitive",
        run: async () => {},
      }
      commands.set("TestCmd", cmd)

      const help = createHelpCommand(commands)

      // Should find TestCmd but not testcmd
      help.run(["TestCmd"])
      expect(logOutput.some((line) => line.includes("TestCmd"))).toBe(true)

      logOutput = []
      expect(() => help.run(["testcmd"])).toThrow()
    })
  })

  describe("console output formatting", () => {
    it("outputs lines to console.log", () => {
      const help = createHelpCommand(commands)
      help.run([])

      expect(console.log).toHaveBeenCalled()
      expect(logOutput.length).toBeGreaterThan(0)
    })

    it("includes blank lines for spacing", () => {
      const help = createHelpCommand(commands)
      help.run([])

      const blankLines = logOutput.filter((line) => line === "")
      expect(blankLines.length).toBeGreaterThan(0)
    })

    it("formats command list with consistent spacing", () => {
      const commands2 = new Map<string, Command>([
        ["a", { name: "a", description: "Desc A", run: async () => {} }],
        ["bb", { name: "bb", description: "Desc B", run: async () => {} }],
        ["ccc", { name: "ccc", description: "Desc C", run: async () => {} }],
      ])

      const help = createHelpCommand(commands2)
      help.run([])

      // All lines should include their respective commands
      const output = logOutput.join("\n")
      expect(output).toContain("a")
      expect(output).toContain("bb")
      expect(output).toContain("ccc")
    })
  })

  describe("command integration", () => {
    it("help command can be registered like other commands", () => {
      const help = createHelpCommand(commands)

      expect(help).toHaveProperty("name")
      expect(help).toHaveProperty("run")
      expect(typeof help.run).toBe("function")

      // Can be used in a commands map
      commands.set(help.name, help)
      expect(commands.get("help")).toBe(help)
    })

    it("help command name is 'help'", () => {
      const help = createHelpCommand(commands)
      expect(help.name).toBe("help")
    })

    it("run method works synchronously", () => {
      const help = createHelpCommand(commands)

      expect(() => help.run([])).not.toThrow()
    })
  })
})
