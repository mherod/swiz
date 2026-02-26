// Utility for invoking the Cursor Agent CLI in non-interactive (headless) mode.
//
//   agent — Cursor Agent  (agent --print --mode ask --trust --workspace <dir> <prompt>)
//
// promptOnly mode (used by stop-auto-continue):
//   agent: --workspace <tmpdir>  — no project files to read

import { tmpdir } from "node:os";

export type AgentBackend = "agent";

/**
 * Return "agent" if the Cursor Agent CLI is installed, null otherwise.
 */
export function detectAgentCli(): AgentBackend | null {
  return Bun.which("agent") ? "agent" : null;
}

export interface PromptAgentOptions {
  /**
   * When true, runs agent with --workspace <tmpdir> so it has no access
   * to the current project's files — prompt-only Q&A mode.
   */
  promptOnly?: boolean;
  /** When provided, kills the spawned process if the signal aborts. */
  signal?: AbortSignal;
  /**
   * Per-call timeout in milliseconds. Creates an internal AbortController
   * that fires after this many ms. Ignored if `signal` is also provided.
   */
  timeout?: number;
}

/**
 * Send a prompt to the Cursor Agent CLI and return the trimmed output.
 * Throws if agent is not installed or the process exits non-zero.
 */
export async function promptAgent(prompt: string, options?: PromptAgentOptions): Promise<string> {
  if (!detectAgentCli()) {
    throw new Error("Cursor Agent not found. Install it via the Cursor IDE.");
  }

  const args = [
    "agent", "--print", "--mode", "ask", "--trust",
    ...(options?.promptOnly ? ["--workspace", tmpdir()] : []),
    prompt,
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  // Resolve the abort signal — caller-supplied takes precedence; otherwise
  // create an internal one from timeout if provided.
  let signal = options?.signal;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (!signal && options?.timeout) {
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), options.timeout).unref();
    signal = controller.signal;
  }

  if (signal) {
    const onAbort = () => {
      proc.kill();
      setTimeout(() => proc.kill(9), 2_000).unref();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      proc.exited.then(() => {
        signal!.removeEventListener("abort", onAbort);
        clearTimeout(timeoutHandle);
      });
    }
  }

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`agent exited ${proc.exitCode}: ${err.trim()}`);
  }

  return output.trim();
}
