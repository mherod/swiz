import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendPayloadToJsonl,
  buildIncomingCaptureFilename,
  buildIncomingDispatchCaptureEnvelope,
  buildRawIncomingCaptureFilename,
  normalizeEventNameToCanonical,
  pruneStaleIncomingCaptures,
  SWIZ_INCOMING_RETENTION_MS,
  sanitizeDispatchPayloadForCapture,
  sanitizeHookFilenameSegment,
  shouldCaptureIncomingPayloads,
  writeIncomingDispatchCapture,
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

  it("buildIncomingDispatchCaptureEnvelope keeps incoming raw before normalization", () => {
    const envelope = buildIncomingDispatchCaptureEnvelope({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      parseError: false,
      payloadStr: '{"tool_name":"raw","user_email":"user@example.com"}',
      incomingBeforeNormalize: {
        tool_name: "raw",
        user_email: "user@example.com",
        _env: { SECRET: "x" },
      },
      normalizedPayload: {
        tool_name: "normalized",
        user_email: "user@example.com",
        cwd: "/proj",
        _env: { SECRET: "x" },
      },
    })

    expect(envelope._swizIncomingCapture.canonicalEvent).toBe("preToolUse")
    expect(envelope._swizIncomingCapture.hookEventName).toBe("PreToolUse")
    expect(envelope._swizIncomingCapture.parseError).toBe(false)
    expect(envelope.incoming.tool_name).toBe("raw")
    expect(envelope.incoming._env).toBeUndefined()
    expect(envelope.incoming.user_email).toBe("[redacted]")
    expect(envelope.afterNormalizeAndBackfill.tool_name).toBe("normalized")
    expect(envelope.afterNormalizeAndBackfill.cwd).toBe("/proj")
  })

  it("sanitizeHookFilenameSegment strips unsafe characters", () => {
    expect(sanitizeHookFilenameSegment("beforeShellExecution")).toBe("beforeShellExecution")
    expect(sanitizeHookFilenameSegment("../../etc/passwd")).toBe(".._.._etc_passwd")
  })

  it("normalizeEventNameToCanonical normalizes PascalCase and aliases", () => {
    expect(normalizeEventNameToCanonical("preToolUse")).toBe("preToolUse")
    expect(normalizeEventNameToCanonical("PreToolUse")).toBe("preToolUse")
    expect(normalizeEventNameToCanonical("PostToolUse")).toBe("postToolUse")
    expect(normalizeEventNameToCanonical("beforeShellExecution")).toBe("preToolUse")
    expect(normalizeEventNameToCanonical("afterShellExecution")).toBe("postToolUse")
    expect(normalizeEventNameToCanonical("SessionStart")).toBe("sessionStart")
  })

  it("buildIncomingCaptureFilename includes date, canonical event name, and unique suffix", () => {
    const a = buildIncomingCaptureFilename("beforeShellExecution")
    const b = buildIncomingCaptureFilename("PreToolUse")
    const c = buildIncomingCaptureFilename("preToolUse")
    // All three should normalize to preToolUse in the filename
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-preToolUse-[a-f0-9]{8}\.json$/)
    expect(b).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-preToolUse-[a-f0-9]{8}\.json$/)
    expect(c).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}-preToolUse-[a-f0-9]{8}\.json$/)
    // Unique suffix ensures different files
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
  })

  it("buildRawIncomingCaptureFilename uses a raw JSON companion name", () => {
    expect(
      buildRawIncomingCaptureFilename("2026-01-01T00-00-00.000-preToolUse-abc12345.json")
    ).toBe("2026-01-01T00-00-00.000-preToolUse-abc12345.raw.json")
  })

  it("writeIncomingDispatchCapture writes exact raw wire payload bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-raw-"))
    const rawPayload = '{"tool_name":"Bash","user_email":"user@example.com"}'
    await writeIncomingDispatchCapture(
      {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        parseError: false,
        payloadStr: rawPayload,
        incomingBeforeNormalize: {
          tool_name: "Bash",
          user_email: "user@example.com",
        },
        normalizedPayload: {
          tool_name: "Bash",
          user_email: "user@example.com",
          cwd: "/proj",
        },
      },
      dir
    )

    const files = await readdir(dir)
    const rawFile = files.find((file) => file.endsWith(".raw.json"))
    const envelopeFile = files.find((file) => file.endsWith(".json") && !file.endsWith(".raw.json"))
    expect(rawFile).toBeDefined()
    expect(envelopeFile).toBeDefined()
    expect(await readFile(join(dir, rawFile ?? ""), "utf8")).toBe(rawPayload)

    const envelope = JSON.parse(await readFile(join(dir, envelopeFile ?? ""), "utf8")) as Record<
      string,
      any
    >
    expect(envelope._swizIncomingCapture.rawPayloadFile).toBe(rawFile)
    expect(envelope.incoming.user_email).toBe("[redacted]")
  })

  it("appendPayloadToJsonl writes sanitized JSON line to {event}.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-jsonl-"))
    const payload = { tool_name: "Bash", _env: { SECRET: "x" }, user_email: "u@e.com" }
    await appendPayloadToJsonl("PreToolUse", payload, dir)
    const content = await readFile(join(dir, "preToolUse.jsonl"), "utf8")
    const obj = JSON.parse(content.trim()) as Record<string, unknown>
    expect(obj._env).toBeUndefined()
    expect(obj._envKeys).toEqual(["SECRET"])
    expect(obj.user_email).toBe("[redacted]")
    expect(obj.tool_name).toBe("Bash")
    expect(typeof obj._capturedAt).toBe("string")
  })

  it("appendPayloadToJsonl appends successive lines to the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-append-"))
    const payload = { session_id: "s1", cwd: "/p" }
    await appendPayloadToJsonl("stop", payload, dir)
    await appendPayloadToJsonl("stop", payload, dir)
    const content = await readFile(join(dir, "stop.jsonl"), "utf8")
    expect(content.trim().split("\n")).toHaveLength(2)
  })

  it("appendPayloadToJsonl normalizes PascalCase event name in filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-norm-"))
    await appendPayloadToJsonl("PostToolUse", { cwd: "/x" }, dir)
    const exists = await Bun.file(join(dir, "postToolUse.jsonl")).exists()
    expect(exists).toBe(true)
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
