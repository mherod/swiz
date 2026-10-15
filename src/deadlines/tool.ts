import type { McpToolInput, McpToolResult } from "../mcp-tool-core.ts"
import { type Deadline, type DeadlineInput, deadlineInputSchema, renderDeadline } from "./model.ts"
import { DeadlineStore, deadlineSessionKey } from "./store.ts"

/** Both MCP transports validate here; no daemon-only behaviour or inferred session identity. */
export async function runDeadlineTool(raw: McpToolInput, cwd: string): Promise<McpToolResult> {
  const input = deadlineInputSchema.parse(raw)
  const readOnly = input.action === "get" || input.action === "list"
  const store = await DeadlineStore.open(undefined, !readOnly)
  try {
    const now = Date.now()
    const deadlines = selectDeadlines(input, store, cwd, now)
    const shown = deadlines.slice(0, 20)
    const history = input.action === "get" ? store!.history(input.deadlineId!) : undefined
    const summary = [
      `Deadline ${input.action}; checked ${new Date(now).toISOString()}.`,
      ...shown.map(
        (item) => `${renderDeadline(item, now)}\nCompletion: ${item.completionCriteria}`
      ),
      ...(deadlines.length ? [] : ["No deadlines attached to this session."]),
      ...(deadlines.length > shown.length
        ? [`${deadlines.length - shown.length} more deadlines; query an ID for details.`]
        : []),
      ...(history
        ? [
            "History (latest 50 revisions):",
            ...history.map(
              (item) =>
                `r${item.deadline.revision} ${item.deadline.updatedAt}: due ${item.deadline.dueAt}; ${item.reason}`
            ),
          ]
        : []),
      "Advisory only. Expiry does not stop tools or complete work; task completion does not complete a parent delivery deadline.",
    ].join("\n")
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        summary,
        deadlines: shown,
        ...(history ? { deadlineHistory: history } : {}),
      },
    }
  } finally {
    store?.close()
  }
}

function selectDeadlines(
  input: DeadlineInput,
  store: DeadlineStore | null,
  cwd: string,
  now: number
): Deadline[] {
  if (input.action === "list")
    return store?.list(deadlineSessionKey(cwd, input.sessionId, input.agentId)) ?? []
  if (input.action === "get") {
    if (!input.deadlineId) throw new Error("get requires deadlineId")
    if (!store) throw new Error("Deadline not found")
    return [store.get(input.deadlineId)]
  }
  return [store!.mutate(input, cwd, now)]
}
