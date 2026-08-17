import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendPayloadToJsonl,
  buildIncomingCaptureFilename,
  buildIncomingDispatchCaptureEnvelope,
  buildRawIncomingCaptureFilename,
  normalizeEventNameToCanonical,
  pruneStaleIncomingCaptures,
  resolveIncomingCaptureLimits,
  SWIZ_INCOMING_JSONL_MAX_BYTES,
  SWIZ_INCOMING_MAX_BYTES,
  SWIZ_INCOMING_PRUNE_INTERVAL_MS,
  SWIZ_INCOMING_RETENTION_MS,
  sanitizeDispatchPayloadForCapture,
  sanitizeHookFilenameSegment,
  scheduleIncomingDispatchCapture,
  scheduleStaleIncomingCapturePrune,
  shouldCaptureIncomingPayloads,
  shouldCaptureRawIncomingPayloads,
  summarizeDispatchPayloadForJsonl,
  summarizeToolSearchForJsonl,
  writeIncomingDispatchCapture,
} from "./incoming-capture.ts"

describe("summarizeToolSearchForJsonl", () => {
  it("captures the query and matched tool names", () => {
    expect(
      summarizeToolSearchForJsonl({
        tool_name: "ToolSearch",
        tool_input: { query: "select:TaskCreate,TaskUpdate,TaskList", max_results: 15 },
        tool_response: {
          matches: ["TaskCreate", "TaskUpdate", "TaskList"],
          total_deferred_tools: 115,
        },
      })
    ).toEqual({
      query: "select:TaskCreate,TaskUpdate,TaskList",
      maxResults: 15,
      matches: ["TaskCreate", "TaskUpdate", "TaskList"],
      totalDeferredTools: 115,
    })
  })

  it("returns null for tools other than ToolSearch", () => {
    expect(
      summarizeToolSearchForJsonl({ tool_name: "Bash", tool_input: { query: "ls" } })
    ).toBeNull()
  })

  it("returns null when no recognized fields are present", () => {
    expect(summarizeToolSearchForJsonl({ tool_name: "ToolSearch" })).toBeNull()
    expect(
      summarizeToolSearchForJsonl({ tool_name: "ToolSearch", tool_response: "not-an-object" })
    ).toBeNull()
  })

  it("drops non-string entries from matches", () => {
    expect(
      summarizeToolSearchForJsonl({
        tool_name: "ToolSearch",
        tool_response: { matches: ["TaskList", 42, null] },
      })
    ).toEqual({ matches: ["TaskList"] })
  })

  it("is attached to the JSONL summary for ToolSearch payloads", () => {
    const summary = summarizeDispatchPayloadForJsonl({
      session_id: "session-a",
      tool_name: "ToolSearch",
      tool_input: { query: "task tools" },
      tool_response: { matches: ["mcp__swiz__TaskList"] },
    })
    expect(summary._toolSearch).toEqual({
      query: "task tools",
      matches: ["mcp__swiz__TaskList"],
    })
  })

  it("leaves non-ToolSearch summaries content-free", () => {
    const summary = summarizeDispatchPayloadForJsonl({
      session_id: "session-a",
      tool_name: "Bash",
      tool_input: { command: "echo secret-business" },
    })
    expect(summary._toolSearch).toBeUndefined()
    expect(JSON.stringify(summary)).not.toContain("secret-business")
  })
})

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

  it("requires an explicit opt-in for exact raw captures", () => {
    expect(shouldCaptureRawIncomingPayloads({})).toBe(false)
    expect(shouldCaptureRawIncomingPayloads({ SWIZ_CAPTURE_INCOMING_RAW: "true" })).toBe(false)
    expect(shouldCaptureRawIncomingPayloads({ SWIZ_CAPTURE_INCOMING_RAW: "1" })).toBe(true)
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

  it("recursively redacts nested credentials and bounds large strings", () => {
    const out = sanitizeDispatchPayloadForCapture({
      nested: {
        authorization: "Bearer abc.def.ghi",
        message: `prefix ghp_${"a".repeat(20)} ${"x".repeat(70_000)}`,
        _env: { API_KEY: "secret" },
      },
    })
    expect(out.nested.authorization).toBe("[redacted]")
    expect(out.nested._env).toBeUndefined()
    expect(out.nested._envKeys).toEqual(["API_KEY"])
    expect(out.nested.message).not.toContain("ghp_")
    expect(out.nested.message).toContain("[truncated")
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
        _swizDispatchId: "dispatch-1",
        user_email: "user@example.com",
        cwd: "/proj",
        _env: { SECRET: "x" },
      },
    })

    expect(envelope._swizIncomingCapture.canonicalEvent).toBe("preToolUse")
    expect(envelope._swizIncomingCapture.hookEventName).toBe("PreToolUse")
    expect(envelope._swizIncomingCapture.parseError).toBe(false)
    expect(envelope._swizIncomingCapture.dispatchId).toBe("dispatch-1")
    expect(envelope.incoming.tool_name).toBe("raw")
    expect(envelope.incoming._env).toBeUndefined()
    expect(envelope.incoming.user_email).toBe("[redacted]")
    expect(envelope._swizIncomingCapture.formatVersion).toBe(2)
    expect(envelope.normalizationDelta.set.tool_name).toBe("normalized")
    expect(envelope.normalizationDelta.set.cwd).toBe("/proj")
    expect(envelope.afterNormalizeAndBackfill).toBeUndefined()
  })

  it("records an empty normalization delta when normalization changes nothing", () => {
    const envelope = buildIncomingDispatchCaptureEnvelope({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      parseError: false,
      payloadStr: '{"tool_name":"Read"}',
      incomingBeforeNormalize: { tool_name: "Read" },
      normalizedPayload: { tool_name: "Read" },
    })

    expect(envelope.normalizationDelta).toEqual({ set: {}, removed: [] })
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

  it("writeIncomingDispatchCapture omits exact raw wire payload bytes by default", async () => {
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
    const envelopeFile = files.find((file) => file.endsWith(".json") && !file.endsWith(".raw.json"))
    expect(files.some((file) => file.endsWith(".raw.json"))).toBe(false)
    expect(envelopeFile).toBeDefined()

    const envelope = JSON.parse(await readFile(join(dir, envelopeFile ?? ""), "utf8")) as Record<
      string,
      any
    >
    expect(envelope._swizIncomingCapture.rawPayloadFile).toBeUndefined()
    expect(envelope.incoming.user_email).toBe("[redacted]")
  })

  it("writes exact raw wire payload bytes only when explicitly enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-raw-opt-in-"))
    const rawPayload = '{"token":"secret-value"}'
    await writeIncomingDispatchCapture(
      {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        parseError: false,
        payloadStr: rawPayload,
        incomingBeforeNormalize: { token: "secret-value" },
        normalizedPayload: { token: "secret-value" },
      },
      dir,
      true
    )

    const files = await readdir(dir)
    const rawFile = files.find((file) => file.endsWith(".raw.json"))
    expect(rawFile).toBeDefined()
    expect(await readFile(join(dir, rawFile ?? ""), "utf8")).toBe(rawPayload)
  })

  it("records parse errors without embedding malformed payload bytes", () => {
    const malformed = '{"token":"secret-value"'
    const envelope = buildIncomingDispatchCaptureEnvelope({
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      parseError: true,
      payloadStr: malformed,
      incomingBeforeNormalize: null,
      normalizedPayload: {},
    })
    expect(JSON.stringify(envelope)).not.toContain(malformed)
    expect(envelope.rawPayload).toBeUndefined()
    expect(envelope._swizIncomingCapture.payloadBytes).toBeGreaterThan(0)
  })

  it("appendPayloadToJsonl writes a content-free payload summary to {event}.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-jsonl-"))
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "sensitive command" },
      _env: { SECRET: "x" },
      user_email: "u@e.com",
    }
    await appendPayloadToJsonl("PreToolUse", payload, dir)
    const content = await readFile(join(dir, "preToolUse.jsonl"), "utf8")
    const obj = JSON.parse(content.trim()) as Record<string, unknown>
    expect(obj._env).toBeUndefined()
    expect(obj._envKeys).toEqual(["SECRET"])
    expect(obj.user_email).toBeUndefined()
    expect(obj.tool_input).toBeUndefined()
    expect(obj._toolInputKeys).toEqual(["command"])
    expect(content).not.toContain("sensitive command")
    expect(obj.tool_name).toBe("Bash")
    expect(typeof obj._capturedAt).toBe("string")
  })

  it("summarizes JSONL payload shape without content-bearing values", () => {
    const summary = summarizeDispatchPayloadForJsonl({
      session_id: "session-1",
      tool_name: "Edit",
      tool_input: { file_path: "/secret/path", new_string: "private contents" },
    })
    expect(summary).toMatchObject({
      session_id: "session-1",
      tool_name: "Edit",
      _toolInputKeys: ["file_path", "new_string"],
    })
    expect(JSON.stringify(summary)).not.toContain("private contents")
    expect(JSON.stringify(summary)).not.toContain("/secret/path")
  })

  it("appendPayloadToJsonl appends successive lines to the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-append-"))
    const payload = { session_id: "s1", cwd: "/p" }
    await appendPayloadToJsonl("stop", payload, dir)
    await appendPayloadToJsonl("stop", payload, dir)
    const content = await readFile(join(dir, "stop.jsonl"), "utf8")
    expect(content.trim().split("\n")).toHaveLength(2)
  })

  it("serializes concurrent JSONL appends without dropping records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-jsonl-concurrent-"))
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendPayloadToJsonl("preToolUse", { request_id: `request-${index}` }, dir)
      )
    )
    const content = await readFile(join(dir, "preToolUse.jsonl"), "utf8")
    const records = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>)
    expect(records).toHaveLength(25)
    expect(new Set(records.map((record) => record.request_id)).size).toBe(25)
  })

  it("rotates event JSONL before the configured segment budget is exceeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-jsonl-rotate-"))
    const payload = { value: "x".repeat(80) }
    await appendPayloadToJsonl("preToolUse", payload, dir, 100)
    await appendPayloadToJsonl("preToolUse", payload, dir, 100)

    const jsonlFiles = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"))
    expect(jsonlFiles).toHaveLength(2)
    expect(jsonlFiles).toContain("preToolUse.jsonl")
    for (const file of jsonlFiles) {
      expect((await readFile(join(dir, file), "utf8")).trim().split("\n")).toHaveLength(1)
    }
  })

  it("appendPayloadToJsonl normalizes PascalCase event name in filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-norm-"))
    await appendPayloadToJsonl("PostToolUse", { cwd: "/x" }, dir)
    const exists = await Bun.file(join(dir, "postToolUse.jsonl")).exists()
    expect(exists).toBe(true)
  })

  it("secures capture directories and files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "swiz-inc-modes-"))
    const dir = join(parent, "captures")
    await appendPayloadToJsonl("preToolUse", { cwd: "/x" }, dir)
    await writeIncomingDispatchCapture(
      {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        parseError: false,
        payloadStr: "{}",
        incomingBeforeNormalize: {},
        normalizedPayload: {},
      },
      dir
    )
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    for (const file of await readdir(dir)) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600)
    }
  })

  it("pruneStaleIncomingCaptures removes stale capture pairs and JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-prune-"))
    const oldPath = join(dir, "old.json")
    const oldRawPath = join(dir, "old.raw.json")
    const oldJsonlPath = join(dir, "old.jsonl")
    const freshPath = join(dir, "fresh.json")
    await writeFile(oldPath, "{}")
    await writeFile(oldRawPath, "{}")
    await writeFile(oldJsonlPath, "{}\n")
    await writeFile(freshPath, "{}")
    const oldTime = new Date(Date.now() - SWIZ_INCOMING_RETENTION_MS - 60_000)
    await utimes(oldPath, oldTime, oldTime)
    await utimes(oldRawPath, oldTime, oldTime)
    await utimes(oldJsonlPath, oldTime, oldTime)

    await pruneStaleIncomingCaptures(dir, SWIZ_INCOMING_RETENTION_MS)

    expect(await Bun.file(oldPath).exists()).toBe(false)
    expect(await Bun.file(oldRawPath).exists()).toBe(false)
    expect(await Bun.file(oldJsonlPath).exists()).toBe(false)
    expect(await Bun.file(freshPath).exists()).toBe(true)
  })

  it("prunes stale records from an actively appended JSONL segment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-prune-records-"))
    const path = join(dir, "preToolUse.jsonl")
    const stale = new Date(Date.now() - SWIZ_INCOMING_RETENTION_MS - 1_000).toISOString()
    const fresh = new Date().toISOString()
    await writeFile(
      path,
      `${JSON.stringify({ request_id: "stale", _capturedAt: stale })}\n${JSON.stringify({ request_id: "fresh", _capturedAt: fresh })}\n`
    )

    await pruneStaleIncomingCaptures(dir, SWIZ_INCOMING_RETENTION_MS)

    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.map((record) => record.request_id)).toEqual(["fresh"])
  })

  it("pruneStaleIncomingCaptures evicts oldest pairs to enforce the byte budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-prune-bytes-"))
    const oldEnvelope = join(dir, "old.json")
    const oldRaw = join(dir, "old.raw.json")
    const freshEnvelope = join(dir, "fresh.json")
    const freshRaw = join(dir, "fresh.raw.json")
    await Promise.all([
      writeFile(oldEnvelope, "12345678"),
      writeFile(oldRaw, "12345678"),
      writeFile(freshEnvelope, "1"),
      writeFile(freshRaw, "1"),
    ])
    const oldTime = new Date(Date.now() - 60_000)
    await Promise.all([utimes(oldEnvelope, oldTime, oldTime), utimes(oldRaw, oldTime, oldTime)])

    await pruneStaleIncomingCaptures(dir, SWIZ_INCOMING_RETENTION_MS, 4)

    expect(await Bun.file(oldEnvelope).exists()).toBe(false)
    expect(await Bun.file(oldRaw).exists()).toBe(false)
    expect(await Bun.file(freshEnvelope).exists()).toBe(true)
    expect(await Bun.file(freshRaw).exists()).toBe(true)
  })

  it("pruneStaleIncomingCaptures accepts a missing directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "swiz-inc-missing-parent-"))
    await expect(
      pruneStaleIncomingCaptures(join(parent, "missing"), SWIZ_INCOMING_RETENTION_MS)
    ).resolves.toBeUndefined()
  })

  it("writeIncomingDispatchCapture leaves pruning to daemon maintenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-write-no-prune-"))
    const oldPath = join(dir, "old.json")
    await writeFile(oldPath, "{}")
    const oldTime = new Date(Date.now() - SWIZ_INCOMING_RETENTION_MS - 60_000)
    await utimes(oldPath, oldTime, oldTime)

    await writeIncomingDispatchCapture(
      {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        parseError: false,
        payloadStr: '{"tool_name":"Read"}',
        incomingBeforeNormalize: { tool_name: "Read" },
        normalizedPayload: { tool_name: "Read", cwd: "/proj" },
      },
      dir
    )
    await Bun.sleep(10)

    expect(await Bun.file(oldPath).exists()).toBe(true)
  })

  it("scheduleStaleIncomingCapturePrune coalesces and throttles background pruning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-scheduled-prune-"))
    const oldPath = join(dir, "old.json")
    await writeFile(oldPath, "{}")
    const oldTime = new Date(Date.now() - SWIZ_INCOMING_RETENTION_MS - 60_000)
    await utimes(oldPath, oldTime, oldTime)

    const scheduledAt = Date.now()
    expect(scheduleStaleIncomingCapturePrune(dir, SWIZ_INCOMING_RETENTION_MS, scheduledAt)).toBe(
      true
    )
    expect(scheduleStaleIncomingCapturePrune(dir, SWIZ_INCOMING_RETENTION_MS, scheduledAt)).toBe(
      false
    )

    for (let attempt = 0; attempt < 50 && (await Bun.file(oldPath).exists()); attempt += 1) {
      await Bun.sleep(1)
    }
    expect(await Bun.file(oldPath).exists()).toBe(false)
    await Bun.sleep(0)

    expect(
      scheduleStaleIncomingCapturePrune(
        dir,
        SWIZ_INCOMING_RETENTION_MS,
        scheduledAt + SWIZ_INCOMING_PRUNE_INTERVAL_MS - 1
      )
    ).toBe(false)
    let scheduledAfterInterval = false
    for (let attempt = 0; attempt < 50 && !scheduledAfterInterval; attempt += 1) {
      scheduledAfterInterval = scheduleStaleIncomingCapturePrune(
        dir,
        SWIZ_INCOMING_RETENTION_MS,
        scheduledAt + SWIZ_INCOMING_PRUNE_INTERVAL_MS
      )
      if (!scheduledAfterInterval) await Bun.sleep(1)
    }
    expect(scheduledAfterInterval).toBe(true)
  })

  it("writes concurrent capture pairs with unique filenames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-inc-write-concurrent-"))
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeIncomingDispatchCapture(
          {
            canonicalEvent: "preToolUse",
            hookEventName: "PreToolUse",
            parseError: false,
            payloadStr: JSON.stringify({ request_id: index }),
            incomingBeforeNormalize: { request_id: index },
            normalizedPayload: { request_id: index, cwd: "/project" },
          },
          dir
        )
      )
    )
    expect(await readdir(dir)).toHaveLength(12)
  })

  it("scheduled capture fails open when the destination is not a directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "swiz-inc-write-failure-"))
    const notDirectory = join(parent, "file")
    await writeFile(notDirectory, "occupied")
    const args = {
      canonicalEvent: "preToolUse",
      hookEventName: "PreToolUse",
      parseError: false,
      payloadStr: "{}",
      incomingBeforeNormalize: {},
      normalizedPayload: { cwd: "/project" },
    }

    await expect(writeIncomingDispatchCapture(args, notDirectory)).rejects.toBeDefined()
    expect(() => scheduleIncomingDispatchCapture(args, notDirectory)).not.toThrow()
    await Bun.sleep(5)
  })

  it("resolves configurable age and byte limits with safe defaults", () => {
    expect(resolveIncomingCaptureLimits({})).toEqual({
      maxAgeMs: SWIZ_INCOMING_RETENTION_MS,
      maxBytes: SWIZ_INCOMING_MAX_BYTES,
      jsonlMaxBytes: SWIZ_INCOMING_JSONL_MAX_BYTES,
    })
    expect(
      resolveIncomingCaptureLimits({
        SWIZ_INCOMING_RETENTION_MS: "1000",
        SWIZ_INCOMING_MAX_BYTES: "2000",
        SWIZ_INCOMING_JSONL_MAX_BYTES: "3000",
      })
    ).toEqual({ maxAgeMs: 1000, maxBytes: 2000, jsonlMaxBytes: 3000 })
    expect(resolveIncomingCaptureLimits({ SWIZ_INCOMING_MAX_BYTES: "invalid" }).maxBytes).toBe(
      SWIZ_INCOMING_MAX_BYTES
    )
  })

  it("keeps the daemon as the only CLI dispatch JSONL owner", async () => {
    const [legacyCli, thinCli, daemonRoute] = await Promise.all([
      Bun.file(join(import.meta.dir, "..", "commands", "dispatch.ts")).text(),
      Bun.file(join(import.meta.dir, "..", "commands", "dispatch-bootstrap.ts")).text(),
      Bun.file(join(import.meta.dir, "..", "commands", "daemon", "dispatch-routes.ts")).text(),
    ])
    expect(legacyCli).not.toContain("schedulePayloadJsonlAppend")
    expect(thinCli).not.toContain("schedulePayloadJsonlAppend")
    expect(daemonRoute.match(/schedulePayloadJsonlAppend\(/g)).toHaveLength(1)
  })
})
