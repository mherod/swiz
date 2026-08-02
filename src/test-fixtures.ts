/**
 * Shared test fixtures for creating mock provider sessions.
 *
 * Used by settings.test.ts, transcript-session-gemini.test.ts,
 * and transcript-utils-integration.test.ts.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Create a mock Gemini Antigravity session on disk.
 * Returns the brain directory path.
 */
export async function createAntigravitySession(
  home: string,
  targetDir: string,
  sessionId: string,
  taskText = `This session targets file://${targetDir}`
): Promise<void> {
  const conversationsDir = join(home, ".gemini", "antigravity", "conversations")
  const brainDir = join(home, ".gemini", "antigravity", "brain", sessionId)
  await mkdir(conversationsDir, { recursive: true })
  await mkdir(brainDir, { recursive: true })
  await writeFile(join(conversationsDir, `${sessionId}.pb`), Buffer.from([0x0a, 0x01, 0x00]))
  await writeFile(join(brainDir, "task.md"), `# Task\n${taskText}\n`)
}

/**
 * Create a mock Antigravity CLI JSONL session on disk.
 */
export async function createAntigravityCliSession(
  home: string,
  targetDir: string,
  sessionId: string,
  options: { userMessage?: string; assistantMessage?: string } = {}
): Promise<void> {
  const { userMessage = "Hello from Antigravity CLI session", assistantMessage } = options
  const brainDir = join(home, ".gemini", "antigravity-cli", "brain", sessionId)
  const logsDir = join(brainDir, ".system_generated", "logs")
  await mkdir(logsDir, { recursive: true })
  await Bun.write(join(brainDir, "task.md"), `# Task\nThis session targets file://${targetDir}\n`)

  const lines = [
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: "2026-08-01T21:00:00Z",
      content: `<USER_REQUEST>\n${userMessage}\n</USER_REQUEST>`,
    }),
  ]

  if (assistantMessage) {
    lines.push(
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-08-01T21:00:01Z",
        content: assistantMessage,
      })
    )
  }

  await Bun.write(join(logsDir, "transcript.jsonl"), `${lines.join("\n")}\n`)
}

interface CodexSessionOptions {
  userMessage?: string
  assistantMessage?: string
}

/**
 * Create a mock Codex CLI session on disk.
 * Returns the JSONL file path.
 */
export async function createCodexSession(
  home: string,
  targetDir: string,
  sessionId: string,
  options: CodexSessionOptions = {}
): Promise<string> {
  const { userMessage = "Hello from Codex session", assistantMessage } = options
  const codexDir = join(home, ".codex", "sessions", "2026", "03", "05")
  await mkdir(codexDir, { recursive: true })
  const filePath = join(codexDir, `rollout-2026-03-05T10-00-00-${sessionId}.jsonl`)

  const lines = [
    JSON.stringify({
      timestamp: "2026-03-05T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: "2026-03-05T10:00:00.000Z",
        cwd: targetDir,
        originator: "codex_cli_rs",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-05T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: userMessage,
      },
    }),
  ]

  if (assistantMessage) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-03-05T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: assistantMessage }],
        },
      })
    )
  }

  await writeFile(filePath, `${lines.join("\n")}\n`)
  return filePath
}
