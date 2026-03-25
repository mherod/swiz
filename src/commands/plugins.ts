import { rm } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDirWithFallback } from "../home.ts"
import type { Command } from "../types.ts"

type InstalledPluginEntry = { installPath: string }
type InstalledPlugins = {
  version?: number
  plugins?: Record<string, InstalledPluginEntry[]>
}

interface PluginRecord {
  key: string
  name: string
  marketplace: string | null
  entries: InstalledPluginEntry[]
}

function usage(): string {
  return (
    "Usage: swiz plugins <subcommand> [options]\n" +
    "Subcommands: list, info, uninstall\n" +
    "  swiz plugins list [--json]\n" +
    "  swiz plugins info <name|name@marketplace> [--json]\n" +
    "  swiz plugins uninstall <name|name@marketplace>"
  )
}

function splitPluginKey(key: string): { name: string; marketplace: string | null } {
  const idx = key.lastIndexOf("@")
  if (idx <= 0 || idx === key.length - 1) return { name: key, marketplace: null }
  return { name: key.slice(0, idx), marketplace: key.slice(idx + 1) }
}

function pluginDir(pluginsDirOverride?: string): string {
  if (pluginsDirOverride) return pluginsDirOverride
  return join(getHomeDirWithFallback(""), ".claude", "plugins")
}

function installedPluginsPath(pluginsDirOverride?: string): string {
  return join(pluginDir(pluginsDirOverride), "installed_plugins.json")
}

async function readInstalledPlugins(pluginsDirOverride?: string): Promise<InstalledPlugins> {
  const path = installedPluginsPath(pluginsDirOverride)
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`Claude plugin registry not found: ${path}`)
  }
  try {
    return await file.json()
  } catch {
    throw new Error(`Malformed JSON in ${path}`)
  }
}

function toPluginRecords(installed: InstalledPlugins): PluginRecord[] {
  const plugins = installed.plugins ?? {}
  return Object.entries(plugins)
    .map(([key, entries]) => {
      const { name, marketplace } = splitPluginKey(key)
      return { key, name, marketplace, entries }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

function resolveTarget(records: PluginRecord[], target: string): PluginRecord {
  const exact = records.find((r) => r.key === target)
  if (exact) return exact

  const byName = records.filter((r) => r.name === target)
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) {
    throw new Error(
      `Plugin name "${target}" is ambiguous. Use one of: ${byName.map((r) => r.key).join(", ")}`
    )
  }
  throw new Error(`Plugin not found: ${target}`)
}

function printPluginList(records: PluginRecord[]): void {
  if (records.length === 0) {
    console.log("  No Claude plugins installed.")
    return
  }
  console.log("  Installed Claude plugins:\n")
  for (const record of records) {
    const marketplace = record.marketplace ? ` @ ${record.marketplace}` : ""
    console.log(`    ${record.name}${marketplace} (${record.entries.length} install)`)
  }
}

function printPluginInfo(record: PluginRecord): void {
  console.log(`  key: ${record.key}`)
  console.log(`  name: ${record.name}`)
  console.log(`  marketplace: ${record.marketplace ?? "unknown"}`)
  console.log(`  installs: ${record.entries.length}`)
  console.log("  install paths:")
  for (const entry of record.entries) {
    console.log(`    - ${entry.installPath}`)
  }
}

async function removeInstallDirectories(entries: InstalledPluginEntry[]): Promise<void> {
  for (const entry of entries) {
    await rm(entry.installPath, { recursive: true, force: true })
  }
}

async function writeInstalledPlugins(
  installed: InstalledPlugins,
  pluginsDirOverride?: string
): Promise<void> {
  const path = installedPluginsPath(pluginsDirOverride)
  const file = Bun.file(path)
  const previous = await file.text()
  await Bun.write(`${path}.bak`, previous)
  await Bun.write(path, `${JSON.stringify(installed, null, 2)}\n`)
}

async function handleList(args: string[], pluginsDirOverride?: string): Promise<void> {
  const asJson = args.includes("--json")
  const records = toPluginRecords(await readInstalledPlugins(pluginsDirOverride))
  if (asJson) {
    console.log(
      JSON.stringify(
        records.map((r) => ({
          key: r.key,
          name: r.name,
          marketplace: r.marketplace,
          installCount: r.entries.length,
          installPaths: r.entries.map((e) => e.installPath),
        })),
        null,
        2
      )
    )
    return
  }
  printPluginList(records)
}

async function handleInfo(args: string[], pluginsDirOverride?: string): Promise<void> {
  const target = args[0]
  if (!target) throw new Error(`Missing plugin name.\n${usage()}`)
  const asJson = args.includes("--json")
  const record = resolveTarget(
    toPluginRecords(await readInstalledPlugins(pluginsDirOverride)),
    target
  )
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          key: record.key,
          name: record.name,
          marketplace: record.marketplace,
          installPaths: record.entries.map((e) => e.installPath),
        },
        null,
        2
      )
    )
    return
  }
  printPluginInfo(record)
}

async function handleUninstall(args: string[], pluginsDirOverride?: string): Promise<void> {
  const target = args[0]
  if (!target) throw new Error(`Missing plugin name.\n${usage()}`)

  const installed = await readInstalledPlugins(pluginsDirOverride)
  const records = toPluginRecords(installed)
  const record = resolveTarget(records, target)

  await removeInstallDirectories(record.entries)

  const nextPlugins = { ...(installed.plugins ?? {}) }
  delete nextPlugins[record.key]
  await writeInstalledPlugins({ ...installed, plugins: nextPlugins }, pluginsDirOverride)

  console.log(`  Uninstalled Claude plugin: ${record.key}`)
}

export const pluginsCommand: Command = {
  name: "plugins",
  description: "Manage Claude plugins in ~/.claude/plugins",
  usage: "swiz plugins <list|info|uninstall> [name] [--json]",
  options: [
    { flags: "list [--json]", description: "List installed Claude plugins" },
    {
      flags: "info <name|name@marketplace> [--json]",
      description: "Show installed plugin details",
    },
    {
      flags: "uninstall <name|name@marketplace>",
      description: "Uninstall plugin and remove it from installed_plugins.json",
    },
    {
      flags: "--plugins-dir <path>",
      description: "Override ~/.claude/plugins path (for advanced usage/testing)",
    },
    { flags: "--json", description: "Output JSON for list/info subcommands" },
  ],
  async run(args: string[]) {
    const pluginsDirFlag = args.indexOf("--plugins-dir")
    let pluginsDirOverride: string | undefined
    let effectiveArgs = args
    if (pluginsDirFlag >= 0) {
      pluginsDirOverride = args[pluginsDirFlag + 1]
      if (!pluginsDirOverride) {
        throw new Error("--plugins-dir requires a path value")
      }
      effectiveArgs = args.filter((_, i) => i !== pluginsDirFlag && i !== pluginsDirFlag + 1)
    }
    const sub = effectiveArgs[0]
    if (!sub) throw new Error(`Missing subcommand.\n${usage()}`)
    if (sub === "list") return handleList(effectiveArgs.slice(1), pluginsDirOverride)
    if (sub === "info") return handleInfo(effectiveArgs.slice(1), pluginsDirOverride)
    if (sub === "uninstall") return handleUninstall(effectiveArgs.slice(1), pluginsDirOverride)
    throw new Error(`Unknown subcommand: ${sub}\n${usage()}`)
  },
}
