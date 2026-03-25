import type { DiagnosticCheck } from "../types.ts"
import { whichExists } from "../utils.ts"

export const ghAuthCheck: DiagnosticCheck = {
  name: "gh-auth",
  async run() {
    const ghPath = await whichExists("gh")
    if (!ghPath) {
      return {
        name: "GitHub CLI auth",
        status: "warn",
        detail: "gh not installed — some hooks require it",
      }
    }

    const proc = Bun.spawn(["gh", "auth", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    if (proc.exitCode === 0) {
      const output = (stdout + stderr).trim()
      const accountMatch = output.match(/Logged in to .+ account (\S+)/)
      const account = accountMatch?.[1] ?? "authenticated"
      return { name: "GitHub CLI auth", status: "pass", detail: account }
    }

    return {
      name: "GitHub CLI auth",
      status: "fail",
      detail: "not authenticated — run: gh auth login",
    }
  },
}
