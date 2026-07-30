import { join } from "node:path"
import { z } from "zod"

export interface DiscoveredCodexHook {
  sourcePath: string
  source: string
  isManaged: boolean
  pluginId: string | null
}

const discoveredCodexHookSchema = z.looseObject({
  sourcePath: z.string(),
  source: z.string(),
  isManaged: z.boolean().optional(),
  pluginId: z.string().nullable().optional(),
})

const hooksListResponseSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        hooks: z.array(discoveredCodexHookSchema).optional(),
      })
    )
    .optional(),
})

const hooksListEnvelopeSchema = z.looseObject({
  id: z.literal(1),
  result: hooksListResponseSchema.optional(),
})

type HooksListResponse = z.infer<typeof hooksListResponseSchema>

const HOOK_DISCOVERY_TIMEOUT_MS = 8_000

function parseHooksListLine(line: string): {
  matched: boolean
  response: HooksListResponse | null
} {
  try {
    const parsed = hooksListEnvelopeSchema.safeParse(JSON.parse(line))
    return parsed.success
      ? { matched: true, response: parsed.data.result ?? null }
      : { matched: false, response: null }
  } catch {
    return { matched: false, response: null }
  }
}

function parseCompleteHooksListLines(buffer: string): {
  remaining: string
  matched: boolean
  response: HooksListResponse | null
} {
  let remaining = buffer
  let newlineIndex = remaining.indexOf("\n")

  while (newlineIndex >= 0) {
    const line = remaining.slice(0, newlineIndex).trim()
    remaining = remaining.slice(newlineIndex + 1)
    const parsed = line ? parseHooksListLine(line) : { matched: false, response: null }
    if (parsed.matched) return { ...parsed, remaining }
    newlineIndex = remaining.indexOf("\n")
  }

  return { remaining, matched: false, response: null }
}

async function readHooksListResponse(
  stdout: ReadableStream<Uint8Array>
): Promise<HooksListResponse | null> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parsed = parseCompleteHooksListLines(buffer)
      if (parsed.matched) return parsed.response
      buffer = parsed.remaining
    }
  } finally {
    reader.releaseLock()
  }

  return null
}

function normalizeHooks(response: HooksListResponse | null): DiscoveredCodexHook[] | null {
  if (!response?.data) return null

  const hooks: DiscoveredCodexHook[] = []
  for (const entry of response.data) {
    for (const hook of entry.hooks ?? []) {
      hooks.push({
        sourcePath: hook.sourcePath,
        source: hook.source,
        isManaged: hook.isManaged === true,
        pluginId: typeof hook.pluginId === "string" ? hook.pluginId : null,
      })
    }
  }
  return hooks
}

/**
 * Ask the installed Codex runtime for its effective hook list. This catches
 * managed, plugin, and session sources that cannot be inferred from files
 * alone. Discovery is best-effort because older Codex builds do not expose
 * `hooks/list`, and a sandbox may prevent app-server state initialization.
 */
export async function discoverCodexHooks(
  cwd: string,
  homeDir: string
): Promise<DiscoveredCodexHook[] | null> {
  if (process.env.AI_TEST_NO_BACKEND === "1") return null

  const codexBinary = Bun.which("codex")
  if (!codexBinary) return null
  try {
    return await queryCodexHooks(codexBinary, cwd, homeDir)
  } catch {
    return null
  }
}

async function queryCodexHooks(
  codexBinary: string,
  cwd: string,
  homeDir: string
): Promise<DiscoveredCodexHook[] | null> {
  const proc = Bun.spawn([codexBinary, "app-server", "--stdio"], {
    cwd,
    env: { ...process.env, HOME: homeDir, CODEX_HOME: join(homeDir, ".codex") },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderrPromise = new Response(proc.stderr).text()
  const responsePromise = readHooksListResponse(proc.stdout)
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    const messages = [
      {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "swiz",
            title: "Swiz",
            version: "doctor",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized", params: {} },
      { method: "hooks/list", id: 1, params: { cwds: [cwd] } },
    ]
    await proc.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`)

    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), HOOK_DISCOVERY_TIMEOUT_MS)
    })
    return normalizeHooks(await Promise.race([responsePromise, timeout]))
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    proc.kill("SIGTERM")
    const forceKillId = setTimeout(() => proc.kill("SIGKILL"), 1_000)
    await Promise.allSettled([proc.exited, responsePromise, stderrPromise])
    clearTimeout(forceKillId)
  }
}
