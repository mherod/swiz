// Utilities for invoking an AI agent CLI in non-interactive (headless) mode.
//
// Supported backends, checked in priority order:
//   agent  — Cursor Agent  (agent --print --mode ask --trust --workspace <dir> <prompt>)
//   claude — Claude Code   (claude --print --tools "" <prompt>)
//   gemini — Gemini CLI    (gemini --prompt --approval-mode plan <prompt>)
//
// promptOnly mode (used by stop-auto-continue):
//   agent:  --workspace tmpdir()  — no project files to read
//   claude: --tools ""            — all tools disabled
//   gemini: --approval-mode plan  — read-only mode

import { tmpdir } from "node:os";

export type AgentBackend = "agent" | "claude" | "gemini";

/**
 * Return the first available agent CLI backend, or null if none is installed.
 */
export function detectAgentCli(): AgentBackend | null {
  if (Bun.which("agent")) return "agent";
  if (Bun.which("claude")) return "claude";
  if (Bun.which("gemini")) return "gemini";
  return null;
}

export interface PromptAgentOptions {
  /**
   * When true, restricts the agent to respond based solely on the prompt
   * content — no codebase or tool access. Per-backend implementation:
   *   agent:  --workspace <tmpdir>  (no project files available)
   *   claude: --tools ""            (all tools disabled)
   *   gemini: --approval-mode plan  (read-only mode)
   */
  promptOnly?: boolean;
  /** When provided, kills the spawned process if the signal aborts. */
  signal?: AbortSignal;
}

/**
 * Send a prompt to the first available agent CLI and return the trimmed output.
 * Throws if no backend is found or the process exits non-zero.
 */
export async function promptAgent(prompt: string, options?: PromptAgentOptions): Promise<string> {
  const backend = detectAgentCli();
  if (!backend) {
    throw new Error(
      "No AI backend found. Install one of: Cursor Agent (agent), Claude Code (claude), or Gemini CLI (gemini)."
    );
  }

  const args: string[] =
    backend === "agent"
      ? [
          "agent", "--print", "--mode", "ask", "--trust",
          ...(options?.promptOnly ? ["--workspace", tmpdir()] : []),
          prompt,
        ]
      : backend === "claude"
      ? [
          "claude", "--print",
          ...(options?.promptOnly ? ["--tools", ""] : []),
          prompt,
        ]
      : [
          "gemini",
          ...(options?.promptOnly ? ["--approval-mode", "plan"] : []),
          "--prompt", prompt,
        ];

  // Strip CLAUDECODE so the spawned CLI accepts nested invocations from inside a session.
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: cleanEnv });

  if (options?.signal) {
    const onAbort = () => {
      proc.kill();
      setTimeout(() => proc.kill(9), 2_000).unref();
    };
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      proc.exited.then(() => options.signal!.removeEventListener("abort", onAbort));
    }
  }

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${backend} exited ${proc.exitCode}: ${err.trim()}`);
  }

  return output.trim();
}
