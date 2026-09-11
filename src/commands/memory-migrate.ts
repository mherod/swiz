import { resolve } from "node:path"
import {
  inventoryMemories,
  type MigrationStatus,
  memoryMigrationSchema,
  migrateMemories,
} from "../memory-migration.ts"
import { type ValidateMemoryWrite, validateMigrationWrite } from "../memory-migration-validation.ts"

type MigrationMode = "plan" | "apply" | "verify"
interface ParsedMigrationArgs {
  source: string | undefined
  manifest: string
  mode: MigrationMode
}

function parseMigrationArgs(args: string[]): ParsedMigrationArgs {
  let source: string | undefined
  let manifest = ""
  let mode: MigrationMode = "plan"
  const queue = [...args]
  const setMode = (nextMode: Exclude<MigrationMode, "plan">): void => {
    if (mode !== "plan") throw new Error("Choose either --apply or --verify")
    mode = nextMode
  }
  const readPath = (arg: "--source" | "--manifest"): void => {
    const value = queue.shift()
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
    if (arg === "--source") source = resolve(value)
    else manifest = resolve(value)
  }

  const actionByArg: Record<string, () => void> = {
    "--source": () => readPath("--source"),
    "--manifest": () => readPath("--manifest"),
    "--apply": () => setMode("apply"),
    "--verify": () => setMode("verify"),
  }

  while (queue.length) {
    const arg = queue.shift()
    if (arg === undefined) break
    const handler = actionByArg[arg]
    if (!handler) throw new Error(`Unknown migration argument: ${arg}`)
    handler()
  }
  if (!manifest)
    throw new Error(
      "Use swiz memory migrate --manifest <private-plan.json> [--source <external-memory-directory> | --apply | --verify]"
    )
  if (source && mode !== "plan") throw new Error("Inventory is separate from --apply and --verify")
  return { source, manifest, mode }
}

export async function runMemoryMigration(
  args: string[],
  validate: ValidateMemoryWrite = validateMigrationWrite
): Promise<string> {
  const { source, manifest, mode } = parseMigrationArgs(args)
  if (source) {
    if (await Bun.file(manifest).exists())
      throw new Error("Manifest already exists; use a new path to preserve reviewed mappings")
    const plan = await inventoryMemories(source)
    await Bun.write(manifest, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
    return `Inventoried ${plan.records.length} record(s), ${plan.inventoryProblems.length} inventory problem(s). Review ownership, content and host policy in ${manifest}; no memories copied.`
  }
  const original = await Bun.file(manifest).text()
  const plan = memoryMigrationSchema.parse(JSON.parse(original))
  const results = await migrateMemories(plan, mode, validate)
  if (mode === "apply") {
    await Bun.write(`${manifest}.bak`, original, { mode: 0o600 })
    await Bun.write(manifest, `${JSON.stringify(plan, null, 2)}\n`)
  }
  const counts: Record<MigrationStatus, number> = {
    planned: 0,
    copied: 0,
    migrated: 0,
    unresolved: 0,
    failed: 0,
  }
  for (const result of results) counts[result.status]++
  const report = JSON.stringify({ mode, counts, results }, null, 2)
  if (counts.failed || counts.unresolved)
    throw new Error(
      `${report}\nMigration incomplete; resolve the reported records before proceeding`
    )
  return report
}
