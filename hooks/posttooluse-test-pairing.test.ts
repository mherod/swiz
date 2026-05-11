import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { evaluatePosttooluseTestPairing } from "./posttooluse-test-pairing.ts"

const OLD_TIME = new Date(Date.now() - 2 * 60 * 60 * 1000)

async function createTempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "posttooluse-test-pairing-"))
}

async function writeStaleFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  await utimes(filePath, OLD_TIME, OLD_TIME)
}

function makeInput(cwd: string, filePath: string): PostToolHookInput {
  return {
    cwd,
    session_id: "",
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  } satisfies PostToolHookInput
}

function expectMatched(result: SwizHookOutput, expectedPath: string): void {
  expect(result).not.toEqual({})
  if (!("systemMessage" in result)) {
    throw new Error("Expected a systemMessage for matched test files")
  }

  expect(result.systemMessage).toContain(expectedPath)
  expect(result.systemMessage).toContain("check if it needs updating")
}

describe("evaluatePosttooluseTestPairing", () => {
  test("matches colocated .test files", async () => {
    const cwd = await createTempProject()
    const sourceFile = join(cwd, "src", "button.ts")
    const testFile = join(cwd, "src", "button.test.ts")

    await writeStaleFile(sourceFile, "export const Button = 1\n")
    await writeStaleFile(testFile, "// stale test\n")

    const result = await evaluatePosttooluseTestPairing(makeInput(cwd, sourceFile))
    expectMatched(result, testFile)
  })

  test("matches files in tests directories", async () => {
    const cwd = await createTempProject()
    const sourceFile = join(cwd, "src", "button.ts")
    const testFile = join(cwd, "src", "tests", "button.ts")

    await writeStaleFile(sourceFile, "export const Button = 1\n")
    await writeStaleFile(testFile, "// stale test\n")

    const result = await evaluatePosttooluseTestPairing(makeInput(cwd, sourceFile))
    expectMatched(result, testFile)
  })

  test("keeps searching when an earlier match is fresh", async () => {
    const cwd = await createTempProject()
    const sourceFile = join(cwd, "src", "button.ts")
    const freshTestFile = join(cwd, "src", "button.test.ts")
    const staleTestFile = join(cwd, "src", "tests", "button.ts")

    await writeStaleFile(sourceFile, "export const Button = 1\n")
    await writeFile(freshTestFile, "// fresh test\n")
    await writeStaleFile(staleTestFile, "// stale test\n")

    const result = await evaluatePosttooluseTestPairing(makeInput(cwd, sourceFile))
    expectMatched(result, staleTestFile)
  })

  test("matches spec files in test directories", async () => {
    const cwd = await createTempProject()
    const sourceFile = join(cwd, "src", "button.ts")
    const testFile = join(cwd, "src", "test", "button.spec.ts")

    await writeStaleFile(sourceFile, "export const Button = 1\n")
    await writeStaleFile(testFile, "// stale spec\n")

    const result = await evaluatePosttooluseTestPairing(makeInput(cwd, sourceFile))
    expectMatched(result, testFile)
  })

  test("skips edited files in tests directories", async () => {
    const cwd = await createTempProject()
    const testFile = join(cwd, "src", "tests", "button.ts")

    await writeStaleFile(testFile, "// stale test\n")

    const result = await evaluatePosttooluseTestPairing(makeInput(cwd, testFile))
    expect(result).toEqual({})
  })
})
