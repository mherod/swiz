/**
 * MCP tool route for the daemon web server.
 *
 * The `swiz mcp` stdio server forwards its tool calls here (daemon-first with
 * in-process fallback — see src/commands/mcp.ts) so long-lived MCP processes
 * always execute current code: lefthook restarts the daemon on every commit,
 * while the stdio transport lives as long as the agent session.
 */

import { z } from "zod"
import { mcpToolNameSchema, runMcpTool } from "../../mcp-tool-core.ts"

const mcpToolRequestSchema = z.object({
  tool: mcpToolNameSchema,
  cwd: z.string().min(1),
  input: z.looseObject({}).optional(),
})

export async function handleMcpToolRoute(req: Request): Promise<Response> {
  const parsed = mcpToolRequestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "body"))),
    ].join(", ")
    return Response.json({ error: `Invalid mcp tool request: ${fields}` }, { status: 400 })
  }
  const { tool, cwd, input } = parsed.data
  const result = await runMcpTool(tool, input ?? {}, cwd)
  return Response.json(result)
}
