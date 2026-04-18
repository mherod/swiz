import { readProjectSettings } from "../../../settings.ts"
import { buildInvalidSkillResults, findInvalidSkillEntries } from "../fix.ts"
import type { DiagnosticCheck } from "../types.ts"

/**
 * Built-in allowed values for the `category:` frontmatter field in SKILL.md files.
 * Projects can override this list via `allowedSkillCategories` in `.swiz/config.json`.
 */
export const DEFAULT_ALLOWED_SKILL_CATEGORIES: readonly string[] = [
  "automation",
  "code-review",
  "communication",
  "data",
  "deployment",
  "design",
  "development",
  "git",
  "learning",
  "productivity",
  "research",
  "security",
  "testing",
  "uncategorized",
  "workflow",
  "writing",
]

export const invalidSkillEntriesCheck: DiagnosticCheck = {
  name: "invalid-skill-entries",
  async run(ctx) {
    const projectSettings = await readProjectSettings(process.cwd())
    const allowedCategories = new Set(
      projectSettings?.allowedSkillCategories ?? DEFAULT_ALLOWED_SKILL_CATEGORIES
    )
    const entries = await findInvalidSkillEntries(allowedCategories)
    ctx.store.invalidSkillEntries = entries
    return buildInvalidSkillResults(entries)
  },
}
