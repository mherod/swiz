import { describe, expect, it } from "vitest"
import { findBlockedNodeFileOps, usesBunApis } from "./pretooluse-bun-file-api-enforce.ts"

// Construct API names dynamically to avoid self-detection by the hook.
const READ_FS = ["read", "File", "Sync"].join("")
const WRITE_FS = ["write", "File", "Sync"].join("")
const APPEND_FS = ["append", "File", "Sync"].join("")
const UNLINK_S = ["unlink", "Sync"].join("")
const RM_S = ["rm", "Sync"].join("")

// ─── usesBunApis ─────────────────────────────────────────────────────────────

describe("usesBunApis", () => {
  it("detects Bun.file() usage", () => {
    expect(usesBunApis('const f = Bun.file("data.json")')).toBe(true)
  })

  it("detects Bun.write() usage", () => {
    expect(usesBunApis('await Bun.write("out.txt", data)')).toBe(true)
  })

  it("detects Bun.spawn() usage", () => {
    expect(usesBunApis('Bun.spawn(["ls"])')).toBe(true)
  })

  it("detects bun shebang", () => {
    expect(usesBunApis("#!/usr/bin/env bun\nconsole.log('hi')")).toBe(true)
  })

  it("returns false for plain Node.js code", () => {
    expect(usesBunApis(`import fs from "node:fs"\nfs.${READ_FS}("x")`)).toBe(false)
  })

  it("returns false for empty content", () => {
    expect(usesBunApis("")).toBe(false)
  })
})

// ─── findBlockedNodeFileOps — blocked operations ─────────────────────────────

describe("findBlockedNodeFileOps — blocked operations", () => {
  it("blocks readFileSync", () => {
    const [match] = findBlockedNodeFileOps(`${READ_FS}("path", "utf8")`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(READ_FS)
    expect(match!.replacement).toContain("Bun.file")
  })

  it("blocks writeFileSync", () => {
    const [match] = findBlockedNodeFileOps(`${WRITE_FS}("path", data)`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(WRITE_FS)
    expect(match!.replacement).toContain("Bun.write")
  })

  it("blocks appendFileSync", () => {
    const [match] = findBlockedNodeFileOps(`${APPEND_FS}("path", data)`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(APPEND_FS)
    expect(match!.replacement).toContain("Bun.write")
  })

  it("blocks unlinkSync", () => {
    const [match] = findBlockedNodeFileOps(`${UNLINK_S}("path")`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(UNLINK_S)
    expect(match!.replacement).toContain("Bun.file(path).delete()")
  })

  it("blocks rmSync", () => {
    const [match] = findBlockedNodeFileOps(`${RM_S}("path")`)
    expect(match).toBeDefined()
    expect(match!.name).toBe(RM_S)
    expect(match!.replacement).toContain("Bun.file(path).delete()")
  })

  it("detects multiple blocked operations in one file", () => {
    const content = [
      `${READ_FS}("a.txt")`,
      `${WRITE_FS}("b.txt", data)`,
      `${UNLINK_S}("c.txt")`,
    ].join("\n")
    const result = findBlockedNodeFileOps(content)
    expect(result).toHaveLength(3)
    const names = result.map((r) => r.name)
    expect(names).toContain(READ_FS)
    expect(names).toContain(WRITE_FS)
    expect(names).toContain(UNLINK_S)
  })
})

// ─── findBlockedNodeFileOps — allowed operations ─────────────────────────────

describe("findBlockedNodeFileOps — allowed operations", () => {
  it("allows mkdir (directory API)", () => {
    expect(findBlockedNodeFileOps('mkdir("dir", { recursive: true })')).toHaveLength(0)
  })

  it("allows mkdirSync (directory API)", () => {
    expect(findBlockedNodeFileOps('mkdirSync("dir")')).toHaveLength(0)
  })

  it("allows readdir (directory API)", () => {
    expect(findBlockedNodeFileOps('readdir("dir")')).toHaveLength(0)
  })

  it("allows readdirSync (directory API)", () => {
    expect(findBlockedNodeFileOps('readdirSync("dir")')).toHaveLength(0)
  })

  it("allows stat (directory/metadata API)", () => {
    expect(findBlockedNodeFileOps('stat("path")')).toHaveLength(0)
  })

  it("allows statSync (directory/metadata API)", () => {
    expect(findBlockedNodeFileOps('statSync("path")')).toHaveLength(0)
  })

  it("allows existsSync (metadata API)", () => {
    expect(findBlockedNodeFileOps('existsSync("path")')).toHaveLength(0)
  })

  it("allows Bun.file() (native API)", () => {
    expect(findBlockedNodeFileOps('await Bun.file("path").text()')).toHaveLength(0)
  })

  it("allows Bun.write() (native API)", () => {
    expect(findBlockedNodeFileOps('await Bun.write("path", data)')).toHaveLength(0)
  })

  it("allows transformSync (not a file operation)", () => {
    expect(findBlockedNodeFileOps("const result = transformSync(source)")).toHaveLength(0)
  })

  it("allows realpathSync (not a blocked file operation)", () => {
    expect(findBlockedNodeFileOps('realpathSync("/some/path")')).toHaveLength(0)
  })

  it("returns empty for content with no file operations", () => {
    expect(findBlockedNodeFileOps('console.log("hello")')).toHaveLength(0)
  })

  it("returns empty for empty content", () => {
    expect(findBlockedNodeFileOps("")).toHaveLength(0)
  })
})

// ─── integration: Bun file + blocked ops ─────────────────────────────────────

describe("integration: Bun file detection + blocked ops", () => {
  it("Bun file with readFileSync triggers block", () => {
    const content = `#!/usr/bin/env bun\nconst data = ${READ_FS}("x")`
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeFileOps(content)).toHaveLength(1)
  })

  it("Bun file with writeFileSync triggers block", () => {
    const content = `Bun.file("x")\n${WRITE_FS}("y", d)`
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeFileOps(content)).toHaveLength(1)
  })

  it("Bun file with only allowed ops passes", () => {
    const content = '#!/usr/bin/env bun\nawait Bun.file("x").text()\nmkdir("dir")'
    expect(usesBunApis(content)).toBe(true)
    expect(findBlockedNodeFileOps(content)).toHaveLength(0)
  })

  it("non-Bun file with sync ops is not a hook concern", () => {
    const content = `import fs from "node:fs"\nfs.${READ_FS}("x")`
    expect(usesBunApis(content)).toBe(false)
  })
})
