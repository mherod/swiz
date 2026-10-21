import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./test-utils.ts"

// PROCESS_CONTRACT_TEST: verifies the adapter's JSONL, exit status and child cancellation.
const temp = useTempDir("swiz-codex-completion-")
const adapterPath = join(import.meta.dir, "codex-generation-cli.ts")

async function runAdapter(source: string, abortAfterOutput = false) {
  const cwd = await temp.create()
  const fixturePath = join(cwd, "fake-codex.ts")
  await Bun.write(fixturePath, `setTimeout(() => process.exit(90), 3000).unref()\n${source}`)
  const proc = Bun.spawn([process.execPath, adapterPath, fixturePath], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      AI_TEST_NO_BACKEND: "1",
      SWIZ_CODEX_EXECUTABLE: process.execPath,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 4000)
  const readStdout = async () => {
    let output = ""
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        output += decoder.decode(value, { stream: true })
        if (abortAfterOutput) {
          abortAfterOutput = false
          proc.kill("SIGTERM")
        }
      }
    } finally {
      reader.releaseLock()
    }
    return output + decoder.decode()
  }
  try {
    const [stdout, stderr] = await Promise.all([readStdout(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timer)
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await proc.exited
  }
}

test("finishes a completed turn even when Codex stays alive and ignores SIGTERM", async () => {
  const message = `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Please preserve café and `bun test`." },
  })}\n`
  const terminal = '{"type":"turn.completed","usage":{"output_tokens":9}}\n'
  const output = `diagnostic text\n${message}${terminal}`
  const split = output.indexOf("turn.completed") + 5
  const result = await runAdapter(`
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
await Bun.write(Bun.stdout, ${JSON.stringify(output.slice(0, split))})
await Bun.sleep(10)
await Bun.write(Bun.stdout, ${JSON.stringify(output.slice(split))})
`)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe(output)
  expect(result.stderr).toBe("")
})

test("an assistant message is not a completion signal and preserves nonzero exit status", async () => {
  const output = `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "turn.completed" },
  })}\n`
  const result = await runAdapter(`
await Bun.write(Bun.stdout, ${JSON.stringify(output)})
await Bun.write(Bun.stderr, "generation failed")
process.exit(7)
`)
  expect(result).toEqual({ exitCode: 7, stdout: output, stderr: "generation failed" })
})

test.each(["error", "turn.failed"])("%s cannot be converted to success", async (type) => {
  const detail = { message: "fixture failure" }
  const output = `${JSON.stringify({ type, ...(type === "turn.failed" ? { error: detail } : detail) })}\n{"type":"turn.completed"}\n`
  const result = await runAdapter(`
await Bun.write(Bun.stdout, ${JSON.stringify(output)})
process.exit(0)
`)
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe(output)
  expect(result.stderr).toBe("fixture failure\n")
})

test("preserves failure details from the final event without a newline", async () => {
  const output = JSON.stringify({ type: "turn.failed", error: { message: "échec du service" } })
  const result = await runAdapter(`await Bun.write(Bun.stdout, ${JSON.stringify(output)})`)
  expect(result).toEqual({ exitCode: 1, stdout: output, stderr: "échec du service\n" })
})

test("caller cancellation remains a failure and terminates the child", async () => {
  const result = await runAdapter(
    `
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1000)
await Bun.write(Bun.stdout, '{"type":"turn.started"}\\n')
`,
    true
  )
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('{"type":"turn.started"}\n')
})
