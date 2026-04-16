// Utility for invoking the Cursor Agent CLI in non-interactive (headless) mode.
//
//   agent — Cursor Agent  (agent --print --mode ask --trust --workspace <dir> <prompt>)
//
// promptOnly mode (used by stop-auto-continue):
//   agent: --workspace <tmpdir>  — no project files to read

import { tmpdir } from "node:os"
import type { PromptOptions } from "./ai-providers.ts"

export type AgentBackend = "agent"

export function detectBestAgentCli(): AgentBackend | null {
  return detectAgentCli()
}

/**
 * Return "agent" if the Cursor Agent CLI is installed, null otherwise.
 */
export function detectAgentCli(): AgentBackend | null {
  return Bun.which("agent") ? "agent" : null
}
export interface PromptAgentOptions extends Pick<PromptOptions, "signal" | "timeout"> {
  /**
   * When true, runs agent with --workspace <tmpdir> so it has no access
   * to the current project's files — prompt-only Q&A mode.
   */
  promptOnly?: boolean
}

/**
 * Send a prompt to the best available agent CLI and return the trimmed output.
 */
export async function promptBestAgent(
  prompt: string,
  options?: PromptAgentOptions
): Promise<string> {
  const backend = detectBestAgentCli()
  if (!backend) throw new Error("No agent backend available")
  return promptAgent(prompt, options)
}

/**
 * Send a prompt to the Cursor Agent CLI and return the trimmed output.
 * Throws if agent is not installed or the process exits non-zero.
 */
function attachAbortSignal(
  proc: ReturnType<typeof Bun.spawn>,
  options?: Pick<PromptAgentOptions, "signal" | "timeout">
): void {
  let signal = options?.signal
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  if (!signal && options?.timeout) {
    const controller = new AbortController()
    timeoutHandle = setTimeout(() => controller.abort(), options.timeout).unref()
    signal = controller.signal
  }
  if (!signal) return

  const onAbort = () => {
    proc.kill()
    setTimeout(() => proc.kill(9), 2_000).unref()
  }
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
    void proc.exited.then(() => {
      signal!.removeEventListener("abort", onAbort)
      clearTimeout(timeoutHandle)
    })
  }
}

export async function promptAgent(prompt: string, options?: PromptAgentOptions): Promise<string> {
  if (!detectAgentCli()) {
    throw new Error("Cursor Agent not found. Install it via the Cursor IDE.")
  }

  const args = [
    "agent",
    "--print",
    "--mode",
    "ask",
    "--trust",
    ...(options?.promptOnly ? ["--workspace", tmpdir()] : []),
    prompt,
  ]

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  attachAbortSignal(proc, options)

  const [output, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0) {
    throw new Error(`agent exited ${proc.exitCode}: ${err.trim()}`)
  }
  return output.trim()
}
