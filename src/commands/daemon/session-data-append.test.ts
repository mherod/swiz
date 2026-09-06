import { afterEach, expect, test } from "bun:test"
import { appendFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { SessionDataCache } from "./session-data.ts"
import { MAX_SESSION_CACHE_BYTES, MAX_SESSION_PREVIEW_BYTES } from "./session-preview.ts"
import { sessionUsageLine as usage } from "./test-fixtures/session.ts"

const paths: string[] = []
afterEach(async () => {
  for (const path of paths.splice(0))
    if (await Bun.file(path).exists()) await Bun.file(path).delete()
})

function line(text: string) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-07T10:00:00Z",
    message: { content: text },
  })
}

async function fixture(text: string) {
  const path = join(TMP_ROOT, `swiz-historical-${crypto.randomUUID()}.jsonl`)
  paths.push(path)
  await Bun.write(path, text)
  return { path, format: "jsonl" as const }
}

function measuredCache() {
  const reads: Array<[number, number]> = []
  const cache = new SessionDataCache((path) => {
    const file = Bun.file(path)
    return new Proxy(file, {
      get(target, property) {
        if (property === "slice")
          return (start: number, end: number) => {
            reads.push([start, end])
            return target.slice(start, end)
          }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
  return { cache, reads }
}

test("a historical append reads only new bytes and agrees with a fresh preview", async () => {
  const session = await fixture(`${line("First café")}\n`)
  const { cache, reads } = measuredCache()
  const first = await cache.get(session)
  const appended = `${line("Second 🌍")}\n`
  await appendFile(session.path, appended)
  reads.length = 0
  const next = await cache.get(session)
  expect(reads).toEqual([[first!.size, first!.size + Buffer.byteLength(appended)]])
  expect(next?.messages).toEqual((await new SessionDataCache().get(session))?.messages)
  expect(next?.messages.map((message) => message.text)).toEqual(["First café", "Second 🌍"])
  reads.length = 0
  expect(await cache.get(session)).toBe(next)
  expect(reads).toEqual([])
})

test("format changes invalidate historical hot entries", async () => {
  const session = await fixture(`${line("Claude message")}\n`)
  const cache = new SessionDataCache()
  expect((await cache.get(session))?.messages).toHaveLength(1)
  expect((await cache.get({ ...session, format: "codex-jsonl" }))?.messages).toEqual([])
})

test("a 50 MiB transcript append preserves the bounded moving preview", async () => {
  const padding = `${JSON.stringify({ ignored: "x".repeat(1024 * 1024) })}\n`
  const session = await fixture(`${padding.repeat(50)}${line("Recent")}\n`)
  const { cache, reads } = measuredCache()
  const first = await cache.get(session)
  expect(reads[0]![1] - reads[0]![0]).toBeLessThanOrEqual(MAX_SESSION_PREVIEW_BYTES + 1)
  const appended = `${line("New")}\n`
  await appendFile(session.path, appended)
  reads.length = 0
  const next = await cache.get(session)
  expect(reads).toEqual([[first!.size, first!.size + Buffer.byteLength(appended)]])
  expect(next?.messages).toEqual((await new SessionDataCache().get(session))?.messages)
})

function toolLine(path: string, codex = false) {
  const timestamp = "2026-09-07T10:00:00Z"
  return JSON.stringify(
    codex
      ? {
          type: "response_item",
          timestamp,
          payload: {
            type: "function_call",
            name: "Read",
            arguments: JSON.stringify({ file_path: path }),
          },
        }
      : {
          type: "assistant",
          timestamp,
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path } }] },
        }
  )
}

function publicView(value: Awaited<ReturnType<SessionDataCache["get"]>>) {
  return (
    value && {
      messages: value.messages,
      toolStats: value.toolStats,
      tokenStats: value.tokenStats,
      startedAt: value.startedAt,
      lastMessageAt: value.lastMessageAt,
      revision: value.contentRevision,
    }
  )
}

for (const format of ["jsonl", "cursor-agent-jsonl", "codex-jsonl"] as const) {
  test.each([
    ["é", 1],
    ["€", 1],
    ["€", 2],
    ["🌍", 1],
    ["🌍", 2],
    ["🌍", 3],
  ] as const)(`${format} preserves a cold UTF-8 split inside %s at byte %i`, async (character, split) => {
    const record = toolLine(`${character}.ts`, format === "codex-jsonl")
    const bytes = new TextEncoder().encode(record)
    const at = bytes.indexOf(new TextEncoder().encode(character)[0]!) + split
    const session = { ...(await fixture("")), format }
    await Bun.write(session.path, bytes.slice(0, at))
    const { cache, reads } = measuredCache()
    expect((await cache.get(session))?.toolStats).toEqual([])
    await appendFile(session.path, bytes.slice(at))
    reads.length = 0
    const provisional = await cache.get(session)
    expect(reads).toEqual([[at, bytes.length]])
    expect(provisional?.messages[0]?.toolCalls?.[0]?.detail).toContain(`${character}.ts`)
    expect(provisional?.toolStats).toEqual([{ name: "Read", count: 1 }])
    await appendFile(session.path, `\n${usage(10)}\n`)
    const complete = await cache.get(session)
    expect(publicView(complete)).toEqual(publicView(await new SessionDataCache().get(session)))
    expect(complete?.toolStats).toEqual([{ name: "Read", count: 1 }])
    expect(await cache.get(session)).toBe(complete)
  })
}

test("window rollover removes old messages, tool counts and token-rate baseline", async () => {
  const prefix = `${usage(1)}\n${toolLine("Old.ts")}\n`
  const tail = `${line("Recent")}\n${usage(20, "2026-09-07T10:01:00Z")}\n`
  const empty = `${JSON.stringify({ ignored: "" })}\n`
  const padding = `${JSON.stringify({ ignored: "x".repeat(MAX_SESSION_PREVIEW_BYTES - prefix.length - tail.length - empty.length) })}\n`
  const session = await fixture(prefix + padding + tail)
  const { cache, reads } = measuredCache()
  const first = await cache.get(session)
  expect(first?.size).toBe(MAX_SESSION_PREVIEW_BYTES)
  expect(first?.toolStats).toEqual([{ name: "Read", count: 1 }])
  const appended = `${line("New".repeat(200))}\n${usage(50, "2026-09-07T10:02:00Z")}\n`
  await appendFile(session.path, appended)
  reads.length = 0
  const next = await cache.get(session)
  expect(reads).toEqual([[first!.size, first!.size + appended.length]])
  expect(publicView(next)).toEqual(publicView(await new SessionDataCache().get(session)))
  expect(next?.toolStats).toEqual([])
  expect(next?.tokenStats?.outputTokensPerMinute).toBe(30)
  expect(cache.getMemoryStats().estimatedBytes).toBeLessThanOrEqual(MAX_SESSION_CACHE_BYTES)
})

test("entry and message ceilings remain equivalent after repeated appends", async () => {
  const initial = Array.from({ length: 2100 }, (_, i) =>
    i % 2 ? line(`Message ${i}`) : toolLine(`${i}.ts`)
  )
  const session = await fixture(`${initial.join("\n")}\n`)
  const cache = new SessionDataCache()
  await cache.get(session)
  for (let i = 0; i < 5; i++) {
    await appendFile(session.path, `${line(`Next ${i}`)}\n{}\n`)
    const next = await cache.get(session)
    expect(next?.messages).toHaveLength(300)
    expect(publicView(next)).toEqual(publicView(await new SessionDataCache().get(session)))
  }
})

test("fallback timestamps stay stable while new records receive ordered timestamps", async () => {
  const raw = (text: string) => JSON.stringify({ type: "assistant", message: { content: text } })
  const session = await fixture(`${raw("First")}\n`)
  const cache = new SessionDataCache()
  const first = await cache.get(session)
  await appendFile(session.path, raw("Second"))
  const provisional = await cache.get(session)
  expect(provisional?.messages[0]?.timestamp).toBe(first?.messages[0]?.timestamp)
  expect(Date.parse(provisional!.messages[1]!.timestamp!)).toBeGreaterThan(
    Date.parse(first!.messages[0]!.timestamp!)
  )
  await appendFile(session.path, "\n")
  expect((await cache.get(session))?.messages).toEqual(provisional?.messages)
})

test("replacement with equal size and mtime cannot reuse the previous inode", async () => {
  const session = await fixture(`${line("Old")}\n`)
  const replacement = await fixture(`${line("New")}\n`)
  const cache = new SessionDataCache((path) => {
    const file = Bun.file(path)
    return new Proxy(file, {
      get(target, property) {
        if (property === "stat") return async () => ({ ...(await target.stat()), mtimeMs: 1234 })
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
  expect((await cache.get(session))?.messages[0]?.text).toBe("Old")
  await rename(replacement.path, session.path)
  expect((await cache.get(session))?.messages[0]?.text).toBe("New")
})

test("growth after stat is read exactly once in the following poll", async () => {
  const session = await fixture(`${line("First")}\n`)
  let grow = true
  const cache = new SessionDataCache((path) => {
    const file = Bun.file(path)
    return new Proxy(file, {
      get(target, property) {
        if (property === "stat")
          return async () => {
            const info = await target.stat()
            if (grow) {
              grow = false
              await appendFile(path, `${line("Second")}\n`)
            }
            return info
          }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
  expect((await cache.get(session))?.messages.map((message) => message.text)).toEqual(["First"])
  const next = await cache.get(session)
  expect(next?.messages.map((message) => message.text)).toEqual(["First", "Second"])
  expect(await cache.get(session)).toBe(next)
})

test("truncation and same-size rewrite each rebuild once", async () => {
  const session = await fixture(`${line("Old")}\n${line("Older")}\n`)
  const { cache, reads } = measuredCache()
  await cache.get(session)
  await Bun.write(session.path, `${line("New")}\n`)
  reads.length = 0
  const truncated = await cache.get(session)
  expect(reads).toEqual([[0, truncated!.size]])
  expect(truncated?.messages.map((message) => message.text)).toEqual(["New"])
  await Bun.write(session.path, `${line("Now")}\n`)
  reads.length = 0
  const rewritten = await cache.get(session)
  expect(reads).toEqual([[0, rewritten!.size]])
  expect(rewritten?.messages.map((message) => message.text)).toEqual(["Now"])
  expect(await cache.get(session)).toBe(rewritten)
})

test("losing file identity forces a cold read instead of a hot hit", async () => {
  const session = await fixture(`${line("First")}\n`)
  let identity = true
  let reads = 0
  const cache = new SessionDataCache((path) => {
    const file = Bun.file(path)
    return new Proxy(file, {
      get(target, property) {
        if (property === "stat")
          return async () => ({
            ...(await target.stat()),
            ...(identity ? {} : { dev: undefined, ino: undefined }),
          })
        if (property === "slice")
          return (start: number, end: number) => {
            reads++
            return target.slice(start, end)
          }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
  const first = await cache.get(session)
  identity = false
  expect(await cache.get(session)).not.toBe(first)
  expect(reads).toBe(2)
})

test("clipped unfinished records cannot become invented complete records", async () => {
  const session = await fixture("x".repeat(MAX_SESSION_PREVIEW_BYTES + 10))
  const cache = new SessionDataCache()
  expect((await cache.get(session))?.messages).toEqual([])
  await appendFile(session.path, `${line("Not a record boundary")}\n${line("Real record")}\n`)
  const next = await cache.get(session)
  expect(next?.messages.map((message) => message.text)).toEqual(["Real record"])
  expect(publicView(next)).toEqual(publicView(await new SessionDataCache().get(session)))
})

test("malformed JSON, blank lines and invalid UTF-8 retain byte-correct window positions", async () => {
  const session = await fixture(`${line("First")}\n`)
  const { cache, reads } = measuredCache()
  const first = await cache.get(session)
  const encoder = new TextEncoder()
  const before = encoder.encode('not-json\n\n{"ignored":"')
  const after = encoder.encode(`"}\n${line("Second")}\n`)
  const bytes = new Uint8Array([...before, 0xff, ...after])
  await appendFile(session.path, bytes)
  reads.length = 0
  const next = await cache.get(session)
  expect(reads).toEqual([[first!.size, first!.size + bytes.length]])
  expect(publicView(next)).toEqual(publicView(await new SessionDataCache().get(session)))
})

test("token endpoints preserve malformed timestamp behavior and provisional replacement", async () => {
  const session = {
    ...(await fixture(`${usage(10, "bad-date")}\n${usage(20, "2026-09-07T10:01:00Z")}\n`)),
    format: "codex-jsonl" as const,
  }
  const cache = new SessionDataCache()
  await cache.get(session)
  await appendFile(session.path, usage(30, "bad-date"))
  const provisional = await cache.get(session)
  expect(publicView(provisional)).toEqual(publicView(await new SessionDataCache().get(session)))
  await appendFile(session.path, `\n${usage(40, "2026-09-07T10:02:00Z")}\n`)
  expect(publicView(await cache.get(session))).toEqual(
    publicView(await new SessionDataCache().get(session))
  )
})

test("stateful Antigravity keeps its bounded cold parser", async () => {
  const initial = JSON.stringify({
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    step_index: 1,
    created_at: "2026-09-07T10:00:00Z",
    content: "Working",
    tool_calls: [{ name: "Read", args: { file_path: "file.ts" } }],
  })
  const session = { ...(await fixture(`${initial}\n`)), format: "antigravity-jsonl" as const }
  const { cache, reads } = measuredCache()
  await cache.get(session)
  await appendFile(
    session.path,
    `${JSON.stringify({ source: "MODEL", type: "TOOL_RESULT", created_at: "2026-09-07T10:01:00Z", content: "Done" })}\n`
  )
  reads.length = 0
  const next = await cache.get(session)
  expect(reads).toEqual([[0, next!.size]])
  expect(publicView(next)).toEqual(publicView(await new SessionDataCache().get(session)))
})

test("simultaneous format requests never coalesce into the wrong parser", async () => {
  const session = await fixture(`${line("Claude")}\n`)
  const cache = new SessionDataCache()
  const [claude, codex] = await Promise.all([
    cache.get(session),
    cache.get({ ...session, format: "codex-jsonl" }),
  ])
  expect(claude?.messages).toHaveLength(1)
  expect(codex?.messages).toEqual([])
})

test("overlapping callers share two read slots and release failures", async () => {
  const sessions = await Promise.all(
    Array.from({ length: 40 }, (_, i) => fixture(`${line(`Message ${i}`)}\n`))
  )
  const ready = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let active = 0
  let maxActive = 0
  let started = 0
  const cache = new SessionDataCache((path) => {
    const file = Bun.file(path)
    return new Proxy(file, {
      get(target, property) {
        if (property === "slice")
          return (start: number, end: number) => {
            const slice = target.slice(start, end)
            return new Proxy(slice, {
              get(blob, key) {
                if (key === "arrayBuffer")
                  return async () => {
                    active++
                    started++
                    maxActive = Math.max(maxActive, active)
                    if (started === 2) ready.resolve()
                    try {
                      await gate.promise
                      if (path === sessions[0]!.path) throw new Error("fixture read failure")
                      return await blob.arrayBuffer()
                    } finally {
                      active--
                    }
                  }
                const value = Reflect.get(blob, key, blob)
                return typeof value === "function" ? value.bind(blob) : value
              },
            })
          }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  })
  const first = sessions.map((session) => cache.get(session))
  const second = sessions.map((session) => cache.get(session))
  await ready.promise
  expect(started).toBe(2)
  expect(active).toBe(2)
  gate.resolve()
  const results = await Promise.all(first)
  const coalesced = await Promise.all(second)
  expect(results[0]).toBeNull()
  expect(maxActive).toBe(2)
  expect(started).toBe(40)
  expect(active).toBe(0)
  for (let i = 1; i < 40; i++) {
    expect(results[i]?.messages[0]?.text).toBe(`Message ${i}`)
    expect(coalesced[i]).toBe(results[i])
  }
})
