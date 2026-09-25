/**
 * MCP tool route for the daemon web server.
 *
 * The `swiz mcp` stdio server forwards its tool calls here (daemon-first with
 * in-process fallback — see src/commands/mcp.ts) so long-lived MCP processes
 * always execute current code: lefthook restarts the daemon on every commit,
 * while the stdio transport lives as long as the agent session.
 */

import { z } from "zod"
import { mcpCallerCwdRegistry } from "../../mcp-caller-cwd.ts"
import { unresolvedMcpCwdMessage } from "../../mcp-cwd.ts"
import {
  type McpToolInput,
  type McpToolName,
  mcpToolNameSchema,
  runMcpTool,
} from "../../mcp-tool-core.ts"

const mcpToolRequestSchema = z.object({
  tool: mcpToolNameSchema,
  cwd: z.string().min(1),
  input: z.looseObject({}).optional(),
})

/** Tools whose store is keyed by project; they must never fall back to the shared "-" key. */
const PROJECT_TOOLS: ReadonlySet<McpToolName> = new Set(["TaskCreate", "TaskUpdate", "TaskList"])

/**
 * A stdio server started from "/" (the Claude desktop app) has no project of its own. Recover
 * the caller's cwd from the PreToolUse hook Claude Code dispatched for this call (#955); a task
 * tool with no match is refused rather than written to the store every desktop session shares.
 */
export function resolveMcpRequestCwd(
  tool: McpToolName,
  input: McpToolInput | undefined,
  cwd: string,
  now = Date.now()
): string | null {
  if (cwd !== "/") return cwd
  const caller = mcpCallerCwdRegistry.claim(tool, input, now)
  if (caller) return caller
  return PROJECT_TOOLS.has(tool) ? null : cwd
}

export async function handleMcpToolRoute(req: Request): Promise<Response> {
  const parsed = mcpToolRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "body"))),
    ].join(", ")
    return Response.json({ error: `Invalid mcp tool request: ${fields}` }, { status: 400 })
  }
  const { tool, input } = parsed.data
  const cwd = resolveMcpRequestCwd(tool, input, parsed.data.cwd)
  if (!cwd) {
    return Response.json({
      content: [{ type: "text", text: unresolvedMcpCwdMessage(tool) }],
      isError: true,
    })
  }
  const result = await runMcpTool(tool, input ?? {}, cwd)
  return Response.json(result)
}
