import { buildInvalidSkillResults, findInvalidSkillEntries } from "../fix.ts"
import type { DiagnosticCheck } from "../types.ts"

export const invalidSkillEntriesCheck: DiagnosticCheck = {
  name: "invalid-skill-entries",
  async run(ctx) {
    const entries = await findInvalidSkillEntries()
    ctx.store.invalidSkillEntries = entries
    return buildInvalidSkillResults(entries)
  },
}
