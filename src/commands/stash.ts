import { getGitClient } from "../git/client.ts"
import type { Command } from "../types.ts"

const FULL_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

interface StashEntry {
  selector: string
  oid: string
}

export interface StashRetirementReceipt {
  selector: string
  oid: string
}

export interface StashCommandOptions {
  cwd?: string
  write?: (value: string) => void
}

function usage(): string {
  return (
    "Usage: swiz stash retire <full-oid>\n" +
    "Retires exactly one stash after resolving and revalidating its current selector."
  )
}

function failureDetail(stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || "Git returned a non-zero exit code"
}

function parseStashInventory(stdout: string): StashEntry[] {
  const entries: StashEntry[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(\S+)\s+([0-9a-f]{40}|[0-9a-f]{64})$/i)
    if (!match?.[1] || !match[2]) {
      throw new Error(`Unexpected stash inventory entry: ${line}`)
    }
    entries.push({ selector: match[1], oid: match[2].toLowerCase() })
  }
  return entries
}

function resolveUniqueSelector(inventory: StashEntry[], oid: string): string {
  const matches = inventory.filter((entry) => entry.oid === oid)
  if (matches.length === 0) {
    throw new Error(`Stash OID ${oid} is not present in the current stash inventory.`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Stash OID ${oid} appears under multiple selectors (${matches.map((entry) => entry.selector).join(", ")}); refusing to guess which recovery entry to remove.`
    )
  }
  return matches[0]!.selector
}

async function verifySelectorOid(selector: string, oid: string, cwd: string): Promise<void> {
  const resolved = await getGitClient().run(["rev-parse", "--verify", selector], { cwd })
  const resolvedOid = resolved.stdout.trim().toLowerCase()
  if (resolved.exitCode === 0 && resolvedOid === oid) return
  throw new Error(
    `Stash selector ${selector} changed before retirement; expected ${oid}, found ${resolvedOid || "unresolved"}. No stash was removed.`
  )
}

async function verifyStashAbsent(selector: string, oid: string, cwd: string): Promise<void> {
  const after = await getGitClient().run(["stash", "list", "--format=%H"], { cwd })
  if (after.exitCode !== 0) {
    throw new Error(
      `Stash ${selector} was dropped, but absence verification failed: ${failureDetail(after.stdout, after.stderr)}`
    )
  }
  const remainingOids = after.stdout
    .split(/\r?\n/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (remainingOids.includes(oid)) {
    throw new Error(`Stash OID ${oid} is still present after dropping ${selector}.`)
  }
}

export async function retireStashByOid(
  requestedOid: string,
  cwd = process.cwd()
): Promise<StashRetirementReceipt> {
  const oid = requestedOid.trim().toLowerCase()
  if (!FULL_OID_RE.test(oid)) {
    throw new Error("Stash retirement requires a full 40- or 64-character hexadecimal OID.")
  }

  const git = getGitClient()
  const inventory = await git.run(["stash", "list", "--format=%gd %H"], { cwd })
  if (inventory.exitCode !== 0) {
    throw new Error(
      `Could not read the stash inventory: ${failureDetail(inventory.stdout, inventory.stderr)}`
    )
  }

  const selector = resolveUniqueSelector(parseStashInventory(inventory.stdout), oid)
  await verifySelectorOid(selector, oid, cwd)

  const dropped = await git.run(["stash", "drop", selector], { cwd })
  if (dropped.exitCode !== 0) {
    throw new Error(
      `Git refused to retire ${selector} at ${oid}: ${failureDetail(dropped.stdout, dropped.stderr)}`
    )
  }

  await verifyStashAbsent(selector, oid, cwd)

  return { selector, oid }
}

export const stashCommand: Command<StashCommandOptions> = {
  name: "stash",
  description: "Safely retire a classified stash by immutable object ID",
  usage: "swiz stash retire <full-oid>",
  options: [
    {
      flags: "retire <full-oid>",
      description: "Resolve, verify, drop, and prove absence of exactly one stash entry",
    },
  ],
  async run(args, options = {}) {
    const [subcommand, oid, ...rest] = args
    if (!subcommand) throw new Error(usage())
    if (subcommand !== "retire") throw new Error(`Unknown subcommand: ${subcommand}\n${usage()}`)
    if (!oid) throw new Error(`Missing stash OID.\n${usage()}`)
    if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}\n${usage()}`)

    const receipt = await retireStashByOid(oid, options.cwd ?? process.cwd())
    const write = options.write ?? ((value: string) => process.stdout.write(`${value}\n`))
    write(`Retired stash ${receipt.selector} at ${receipt.oid}`)
  },
}
