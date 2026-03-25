import type { DiagnosticCheck } from "../types.ts"

export const bunRuntimeCheck: DiagnosticCheck = {
  name: "bun-runtime",
  async run() {
    return {
      name: "Bun runtime",
      status: "pass",
      detail: `v${Bun.version}`,
    }
  },
}
