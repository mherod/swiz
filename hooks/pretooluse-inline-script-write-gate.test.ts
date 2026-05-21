import { describe, expect, test } from "bun:test"
import {
  detectWriteOps,
  extractEvalBody,
  findInlineScriptWrites,
  INLINE_WRITE_OPS,
} from "./pretooluse-inline-script-write-gate.ts"

// Labels constructed the same way the hook does to avoid literal assembly
const wf = ["write", "File"].join("")
const wfs = ["write", "File", "Sync"].join("")
const af = ["append", "File"].join("")
const afs = ["append", "File", "Sync"].join("")
const cws = ["create", "Write", "Stream"].join("")
const bw = "Bun.write"
// Read-only op label (also split to prevent self-detection)
const rfs = ["read", "File", "Sync"].join("")

describe("INLINE_WRITE_OPS", () => {
  test("all ops have a non-empty label and a working regex", () => {
    for (const op of INLINE_WRITE_OPS) {
      expect(op.label.length).toBeGreaterThan(0)
      expect(op.re).toBeInstanceOf(RegExp)
    }
  })

  test("labels are all unique", () => {
    const labels = INLINE_WRITE_OPS.map((op) => op.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("extractEvalBody", () => {
  test("extracts double-quoted body after -e flag", () => {
    expect(extractEvalBody(`node -e "console.log('hi')"`)).toBe("console.log('hi')")
  })

  test("extracts single-quoted body after -e flag", () => {
    expect(extractEvalBody(`bun -e 'console.log("hi")'`)).toBe('console.log("hi")')
  })

  test("extracts body after --eval flag with space", () => {
    expect(extractEvalBody(`node --eval "const x = 1"`)).toBe("const x = 1")
  })

  test("extracts body after --eval= form", () => {
    expect(extractEvalBody(`node --eval="const x = 1"`)).toBe("const x = 1")
  })

  test("handles escaped double-quote inside double-quoted body", () => {
    expect(extractEvalBody(`node -e "console.log(\\"hello\\")"`)).toBe('console.log("hello")')
  })

  test("handles multiline body in double-quoted string", () => {
    const seg = `node -e "const a = 1;\nconst b = 2;"`
    expect(extractEvalBody(seg)).toBe("const a = 1;\nconst b = 2;")
  })

  test("extracts backtick-quoted body", () => {
    expect(extractEvalBody("node -e `const x = 1`")).toBe("const x = 1")
  })

  test("extracts unquoted body up to whitespace", () => {
    expect(extractEvalBody("node -e code_here")).toBe("code_here")
  })

  test("returns null when no eval flag present", () => {
    expect(extractEvalBody("node script.ts")).toBeNull()
  })

  test("returns null for empty segment", () => {
    expect(extractEvalBody("")).toBeNull()
  })

  test("handles flags before -e", () => {
    expect(extractEvalBody(`node --no-warnings -e "const x = 1"`)).toBe("const x = 1")
  })
})

describe("detectWriteOps", () => {
  test(`detects ${wfs} call`, () => {
    expect(detectWriteOps(`require('fs').${wfs}('file.txt', data)`)).toContain(wfs)
  })

  test(`detects async ${wf} call`, () => {
    expect(detectWriteOps(`fs.${wf}('file.txt', data, () => {})`)).toContain(wf)
  })

  test(`detects ${afs} call`, () => {
    expect(detectWriteOps(`fs.${afs}('log.txt', line)`)).toContain(afs)
  })

  test(`detects async ${af} call`, () => {
    expect(detectWriteOps(`fs.${af}('log.txt', line, () => {})`)).toContain(af)
  })

  test(`detects ${cws} call`, () => {
    expect(detectWriteOps(`fs.${cws}('out.txt').write(data)`)).toContain(cws)
  })

  test(`detects ${bw} call`, () => {
    expect(detectWriteOps(`await Bun.write('file.txt', content)`)).toContain(bw)
  })

  test("detects multiple write ops in same body", () => {
    const body = `fs.${wfs}('a', x); fs.${afs}('b', y)`
    const ops = detectWriteOps(body)
    expect(ops).toContain(wfs)
    expect(ops).toContain(afs)
  })

  test("returns empty array for read-only operations", () => {
    expect(detectWriteOps(`require('fs').${rfs}('file.txt', 'utf8')`)).toEqual([])
  })

  test("returns empty array for console output", () => {
    expect(detectWriteOps("console.log(JSON.stringify({a:1}))")).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(detectWriteOps("")).toEqual([])
  })

  test("does not match on a word boundary false-positive (e.g. notAwriteFile)", () => {
    expect(detectWriteOps(`notA${wf}('x', 'y')`)).toEqual([])
  })
})

describe("findInlineScriptWrites", () => {
  test(`blocks node -e with ${wfs}`, () => {
    const cmd = `node -e "require('fs').${wfs}('out.txt', data)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test(`blocks bun -e with ${bw}`, () => {
    const cmd = `bun -e "await Bun.write('file.txt', content)"`
    expect(findInlineScriptWrites(cmd)).toContain(bw)
  })

  test(`blocks node --eval with ${wf}`, () => {
    const cmd = `node --eval "const fs = require('fs'); fs.${wf}('a', 'b', () => {})"`
    expect(findInlineScriptWrites(cmd)).toContain(wf)
  })

  test(`blocks bun --eval= form with ${bw}`, () => {
    const cmd = `bun --eval="await Bun.write('f', 'x')"`
    expect(findInlineScriptWrites(cmd)).toContain(bw)
  })

  test("blocks single-quoted inline script", () => {
    const cmd = `node -e 'require("fs").${wfs}("out.txt","data")'`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("blocks chained command: safe_cmd && node -e write", () => {
    const dangerous = `node -e "require('fs').${wfs}('out', x)"`
    expect(findInlineScriptWrites(`echo hello && ${dangerous}`)).toContain(wfs)
  })

  test("blocks second eval in piped command", () => {
    const cmd = `cat file.txt | bun -e "process.stdin.resume(); require('fs').${wfs}('out', '')"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("does not block node script file execution (no -e flag)", () => {
    expect(findInlineScriptWrites("node scripts/migrate.ts")).toEqual([])
  })

  test("does not block read-only inline eval", () => {
    const cmd = `node -e "console.log(require('fs').${rfs}('package.json', 'utf8'))"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block bun -e with only computation", () => {
    expect(findInlineScriptWrites(`bun -e "console.log(1 + 1)"`)).toEqual([])
  })

  test("does not false-positive on write-related filename in node args (no -e)", () => {
    // Script filename contains a write word but there is no inline eval
    const cmd = `node run-${wf}-migration.js`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not false-positive when write keyword is in non-eval segment", () => {
    // A file named with a write word is passed to cat; node -e segment is clean
    const cmd = `cat ${wf}-output.txt && node -e "console.log('done')"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("deduplicates repeated write ops across multiple segments", () => {
    const seg1 = `node -e "require('fs').${wfs}('a', x)"`
    const seg2 = `bun -e "require('fs').${wfs}('b', y)"`
    const ops = findInlineScriptWrites(`${seg1} && ${seg2}`)
    expect(ops.filter((o) => o === wfs)).toHaveLength(1)
  })

  test("returns empty array for empty command", () => {
    expect(findInlineScriptWrites("")).toEqual([])
  })

  test("handles flags before -e in node invocation", () => {
    const cmd = `node --no-warnings -e "require('fs').${wfs}('f', d)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("handles env-var prefix before node", () => {
    const cmd = `NODE_ENV=test node -e "require('fs').${wfs}('f', d)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })
})

describe("hook run() integration", () => {
  test("allows non-write inline eval", async () => {
    const { default: hook } = await import("./pretooluse-inline-script-write-gate.ts")
    const input = {
      tool_name: "Bash",
      tool_input: { command: `bun -e "console.log('hello')"` },
    }
    const result = (await Promise.resolve(hook.run(input))) as Record<string, unknown>
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined
    expect(hso?.permissionDecision).not.toBe("deny")
  })

  test("denies inline eval with file write", async () => {
    const { default: hook } = await import("./pretooluse-inline-script-write-gate.ts")
    const cmd = `node -e "require('fs').${wfs}('out.txt', 'data')"`
    const input = {
      tool_name: "Bash",
      tool_input: { command: cmd },
    }
    const result = (await Promise.resolve(hook.run(input))) as Record<string, unknown>
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined
    expect(hso?.permissionDecision).toBe("deny")
  })
})
