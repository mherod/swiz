import type { CheckResult, DiagnosticCheck } from "../types.ts"

async function readCodexFeatures(): Promise<string | null> {
  const binary = Bun.which("codex")
  if (!binary) return null
  const proc = Bun.spawn([binary, "features", "list"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error("Codex feature inspection failed")
  return stdout
}

export async function checkCodexMemory(
  readFeatures: () => Promise<string | null> = readCodexFeatures
): Promise<CheckResult> {
  const name = "Codex project memory ownership"
  try {
    const features = await readFeatures()
    if (features === null) return { name, status: "pass", detail: "Codex is not installed" }
    const state = features.match(/^memories\s+.+?\s+(true|false)\s*$/m)?.[1]
    if (state === "false") {
      return {
        name,
        status: "pass",
        detail:
          "Native global memory disabled for new sessions. Verify fresh-session repository lookup before retiring external records; existing conversations retain their injected instructions.",
      }
    }
    if (state === "true") {
      return {
        name,
        status: "warn",
        detail:
          "Codex native memory is enabled and may inject global storage instructions. For repository-owned memory, back up the Codex config, run `codex features disable memories`, then start a fresh session and verify its instructions. This disables native global memory; it does not migrate or delete records. Use `swiz memory migrate --source <external-memory-directory> --manifest <private-plan.json>` to inventory records. Swiz cannot override an active host instruction.",
      }
    }
    return {
      name,
      status: "warn",
      detail:
        "This Codex version did not report the memories feature. Inspect host memory policy before migration; do not assume external storage is disabled.",
    }
  } catch {
    return {
      name,
      status: "warn",
      detail:
        "Could not inspect Codex memory policy. Run `codex features list` and inspect the active session's storage instructions before migration.",
    }
  }
}

export const codexMemoryCheck: DiagnosticCheck = {
  name: "codex-memory",
  run: () => checkCodexMemory(),
}
