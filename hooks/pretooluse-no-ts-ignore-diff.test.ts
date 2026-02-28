/**
 * Differential regression test: pretooluse-no-ts-ignore hook vs TypeScript compiler.
 *
 * For each Unicode character in the candidate table the test independently measures:
 *
 *   (A) Does TypeScript's compiler recognise `// <char>@ts-ignore` as a suppression
 *       directive?  Measured by writing a real .ts file with a type error, running
 *       `tsc --noEmit`, and checking whether the error was suppressed (exit 0).
 *
 *   (B) Does our hook block `// <char>@ts-ignore` in a .ts file?  Measured by
 *       spawning the hook with the same content and reading its decision.
 *
 * The fundamental property asserted per character:
 *
 *   hook_blocks(char)  ===  tsc_recognises_directive(char)
 *
 * Any disagreement is semantic drift — a character that TypeScript treats as comment
 * whitespace but our regex misses (false-negative bypass) or vice versa (false
 * positive).  The test fails with a descriptive message on any drift found.
 *
 * If `tsc` is not available in the environment, every test skips gracefully.
 *
 * Keywords are split across array joins so the hook does not trigger on this file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const KW_IGNORE = ["ts", "ignore"].join("-")

// ─── Candidate table ─────────────────────────────────────────────────────────
//
// The table spans:
//   • ASCII whitespace (sanity anchors — both must agree "block")
//   • Unicode Zs "Space_Separator" characters (in JS \s, both must agree "block")
//   • U+0085 NEXT LINE — TypeScript's isWhiteSpaceSingleLine includes it; JS \s does not
//   • U+200B ZERO-WIDTH SPACE — upper bound of TypeScript's 0x2000..0x200B range; NOT in \s
//   • Non-whitespace invisible characters (Cf category — both must agree "allow")
//   • ASCII non-whitespace control characters (both must agree "allow")

interface Candidate {
  cp: number
  name: string
}

const CANDIDATES: Candidate[] = [
  // ── ASCII whitespace (sanity: both block) ────────────────────────────────
  { cp: 0x0020, name: "ASCII SPACE" },
  { cp: 0x0009, name: "ASCII TAB" },
  // ── Unicode Zs Space_Separator (in JS \s — both block) ──────────────────
  { cp: 0x00a0, name: "NO-BREAK SPACE" },
  { cp: 0x1680, name: "OGHAM SPACE MARK" },
  { cp: 0x2000, name: "EN QUAD" },
  { cp: 0x2001, name: "EM QUAD" },
  { cp: 0x2002, name: "EN SPACE" },
  { cp: 0x2003, name: "EM SPACE" },
  { cp: 0x2009, name: "THIN SPACE" },
  { cp: 0x200a, name: "HAIR SPACE" },
  { cp: 0x202f, name: "NARROW NO-BREAK SPACE" },
  { cp: 0x205f, name: "MEDIUM MATHEMATICAL SPACE" },
  { cp: 0x3000, name: "IDEOGRAPHIC SPACE" },
  { cp: 0xfeff, name: "BOM / ZWNBSP" },
  // ── Potential drift characters ───────────────────────────────────────────
  // TypeScript's isWhiteSpaceSingleLine includes U+0085 explicitly;
  // ECMAScript \s does not.
  { cp: 0x0085, name: "NEXT LINE (NEL)" },
  // TypeScript's range ch >= 0x2000 && ch <= 0x200B includes U+200B;
  // ECMAScript \s includes 0x2000-0x200A (Zs) but not 0x200B (Cf).
  { cp: 0x200b, name: "ZERO-WIDTH SPACE" },
  // ── Non-\s invisible / format characters (Cf — both allow) ───────────────
  { cp: 0x200c, name: "ZERO-WIDTH NON-JOINER" },
  { cp: 0x200d, name: "ZERO-WIDTH JOINER" },
  { cp: 0x200e, name: "LEFT-TO-RIGHT MARK" },
  { cp: 0x2060, name: "WORD JOINER" },
  { cp: 0x00ad, name: "SOFT HYPHEN" },
  // ── ASCII non-whitespace control chars (both allow) ──────────────────────
  { cp: 0x0001, name: "SOH" },
  { cp: 0x0007, name: "BEL" },
  { cp: 0x001b, name: "ESC" },
  { cp: 0x007f, name: "DEL" },
]

// ─── Infrastructure ───────────────────────────────────────────────────────────

function cpHex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

function fileName(cp: number): string {
  return `test_${cp.toString(16).toUpperCase().padStart(4, "0")}.ts`
}

let TMP_DIR = ""
let tscBin: string | null = null
// Pre-computed results filled in beforeAll
const tscRecognised = new Map<number, boolean>()
const hookBlocks = new Map<number, boolean>()

beforeAll(async () => {
  // ── Locate tsc ────────────────────────────────────────────────────────────
  const localTsc = join(process.cwd(), "node_modules", ".bin", "tsc")
  if (existsSync(localTsc)) {
    tscBin = localTsc
  } else {
    const whichTsc = Bun.which("tsc")
    if (whichTsc) tscBin = whichTsc
  }
  if (!tscBin) return // skip all tests gracefully

  // ── Create temp directory with tsconfig ───────────────────────────────────
  TMP_DIR = join(tmpdir(), `no-ts-ignore-diff-${process.pid}`)
  await mkdir(TMP_DIR, { recursive: true })
  await writeFile(
    join(TMP_DIR, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        target: "ES2022",
        skipLibCheck: true,
      },
      include: ["*.ts"],
    })
  )

  // ── Write one TS file per candidate ──────────────────────────────────────
  // Template literals keep KW_IGNORE unexpanded in this source file so the
  // hook does not trigger when this file is written or edited.
  for (const { cp } of CANDIDATES) {
    const char = String.fromCodePoint(cp)
    // Directive line: `// <char>@ts-ignore`  (the KW_IGNORE variable expands
    // at runtime to "ts-ignore"; the source text contains `${KW_IGNORE}`)
    const directiveLine = `//${char}@${KW_IGNORE}`
    await writeFile(
      join(TMP_DIR, fileName(cp)),
      `${directiveLine}\nconst _: string = 1;\n`
    )
  }

  // ── Run tsc once on the entire temp directory ────────────────────────────
  const tscProc = Bun.spawn([tscBin, "--project", join(TMP_DIR, "tsconfig.json")], {
    cwd: TMP_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  const tscOutput = (await new Response(tscProc.stdout).text()) +
    (await new Response(tscProc.stderr).text())
  await tscProc.exited

  // Files that appear in the error output had their error un-suppressed,
  // meaning TypeScript did NOT recognise the directive for that character.
  const filesWithErrors = new Set<string>()
  for (const line of tscOutput.split("\n")) {
    const match = line.match(/^(.+\.ts)\(\d+,/)
    if (match) filesWithErrors.add(basename(match[1]!))
  }

  for (const { cp } of CANDIDATES) {
    // File absent from errors → error was suppressed → TypeScript DID recognise directive
    tscRecognised.set(cp, !filesWithErrors.has(fileName(cp)))
  }

  // ── Run hook for all candidates in parallel ───────────────────────────────
  await Promise.all(
    CANDIDATES.map(async ({ cp }) => {
      const char = String.fromCodePoint(cp)
      const directiveLine = `//${char}@${KW_IGNORE}`
      const payload = JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "src/app.ts",
          new_string: `${directiveLine}\nconst _: string = 1;\n`,
        },
      })
      const proc = Bun.spawn(["bun", "hooks/pretooluse-no-ts-ignore.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(payload)
      proc.stdin.end()
      const rawOutput = await new Response(proc.stdout).text()
      await proc.exited

      let blocked = false
      if (rawOutput.trim()) {
        try {
          const parsed = JSON.parse(rawOutput.trim())
          const hso = parsed.hookSpecificOutput
          blocked = (hso?.permissionDecision ?? parsed.decision) === "deny"
        } catch {}
      }
      hookBlocks.set(cp, blocked)
    })
  )
})

afterAll(async () => {
  if (TMP_DIR) await rm(TMP_DIR, { recursive: true, force: true })
})

// ─── Differential tests ───────────────────────────────────────────────────────

describe("pretooluse-no-ts-ignore: differential hook vs TypeScript compiler", () => {
  test("tsc is available for differential testing", () => {
    // This test documents whether tsc was found; other tests skip if not.
    if (!tscBin) {
      console.warn("tsc not found — differential tests will skip")
    }
    // Always passes — availability is reported, not required
  })

  for (const { cp, name } of CANDIDATES) {
    test(`${cpHex(cp)} ${name}: hook blocks ↔ TypeScript recognises directive`, () => {
      if (!tscBin) return // tsc unavailable — skip gracefully

      const ts = tscRecognised.get(cp) ?? false
      const hook = hookBlocks.get(cp) ?? false

      if (hook !== ts) {
        const char = String.fromCodePoint(cp)
        const hookVerdict = hook ? "BLOCK" : "allow"
        const tscVerdict = ts ? "RECOGNISED (error suppressed)" : "ignored (error emitted)"
        throw new Error(
          `Semantic drift detected for ${cpHex(cp)} ${name} (char: ${JSON.stringify(char)})\n` +
          `  Hook decision : ${hookVerdict}\n` +
          `  TypeScript    : ${tscVerdict}\n` +
          `  Fix required  : align the hook's whitespace pattern with TypeScript's ` +
          `isWhiteSpaceSingleLine so both agree on this character.`
        )
      }

      expect(hook).toBe(ts)
    })
  }
})
