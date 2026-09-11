import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { backup } from "./utils/file-utils.ts"
import { renderTomlValue, stripTomlRoot } from "./utils/toml.ts"

const objectSchema = z.record(z.string(), z.unknown())
const groupSchema = z.looseObject({
  hooks: z.array(z.looseObject({ type: z.string().min(1) })),
})
const eventsSchema = z.record(z.string(), z.array(groupSchema))
type HookEvents = z.infer<typeof eventsSchema>

export interface CodexHookSources {
  configPath: string
  hooksPath: string
  configText: string
  hooksText: string
  config: z.infer<typeof objectSchema>
  document: z.infer<typeof objectSchema>
  inline: HookEvents
  external: HookEvents
  state: z.infer<typeof objectSchema>
  conflict: boolean
}

async function readOptional(path: string): Promise<string> {
  return (await Bun.file(path).exists()) ? await Bun.file(path).text() : ""
}

function parseConfig(text: string, path: string, toml: boolean): z.infer<typeof objectSchema> {
  try {
    return objectSchema.parse(text ? (toml ? Bun.TOML.parse(text) : JSON.parse(text)) : {})
  } catch {
    throw new Error(`Invalid ${toml ? "TOML" : "JSON"} configuration: ${path}; no files changed`)
  }
}

/** Reads one configuration layer. Hook trust state is metadata, not a hook source. */
export async function inspectCodexHookSources(directory: string): Promise<CodexHookSources> {
  const configPath = join(directory, "config.toml")
  const hooksPath = join(directory, "hooks.json")
  const [configText, hooksText] = await Promise.all([
    readOptional(configPath),
    readOptional(hooksPath),
  ])
  const config = parseConfig(configText, configPath, true)
  const document = parseConfig(hooksText, hooksPath, false)
  try {
    const { state = {}, ...definitions } = objectSchema.parse(config.hooks ?? {})
    const inline = eventsSchema.parse(definitions)
    const external = eventsSchema.parse(document.hooks ?? {})
    return {
      configPath,
      hooksPath,
      configText,
      hooksText,
      config,
      document,
      inline,
      external,
      state: objectSchema.parse(state),
      conflict: Object.keys(inline).length > 0 && hooksText.length > 0,
    }
  } catch {
    throw new Error(
      `Invalid Codex hook definitions in ${configPath} or ${hooksPath}; no files changed`
    )
  }
}

function preserveDisabledState(
  source: CodexHookSources,
  merged: HookEvents
): z.infer<typeof objectSchema> {
  const state = { ...source.state }
  for (const [event, groups] of Object.entries(source.inline)) {
    const eventId = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    const offset = (merged[event]?.length ?? 0) - groups.length
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((_, handlerIndex) => {
        const oldId = `${source.configPath}:${eventId}:${groupIndex}:${handlerIndex}`
        const oldState = objectSchema.safeParse(state[oldId])
        if (!oldState.success || oldState.data.enabled !== false) return
        const newId = `${source.hooksPath}:${eventId}:${offset + groupIndex}:${handlerIndex}`
        // A moved hook keeps its disabled decision. Never grant trust to a new source ID.
        state[newId] = { enabled: false }
      })
    })
  }
  return state
}

export function planCodexHookRepair(
  source: CodexHookSources
): { configText: string; hooksText: string; moved: number } | null {
  if (!source.conflict) return null
  const merged = { ...source.external }
  for (const [event, groups] of Object.entries(source.inline)) {
    Object.defineProperty(merged, event, {
      value: [...(source.external[event] ?? []), ...groups],
      enumerable: true,
      configurable: true,
    })
  }
  const state = preserveDisabledState(source, merged)
  const kept = stripTomlRoot(source.configText, "hooks")
  const hasState =
    Object.keys(state).length > 0 || Object.hasOwn(objectSchema.parse(source.config.hooks), "state")
  const configText = `${kept.trimEnd()}\n${hasState ? `\n[hooks]\nstate = ${renderTomlValue(state)}\n` : ""}`
  const expected = { ...source.config }
  delete expected.hooks
  if (hasState) expected.hooks = { state }
  if (!isDeepStrictEqual(Bun.TOML.parse(configText), expected)) {
    throw new Error("Cannot safely preserve unrelated Codex TOML settings; no files changed")
  }
  const hooksText = `${JSON.stringify({ ...source.document, hooks: merged }, null, 2)}\n`
  const moved = Object.values(source.inline)
    .flat()
    .reduce((sum, group) => sum + group.hooks.length, 0)
  return { configText, hooksText, moved }
}

async function assertUnchanged(source: CodexHookSources): Promise<void> {
  const [config, hooks] = await Promise.all([
    readOptional(source.configPath),
    readOptional(source.hooksPath),
  ])
  if (config !== source.configText || hooks !== source.hooksText) {
    throw new Error("Codex configuration changed during repair; retry with the current files")
  }
}

export async function repairCodexHookSources(
  directory: string,
  options: { dryRun?: boolean; write?: (path: string, content: string) => Promise<number> } = {}
): Promise<{ changed: boolean; moved: number; paths: string[] }> {
  const source = await inspectCodexHookSources(directory)
  const plan = planCodexHookRepair(source)
  if (!plan) return { changed: false, moved: 0, paths: [] }
  const paths = [source.hooksPath, source.configPath]
  if (options.dryRun) return { changed: true, moved: plan.moved, paths }
  await assertUnchanged(source)
  // Back up both originals before changing either configuration file.
  for (const path of paths) await backup(path)
  await assertUnchanged(source)
  const write = options.write ?? ((path: string, content: string) => Bun.write(path, content))
  await write(source.hooksPath, plan.hooksText)
  try {
    // The destination now contains every handler, so removing the old source cannot lose one.
    if ((await readOptional(source.configPath)) !== source.configText)
      throw new Error("Codex TOML changed during repair")
    await write(source.configPath, plan.configText)
  } catch (error) {
    if ((await readOptional(source.hooksPath)) === plan.hooksText)
      await write(source.hooksPath, source.hooksText)
    throw error
  }
  return { changed: true, moved: plan.moved, paths }
}
