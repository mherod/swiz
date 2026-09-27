import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { evaluatePretooluseConcurrentSessionEdits } from "../../hooks/pretooluse-concurrent-session-edits.ts"
import { manageFileOwnership } from "../file-ownership-tool.ts"
import { getIssueStore, resetIssueStore } from "../issue-store.ts"
import { mcpCallerCwdRegistry } from "../mcp-caller-cwd.ts"
import { mcpToolResultSchema, runMcpTool } from "../mcp-tool-core.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { canonicalClaimPath } from "../session-file-claims.ts"
import { resolveSessionFileOwnershipResult } from "../utils/session-file-ownership.ts"
import { acquireEnvLock, releaseEnvLockFn, runGit, useTempDir } from "../utils/test-utils.ts"
import { handleMcpToolRoute } from "./daemon/mcp-tool-routes.ts"
import {
  executeMcpTool,
  executeProjectTool,
  registerFileOwnershipTool,
  resetMcpToolDaemonBackoff,
} from "./mcp.ts"

const tmp = useTempDir("swiz-file-ownership-")
let cwd: string
let dbPath: string
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
let originalNoDaemon: string | undefined

beforeEach(async () => {
  await acquireEnvLock()
  cwd = canonicalClaimPath(await tmp.create())
  dbPath = join(await tmp.create(), "issues.db")
  resetIssueStore()
  getIssueStore(dbPath)
  originalNoDaemon = process.env.SWIZ_NO_DAEMON
  delete process.env.SWIZ_NO_DAEMON
  resetMcpToolDaemonBackoff()
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Daemon unavailable")
      },
      { preconnect() {} }
    )
  )
})

afterEach(() => {
  fetchSpy.mockRestore()
  resetIssueStore()
  resetMcpToolDaemonBackoff()
  if (originalNoDaemon === undefined) delete process.env.SWIZ_NO_DAEMON
  else process.env.SWIZ_NO_DAEMON = originalNoDaemon
  releaseEnvLockFn()
})

function call(
  action: string,
  sessionId = "session-a",
  paths = ["file.ts"],
  extra = {},
  now = 1000
) {
  return manageFileOwnership({ action, sessionId, paths, ...extra }, cwd, now)
}

