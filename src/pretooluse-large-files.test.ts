import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../hooks/utils/test-utils.ts"
import { DEFAULT_LARGE_FILE_SIZE_KB } from "../src/settings.ts"

// Re-export the internal isLfsTracked via dynamic import to test it
// (it's not exported from the hook — test via the SIZE_LIMIT_KB boundary indirectly,
// and the LFS logic via a subprocess invocation of the hook itself)

const BUN_EXE = Bun.which("bun") ?? "bun"
const HOOK_PATH = "hooks/pretooluse-large-files.ts"
const { create: createTempDir } = useTempDir("swiz-large-files-test-")

async function runHook(opts: {
  toolName: string
  filePath: string
  cwd: string
  content?: string
  oldString?: string
  newString?: string
}): Promise<{ stdout: string; exitCode: number }> {
  const payload = JSON.stringify({
    tool_name: opts.toolName,
    tool_input: {
      file_path: opts.filePath,
      content: opts.content,
      old_string: opts.oldString,
      new_string: opts.newString,
    },
    cwd: opts.cwd,
  })

  const proc = Bun.spawn([BUN_EXE, HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
    env: { ...process.env },
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return { stdout, exitCode: proc.exitCode ?? 0 }
}

function makeLargeContent(sizeKb: number): string {
  // Fill with repeated 'x' characters to hit target size
  return "x".repeat(sizeKb * 1024)
}

describe("DEFAULT_LARGE_FILE_SIZE_KB", () => {
  test("is 500", () => {
    expect(DEFAULT_LARGE_FILE_SIZE_KB).toBe(500)
  })
})

describe("pretooluse-large-files — Write tool", () => {
  test("allows Write below threshold", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "small.txt")
    const { stdout, exitCode } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(10), // 10KB — well below 500KB
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("blocks Write at threshold boundary (501KB)", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "large.txt")
    const { stdout, exitCode } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(501),
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(parsed?.hookSpecificOutput?.permissionDecisionReason).toContain("501KB")
  })

  test("blocks Write exactly at 500KB limit", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "exact.txt")
    // 500KB exactly = 512000 bytes — equals limit, not over
    const { stdout } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(500),
    })
    const parsed = JSON.parse(stdout)
    // 500KB is exactly at limit (not over), so allow
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("allows Write for LFS-tracked extension", async () => {
    const dir = await createTempDir()
    // Create .gitattributes with LFS rule for *.bin
    await writeFile(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
    const filePath = join(dir, "large.bin")
    const { stdout } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(501),
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("blocks Write for non-LFS extension even with .gitattributes for other patterns", async () => {
    const dir = await createTempDir()
    // Only *.bin is LFS-tracked, not *.txt
    await writeFile(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
    const filePath = join(dir, "large.txt")
    const { stdout } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(501),
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("deny")
  })
})

describe("pretooluse-large-files — Edit tool", () => {
  test("allows Edit that keeps file below threshold", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "file.ts")
    const initialContent = "const x = 1\n"
    await writeFile(filePath, initialContent)
    const { stdout } = await runHook({
      toolName: "Edit",
      filePath,
      cwd: dir,
      oldString: "const x = 1",
      newString: "const x = 2",
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("blocks Edit that would push file over threshold", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "file.ts")
    // Start with a file just under the limit
    const initialContent = makeLargeContent(490)
    await writeFile(filePath, initialContent)
    // Edit appends 20KB, pushing total to ~510KB
    const { stdout } = await runHook({
      toolName: "Edit",
      filePath,
      cwd: dir,
      oldString: initialContent.slice(-10),
      newString: initialContent.slice(-10) + makeLargeContent(20),
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("deny")
  })
})

describe("pretooluse-large-files — non-file-edit tools", () => {
  test("allows Bash tool (not a file write)", async () => {
    const dir = await createTempDir()
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      cwd: dir,
    })
    const proc = Bun.spawn([BUN_EXE, HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
      env: { ...process.env },
    })
    void proc.stdin.write(payload)
    void proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("allows NotebookEdit tool (size not determinable)", async () => {
    const dir = await createTempDir()
    const payload = JSON.stringify({
      tool_name: "NotebookEdit",
      tool_input: { file_path: join(dir, "notebook.ipynb"), content: makeLargeContent(501) },
      cwd: dir,
    })
    const proc = Bun.spawn([BUN_EXE, HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
      env: { ...process.env },
    })
    void proc.stdin.write(payload)
    void proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })
})

describe("pretooluse-large-files — LFS pattern matching", () => {
  test("LFS wildcard *.png matches any .png file in subdir", async () => {
    const dir = await createTempDir()
    await mkdir(join(dir, "assets"), { recursive: true })
    await writeFile(join(dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n")
    const filePath = join(dir, "assets", "logo.png")
    const { stdout } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(501),
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })

  test("LFS rule for specific file name matches that file", async () => {
    const dir = await createTempDir()
    await writeFile(join(dir, ".gitattributes"), "data.bin filter=lfs diff=lfs merge=lfs -text\n")
    const filePath = join(dir, "data.bin")
    const { stdout } = await runHook({
      toolName: "Write",
      filePath,
      cwd: dir,
      content: makeLargeContent(501),
    })
    const parsed = JSON.parse(stdout)
    expect(parsed?.hookSpecificOutput?.permissionDecision).toBe("allow")
  })
})
