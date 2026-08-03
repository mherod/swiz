import { type GateRequiredSkill, listGateRequiredSkills } from "../../../gate-required-skills.ts"
import { skillFileExists } from "../../../skill-utils.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

export type GateSkillExists = (name: string) => boolean

function formatMissingSkill(entry: GateRequiredSkill): string {
  return `${entry.name} (${entry.hooks.join(", ")})`
}

export function evaluateGateRequiredSkills(
  skillExists: GateSkillExists = skillFileExists
): CheckResult {
  const required = listGateRequiredSkills()
  const missing = required.filter((entry) => !skillExists(entry.name))

  if (missing.length === 0) {
    return {
      name: "Gate-required skills",
      status: "pass",
      detail: `all ${required.length} fail-open gate requirements resolve to installed skills`,
    }
  }

  return {
    name: "Gate-required skills",
    status: "warn",
    detail:
      `${missing.length} missing: ${missing.map(formatMissingSkill).join("; ")} — ` +
      "install each skill or remove its owning gate rule",
  }
}

export const gateRequiredSkillsCheck: DiagnosticCheck = {
  name: "gate-required-skills",
  async run() {
    return evaluateGateRequiredSkills()
  },
}
