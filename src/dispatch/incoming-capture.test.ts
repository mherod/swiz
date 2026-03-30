import { describe, expect, it } from "bun:test"
import { mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildIncomingCaptureFilename,
  pruneStaleIncomingCaptures,
  SWIZ_INCOMING_RETENTION_MS,
  sanitizeDispatchPayloadForCapture,
  sanitizeHookFilenameSegment,
  shouldCaptureIncomingPayloads,
} from "./incoming-capture.ts"

describe("incoming-capture", () => {
  it("shouldCaptureIncomingPayloads defaults to true when unset", () => {
    const prev = process.env.SWIZ_CAPTURE_INCOMING
    const prevP = process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
    try {
      delete process.env.SWIZ_CAPTURE_INCOMING
      delete process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
      expect(shouldCaptureIncomingPayloads()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.SWIZ_CAPTURE_INCOMING
      else process.env.SWIZ_CAPTURE_INCOMING = prev
      if (prevP === undefined) delete process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
      else process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS = prevP
    }
  })

  it("shouldCaptureIncomingPayloads is false when SWIZ_CAPTURE_INCOMING disables", () => {
    const prev = process.env.SWIZ_CAPTURE_INCOMING
    const prevP = process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
    try {
      delete process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
      process.env.SWIZ_CAPTURE_INCOMING = "0"
      expect(shouldCaptureIncomingPayloads()).toBe(false)
      process.env.SWIZ_CAPTURE_INCOMING = "false"
      expect(shouldCaptureIncomingPayloads()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.SWIZ_CAPTURE_INCOMING
      else process.env.SWIZ_CAPTURE_INCOMING = prev
      if (prevP === undefined) delete process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS
      else process.env.SWIZ_CAPTURE_INCOMING_PAYLOADS = prevP
    }
  })

  it("sanitizeDispatchPayloadForCapture drops _env values and redacts user_email", () => {
    const out = sanitizeDispatchPayloadForCapture({
      cwd: "/proj",
      user_email: "user@example.com",
      _env: { PATH: "/bin", SECRET: "x" },
      tool_name: "Bash",
    })
    expect(out._env).toBeUndefined()
    expect(out._envKeys).toEqual(["PATH", "SECRET"])
    expect(out.user_email).toBe("[redacted]")
    expect(out.cwd).toBe("/proj")
    expect(out.tool_name).toBe("Bash")
  })

  it("sanitizeHookFilenameSegment strips unsafe characters", () => {
    expect(sanitizeHookFilenameSegment("beforeShellExecution")).toBe("beforeShellExecution")
    expect(sanitizeHookFilenameSegment("../../etc/passwd")).toBe(".._.._etc_passwd")
  })

  it("buildIncomingCaptureFilename includes date, hook name, and unique suffix", () => {
    const a = buildIncomingCaptureFilename("beforeShellExecution")
    const b = buildIncomingCaptureFilename("beforeShellExecution")
    expect(a).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-beforeShellExecution-[a-f0-9]{8}\.json$/
    )
    expect(a).not.toBe(b)
  })

  it("pruneStaleIncomingCaptures removes stale .json only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-prune-"))
    const oldPath = join(dir, "old.json")
    const freshPath = join(dir, "fresh.json")
    await writeFile(oldPath, "{}")
    await writeFile(freshPath, "{}")
    const oldTime = new Date(Date.now() - SWIZ_INCOMING_RETENTION_MS - 60_000)
    await utimes(oldPath, oldTime, oldTime)

    await pruneStaleIncomingCaptures(dir, SWIZ_INCOMING_RETENTION_MS)

    expect(await Bun.file(oldPath).exists()).toBe(false)
    expect(await Bun.file(freshPath).exists()).toBe(true)
  })
})
