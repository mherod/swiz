// Utilities for invoking an AI agent CLI in non-interactive (headless) mode.
//
// Supported backends, checked in priority order:
//   agent  — Cursor Agent  (agent --print --mode ask --trust <prompt>)
//   claude — Claude Code   (claude --print <prompt>)
//   gemini — Gemini CLI    (gemini --prompt <prompt>)

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
   * Override the workspace directory passed to the Cursor agent backend.
   * Use this to restrict the agent to a neutral directory (e.g. os.tmpdir())
   * when the response should be based solely on the prompt content.
   */
  workspace?: string;
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
          ...(options?.workspace ? ["--workspace", options.workspace] : []),
          prompt,
        ]
      : backend === "claude"
      ? ["claude", "--print", prompt]
      : ["gemini", "--prompt", prompt];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${backend} exited ${proc.exitCode}: ${err.trim()}`);
  }

  return output.trim();
}
