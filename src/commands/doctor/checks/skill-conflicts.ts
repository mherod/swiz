import { buildSkillConflictResults, findSkillConflicts } from "../fix.ts"
import type { DiagnosticCheck } from "../types.ts"

export const skillConflictsCheck: DiagnosticCheck = {
  name: "skill-conflicts",
  async run(ctx) {
    const conflicts = await findSkillConflicts()
    ctx.store.skillConflicts = conflicts
    return buildSkillConflictResults(conflicts)
  },
}
