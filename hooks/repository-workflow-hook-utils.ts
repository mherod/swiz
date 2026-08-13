import type { ToolHookInput } from "../src/schemas.ts"

export interface RepositoryWorkflowHookContext {
  command: string
  cwd: string
  toolName: string
  transcriptPath: string
}

export function parseAssistantContent(line: string): unknown[] | null {
  if (!line.trim()) return null
  try {
    const entry = JSON.parse(line) as Record<string, any>
    if (entry?.type !== "assistant") return null
    return Array.isArray(entry.message?.content) ? entry.message.content : null
  } catch {
    return null
  }
}

export function getRepositoryWorkflowHookContext(
  hookInput: ToolHookInput
): RepositoryWorkflowHookContext {
  return {
    command: String((hookInput.tool_input as Record<string, any>)?.command ?? "").normalize("NFKC"),
    cwd: hookInput.cwd ?? process.cwd(),
    toolName: hookInput.tool_name ?? "",
    transcriptPath: hookInput.transcript_path ?? "",
  }
}
