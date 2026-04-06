import type { AgentDef } from "../../agents.ts"

export interface InstallRunOptions {
  jsonOutput: boolean
  dryRun: boolean
  uninstall: boolean
  mergeTool: boolean
  statusLine: boolean
  daemon: boolean
  daemonPort: number
  targets: AgentDef[]
}