describe("FileOwnership leases", () => {
  test("claims exact canonical files without inventing edit records", () => {
    const result = call("claim", "session-a", ["src/../file.ts", join(cwd, "file.ts")], {
      lane: "api",
    })
    expect(result.claims).toHaveLength(1)
    expect(result.claims[0]).toMatchObject({
      file_path: join(cwd, "file.ts"),
      session_id: "session-a",
      lane: "api",
      expires_at: 1801000,
    })
    expect(result.recentEdits).toEqual([])
    expect(getIssueStore().listSessionEdits(projectKeyFromCwd(cwd), "session-a")).toEqual([])
  })

  test("rejects peer claims and releases atomically across a batch", () => {
    call("claim", "session-a", ["a.ts"])
    call("claim", "session-b", ["b.ts"])
    for (const action of ["claim", "hold", "release"]) {
      const result = call(action, "session-a", ["a.ts", "b.ts", "c.ts"])
      expect(result.ok).toBe(false)
      expect(result.conflicts[0]?.session_id).toBe("session-b")
      expect(manageFileOwnership({}, cwd, 1000).claims.map((claim) => claim.file_path)).toEqual([
        join(cwd, "a.ts"),
        join(cwd, "b.ts"),
      ])
    }
  })

  test("renews only owned active holds and allows takeover after expiry", () => {
    call("claim", "session-a", ["file.ts"], { leaseSeconds: 60, lane: "api" })
    const renewed = call("hold", "session-a", ["file.ts"], { leaseSeconds: 60 }, 30000)
    expect(renewed.claims[0]).toMatchObject({ claimed_at: 1000, expires_at: 90000, lane: "api" })
    expect(call("claim", "session-b", ["file.ts"], {}, 89999).ok).toBe(false)
    expect(call("hold", "session-a", ["file.ts"], {}, 90000).missing).toEqual([
      join(cwd, "file.ts"),
    ])
    expect(manageFileOwnership({}, cwd, 90000).claims).toEqual([])
    expect(call("claim", "session-b", ["file.ts"], {}, 90000).claims[0]?.session_id).toBe(
      "session-b"
    )
  })

  test("release is idempotent and preserves edit history for handoff", () => {
    call("claim")
    getIssueStore().recordSessionEdit(
      projectKeyFromCwd(cwd),
      "session-a",
      join(cwd, "file.ts"),
      1000
    )
    expect(call("release").released).toEqual([join(cwd, "file.ts")])
    expect(call("release").released).toEqual([])
    expect(call("claim", "session-b").recentEdits[0]?.session_id).toBe("session-a")
  })

  test("does not mutate on invalid identities, paths or lease lengths", async () => {
    for (const input of [
      { action: "claim", paths: ["file.ts"] },
      { action: "release", sessionId: "a" },
      { action: "claim", sessionId: " " },
      { action: "force" },
      ...[[], ["../escape.ts"], [cwd], ["*.ts"], [" "]].map((paths) => ({
        action: "claim",
        sessionId: "a",
        paths,
      })),
      { action: "claim", sessionId: "a", paths: ["file.ts"], leaseSeconds: 0 },
      { action: "claim", sessionId: "a", paths: ["file.ts"], leaseSeconds: 7201 },
      { action: "release", sessionId: "a", paths: ["file.ts"], force: true },
    ]) {
      expect((await runMcpTool("FileOwnership", input, cwd)).isError).toBe(true)
    }
    expect(manageFileOwnership({}, cwd).claims).toEqual([])
  })

  test("normalises symlink aliases and rejects paths escaping through them", async () => {
    await Bun.write(join(cwd, "file.ts"), "original")
    symlinkSync(join(cwd, "file.ts"), join(cwd, "alias.ts"))
    call("claim")
    expect(call("claim", "session-b", ["alias.ts"]).ok).toBe(false)
    const outside = await tmp.create()
    symlinkSync(outside, join(cwd, "outside"))
    expect(() => call("claim", "session-b", ["valid.ts", "outside/new.ts"])).toThrow("outside")
    expect(manageFileOwnership({}, cwd, 1000).claims).toHaveLength(1)
    expect(manageFileOwnership({}, outside, 1000).claims).toEqual([])
  })

  test("competing processes cannot both acquire the same file", async () => {
    const modulePath = join(import.meta.dir, "../issue-store.ts")
    const source = `import { IssueStore } from ${JSON.stringify(modulePath)};
      const store = new IssueStore(process.argv[1]);
      const result = store.fileClaims.mutate({projectKey:"race",sessionId:process.argv[2],paths:["shared.ts"],action:"claim",leaseMs:60000,now:1000});
      store.close(); process.stdout.write(JSON.stringify(result));`
    const results = await Promise.all(
      ["a", "b"].map(async (session) => {
        const proc = Bun.spawn([process.execPath, "-e", source, dbPath, session], {
          cwd,
          env: { ...process.env, HOME: cwd, AI_TEST_NO_BACKEND: "1" },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ])
        await proc.exited
        expect(stderr).toBe("")
        expect(proc.exitCode).toBe(0)
        return JSON.parse(stdout) as { ok: boolean }
      })
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })
})

describe("FileOwnership integration", () => {
  test("feeds explicit claims into edit guards and dirty-file ownership", async () => {
    await runGit(cwd, ["init"])
    await Bun.write(join(cwd, "file.ts"), "work")
    call("claim")
    const input = {
      cwd,
      session_id: "session-b",
      tool_name: "Edit",
      tool_input: { file_path: join(cwd, "file.ts") },
    }
    const denied = await evaluatePretooluseConcurrentSessionEdits(input, 1000)
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(
      await evaluatePretooluseConcurrentSessionEdits({ ...input, session_id: "session-a" }, 1000)
    ).toEqual({})
    expect(
      await resolveSessionFileOwnershipResult(cwd, "session-b", ["file.ts"], 1000)
    ).toMatchObject({ known: true, ownership: { editedByOthers: ["file.ts"] } })
    call("release")
    expect(await evaluatePretooluseConcurrentSessionEdits(input, 1000)).toEqual({})
    expect(
      await resolveSessionFileOwnershipResult(cwd, "session-b", ["file.ts"], 1000)
    ).toMatchObject({ known: true, ownership: { unattributed: ["file.ts"] } })
  })

  test("preserves structured responses over daemon transport and local fallback", async () => {
    const input = { action: "claim", sessionId: "session-a", paths: ["file.ts"] }
    const fallback = await executeMcpTool("FileOwnership", input, cwd)
    expect(fallback.structuredContent?.fileOwnership?.claims).toHaveLength(1)
    resetMcpToolDaemonBackoff()
    fetchSpy.mockImplementation(
      Object.assign(
        async (_url: unknown, init?: RequestInit) =>
          handleMcpToolRoute(new Request("http://localhost/mcp/tool", init)),
        { preconnect() {} }
      )
    )
    const viaDaemon = await executeMcpTool("FileOwnership", {}, cwd)
    expect(
      mcpToolResultSchema.parse(viaDaemon).structuredContent?.fileOwnership?.claims
    ).toHaveLength(1)
    const conflict = await executeMcpTool(
      "FileOwnership",
      { ...input, sessionId: "session-b" },
      cwd
    )
    expect(conflict.isError).toBe(true)
    expect(conflict.structuredContent?.fileOwnership?.conflicts[0]?.session_id).toBe("session-a")
  })

  test("refuses rootless calls unless the caller's project is recovered", async () => {
    expect((await executeProjectTool("FileOwnership", {}, async () => null)).isError).toBe(true)
    const post = () =>
      new Request("http://localhost/mcp/tool", {
        method: "POST",
        body: JSON.stringify({ tool: "FileOwnership", cwd: "/", input: {} }),
      })
    expect((await (await handleMcpToolRoute(post())).json()).isError).toBe(true)
    mcpCallerCwdRegistry.record("mcp__swiz__FileOwnership", {}, cwd, Date.now())
    expect(
      (await (await handleMcpToolRoute(post())).json()).structuredContent.fileOwnership.cwd
    ).toBe(cwd)
  })

  test("advertises and executes the tool through the MCP protocol", async () => {
    process.env.SWIZ_NO_DAEMON = "1"
    const server = new McpServer({ name: "test", version: "0" })
    const client = new Client({ name: "test", version: "0" })
    registerFileOwnershipTool(server, cwd)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const { tools } = await client.listTools()
      expect(tools[0]?.name).toBe("FileOwnership")
      expect(tools[0]?.annotations?.readOnlyHint).toBe(false)
      const result = await client.callTool({
        name: "FileOwnership",
        arguments: { action: "claim", sessionId: "session-a", paths: ["file.ts"] },
      })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).toMatchObject({
        fileOwnership: { ok: true, action: "claim" },
      })
      const invalid = await client.callTool({
        name: "FileOwnership",
        arguments: { action: "release" },
      })
      expect(invalid.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})
