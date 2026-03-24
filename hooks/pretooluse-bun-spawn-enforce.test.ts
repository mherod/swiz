import { describe, expect, it } from "vitest"
import {
  BLOCKED_NODE_SPAWN_OPS,
  findBlockedNodeSpawnOps,
  usesBunApis,
} from "./pretooluse-bun-spawn-enforce.ts"

// Construct API names dynamically to avoid self-detection by the hook.
const EXEC_S = ["exec", "Sync"].join("")
const SPAWN_S = ["spawn", "Sync"].join("")
const EXEC_FILE_S = ["exec", "File", "Sync"].join("")

// ─── usesBunApis ─────────────────────────────────────────────────────────────

describe("usesBunApis", () => {
  it("detects Bun.spawn() usage", () => {
    expect(usesBunApis('Bun.spawn(["ls"])')).toBe(true)
  })

  it("detects Bun.file() usage", () => {
    expect(usesBunApis('const f = Bun.file("data.json")')).toBe(true)
  })

  it("detects Bun.write() usage", () => {
    expect(usesBunApis('await Bun.write("out.txt", data)')).toBe(true)
  })

  it("detects bun shebang", () => {
    expect(usesBunApis("#!/usr/bin/env bun\nconsole.log('hi')")).toBe(true)
  })

  it("returns false for plain Node.js code", () => {
    expect(usesBunApis(`import { ${EXEC_S} } from "child_process"\n${EXEC_S}("ls")`)).toBe(false)
  })

  it("returns false for empty content", () => {
    expect(usesBunApis("")).toBe(false)
  })
})

// ─── findBlockedNodeSpawnOps — blocked operations ─────────────────────────────

describe("findBlockedNodeSpawnOps — blocked operations", () => {
  it("blocks execSync", () => {
    const [match] = findBlockedNodeSpawnOps(`${EXEC_S}("ls -la")`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(EXEC_S)
    expect(match!.replacement).toContain("Bun.spawn")
  })

  it("blocks spawnSync", () => {
    const [match] = findBlockedNodeSpawnOps(`${SPAWN_S}("node", ["script.js"])`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(SPAWN_S)
    expect(match!.replacement).toContain("Bun.spawn")
  })

  it("blocks execFileSync", () => {
    const [match] = findBlockedNodeSpawnOps(`${EXEC_FILE_S}("git", ["status"])`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(EXEC_FILE_S)
    expect(match!.replacement).toContain("Bun.spawn")
  })

  it("detects multiple blocked operations in one file", () => {
    const content = [
      `${EXEC_S}("ls")`,
      `${SPAWN_S}("node", ["x"])`,
      `${EXEC_FILE_S}("git", ["log"])`,
    ].join("\n")
    const result = findBlockedNodeSpawnOps(content)
    expect(result).toHaveLength(3)
    const names = result.map((r) => r.name)
    expect(names).toContain(EXEC_S)
    expect(names).toContain(SPAWN_S)
    expect(names).toContain(EXEC_FILE_S)
  })
})

// ─── findBlockedNodeSpawnOps — allowed operations ─────────────────────────────

describe("findBlockedNodeSpawnOps — allowed operations", () => {
  it("allows Bun.spawn() (native API)", () => {
    expect(findBlockedNodeSpawnOps('Bun.spawn(["ls"])')).toHaveLength(0)
  })

  it("allows async exec from child_process/promises", () => {
    expect(findBlockedNodeSpawnOps('await exec("ls")')).toHaveLength(0)
  })

  it("allows async spawn from child_process", () => {
    expect(findBlockedNodeSpawnOps('const child = spawn("node")')).toHaveLength(0)
  })

  it("allows async execFile from child_process", () => {
    expect(findBlockedNodeSpawnOps('execFile("git", ["status"], cb)')).toHaveLength(0)
  })

  it("returns empty for content with no spawn operations", () => {
    expect(findBlockedNodeSpawnOps('console.log("hello")')).toHaveLength(0)
  })

  it("returns empty for empty content", () => {
    expect(findBlockedNodeSpawnOps("")).toHaveLength(0)
  })
})

// ─── integration: Bun file + blocked spawn ops ───────────────────────────────

describe("integration: Bun API detection + blocked spawn ops", () => {
  it("Bun file with execSync triggers block", () => {
    const content = `#!/usr/bin/env bun\nconst out = ${EXEC_S}("ls")`
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeSpawnOps(content)).toHaveLength(1)
  })

  it("Bun file with spawnSync triggers block", () => {
    const content = `Bun.spawn(["echo"])\n${SPAWN_S}("node", ["x"])`
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeSpawnOps(content)).toHaveLength(1)
  })

  it("Bun file with only async spawn passes", () => {
    const content = '#!/usr/bin/env bun\nawait Bun.spawn(["ls"]).exited'
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeSpawnOps(content)).toHaveLength(0)
  })

  it("non-Bun file with sync ops is not a hook concern", () => {
    const content = `import { ${EXEC_S} } from "child_process"\n${EXEC_S}("ls")`
    expect(usesBunApis(content)).toBe(false)
  })
})

// ─── structural: word boundary guard ──────────────────────────────────────────

describe("BLOCKED_NODE_SPAWN_OPS structural invariants", () => {
  it("every regex contains a word boundary to prevent partial-word matches", () => {
    for (const op of BLOCKED_NODE_SPAWN_OPS) {
      expect(op.re.source.includes("\\b"), `${op.name} regex missing \\b`).toBe(true)
    }
  })

  it("every regex uses negative lookbehind to exclude Bun-native calls", () => {
    for (const op of BLOCKED_NODE_SPAWN_OPS) {
      expect(op.re.source.includes("(?<!Bun\\.)"), `${op.name} regex missing Bun lookbehind`).toBe(
        true
      )
    }
  })
})
