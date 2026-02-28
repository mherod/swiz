import { describe, expect, it } from "vitest"
import { commands, registerCommand } from "./cli.ts"
import type { Command } from "./types.ts"

describe("cli.ts", () => {
  describe("registerCommand", () => {
    it("registers a command in the map", () => {
      const testCommand: Command = {
        name: "test-cmd",
        description: "Test command",
        run: async () => {},
      }

      registerCommand(testCommand)

      expect(commands.has("test-cmd")).toBe(true)
      expect(commands.get("test-cmd")).toBe(testCommand)
    })

    it("allows overwriting existing commands", () => {
      const cmd1: Command = {
        name: "overwrite-test",
        description: "First version",
        run: async () => {},
      }
      const cmd2: Command = {
        name: "overwrite-test",
        description: "Second version",
        run: async () => {},
      }

      registerCommand(cmd1)
      registerCommand(cmd2)

      expect(commands.get("overwrite-test")).toBe(cmd2)
    })

    it("stores command with exact name provided", () => {
      const command: Command = {
        name: "my-command",
        description: "Test",
        run: async () => {},
      }

      registerCommand(command)

      expect(commands.get("my-command")).toBe(command)
      expect(commands.get("my-Command")).toBeUndefined()
    })
  })

  describe("commands map", () => {
    it("is exported as a Map", () => {
      expect(commands instanceof Map).toBe(true)
    })

    it("can retrieve registered commands", () => {
      const cmd: Command = {
        name: "retrieve-test",
        description: "Test",
        run: async () => {},
      }

      registerCommand(cmd)
      const retrieved = commands.get("retrieve-test")

      expect(retrieved).toBe(cmd)
      expect(retrieved?.name).toBe("retrieve-test")
      expect(retrieved?.description).toBe("Test")
    })

    it("returns undefined for unregistered commands", () => {
      expect(commands.get("nonexistent-command")).toBeUndefined()
    })

    it("can iterate over registered commands", () => {
      const cmd: Command = {
        name: "iterate-test",
        description: "Test",
        run: async () => {},
      }

      registerCommand(cmd)

      let found = false
      for (const [name, command] of commands) {
        if (name === "iterate-test") {
          found = true
          expect(command).toBe(cmd)
        }
      }
      expect(found).toBe(true)
    })
  })

  describe("command interface", () => {
    it("requires name property", () => {
      const cmd: Command = {
        name: "interface-test",
        description: "Test command",
        run: async () => {},
      }

      expect(cmd).toHaveProperty("name")
      expect(typeof cmd.name).toBe("string")
      expect(cmd.name.length).toBeGreaterThan(0)
    })

    it("requires description property", () => {
      const cmd: Command = {
        name: "test",
        description: "Description text",
        run: async () => {},
      }

      expect(cmd).toHaveProperty("description")
      expect(typeof cmd.description).toBe("string")
    })

    it("requires run method", () => {
      const cmd: Command = {
        name: "test",
        description: "Test",
        run: async () => {},
      }

      expect(cmd).toHaveProperty("run")
      expect(typeof cmd.run).toBe("function")
    })

    it("run method accepts args array", async () => {
      let receivedArgs: string[] | undefined
      const cmd: Command = {
        name: "arg-test",
        description: "Test",
        run: async (args: string[]) => {
          receivedArgs = args
        },
      }

      await cmd.run(["arg1", "arg2"])

      expect(receivedArgs).toEqual(["arg1", "arg2"])
    })

    it("run method is async", () => {
      const cmd: Command = {
        name: "async-test",
        description: "Test",
        run: async () => {},
      }

      const result = cmd.run([])
      expect(result instanceof Promise).toBe(true)
    })

    it("supports optional usage property", () => {
      const cmdWithUsage: Command = {
        name: "test1",
        description: "Test",
        usage: "test1 <arg>",
        run: async () => {},
      }

      const cmdWithoutUsage: Command = {
        name: "test2",
        description: "Test",
        run: async () => {},
      }

      expect(cmdWithUsage).toHaveProperty("usage")
      expect(cmdWithoutUsage).not.toHaveProperty("usage")
    })
  })

  describe("command registration patterns", () => {
    it("allows multiple commands to be registered", () => {
      const cmds: Command[] = [
        { name: "cmd1", description: "First", run: async () => {} },
        { name: "cmd2", description: "Second", run: async () => {} },
        { name: "cmd3", description: "Third", run: async () => {} },
      ]

      for (const cmd of cmds) registerCommand(cmd)

      expect(commands.get("cmd1")).toBeDefined()
      expect(commands.get("cmd2")).toBeDefined()
      expect(commands.get("cmd3")).toBeDefined()
    })

    it("tracks command names case-sensitively", () => {
      const cmd: Command = {
        name: "CaseSensitive",
        description: "Test",
        run: async () => {},
      }

      registerCommand(cmd)

      expect(commands.get("CaseSensitive")).toBe(cmd)
      expect(commands.get("casesensitive")).toBeUndefined()
      expect(commands.get("CASESENSITIVE")).toBeUndefined()
    })
  })

  describe("command lookup", () => {
    it("can find command by exact name", () => {
      const cmd: Command = {
        name: "find-me",
        description: "Test",
        run: async () => {},
      }

      registerCommand(cmd)
      const found = commands.get("find-me")

      expect(found).toBe(cmd)
    })

    it("preserves command metadata on lookup", () => {
      const cmd: Command = {
        name: "metadata-test",
        description: "Test description",
        usage: "metadata-test [options]",
        run: async () => {},
      }

      registerCommand(cmd)
      const found = commands.get("metadata-test")

      expect(found?.name).toBe("metadata-test")
      expect(found?.description).toBe("Test description")
      expect(found?.usage).toBe("metadata-test [options]")
    })
  })

  describe("command Map operations", () => {
    it("map.has returns false for unregistered commands", () => {
      expect(commands.has("nonexistent")).toBe(false)
    })

    it("map.set replaces existing commands", () => {
      const cmd1: Command = { name: "dup", description: "v1", run: async () => {} }
      const cmd2: Command = { name: "dup", description: "v2", run: async () => {} }

      commands.set(cmd1.name, cmd1)
      commands.set(cmd2.name, cmd2)

      expect(commands.get("dup")).toBe(cmd2)
    })

    it("map size increases with each registered command", () => {
      const initialSize = commands.size
      const cmd: Command = {
        name: `cmd-${Date.now()}`,
        description: "Size test",
        run: async () => {},
      }

      registerCommand(cmd)

      expect(commands.size).toBeGreaterThan(initialSize)
    })

    it("map entries can be iterated", () => {
      const cmd: Command = { name: "iterate-me", description: "Test", run: async () => {} }
      registerCommand(cmd)

      let found = false
      for (const [name, command] of commands) {
        if (name === "iterate-me") {
          found = true
          expect(command).toBe(cmd)
        }
      }

      expect(found).toBe(true)
    })

    it("map keys returns all command names", () => {
      const cmd1: Command = { name: "keys-1", description: "Test", run: async () => {} }
      const cmd2: Command = { name: "keys-2", description: "Test", run: async () => {} }

      registerCommand(cmd1)
      registerCommand(cmd2)

      const keys = Array.from(commands.keys())
      expect(keys).toContain("keys-1")
      expect(keys).toContain("keys-2")
    })

    it("map values returns all commands", () => {
      const cmd: Command = { name: "values-test", description: "Test", run: async () => {} }
      registerCommand(cmd)

      const values = Array.from(commands.values())
      expect(values).toContain(cmd)
    })
  })

  describe("command execution interface", () => {
    it("run method receives correct arguments array", async () => {
      const receivedArgs: string[][] = []

      const cmd: Command = {
        name: "args-test",
        description: "Test",
        run: async (args: string[]) => {
          receivedArgs.push(args)
        },
      }

      await cmd.run(["arg1", "arg2", "arg3"])

      expect(receivedArgs).toHaveLength(1)
      expect(receivedArgs[0]).toEqual(["arg1", "arg2", "arg3"])
    })

    it("run method can receive empty arguments", async () => {
      let called = false

      const cmd: Command = {
        name: "empty-args",
        description: "Test",
        run: async (args: string[]) => {
          called = true
          expect(args).toEqual([])
        },
      }

      await cmd.run([])

      expect(called).toBe(true)
    })

    it("run method can be synchronous", () => {
      const cmd: Command = {
        name: "sync-test",
        description: "Test",
        run: () => {
          // synchronous function
        },
      }

      expect(() => cmd.run([])).not.toThrow()
    })

    it("run method can throw errors", async () => {
      const cmd: Command = {
        name: "error-test",
        description: "Test",
        run: async () => {
          throw new Error("Test error")
        },
      }

      await expect(cmd.run([])).rejects.toThrow("Test error")
    })
  })
})
