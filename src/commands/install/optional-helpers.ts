import { AGENTS } from "../../agents.ts"
import { DIM, GREEN, RED, RESET } from "../../ansi.ts"
import { formatUnifiedDiff } from "../../utils/diff-utils.ts"
import { readFileText, readJsonFile } from "../../utils/file-utils.ts"
import { writeWithBackup } from "./file-helpers.ts"

// ─── Status line configuration ───────────────────────────────────────────────

export const STATUS_LINE_CMD = "command -v swiz >/dev/null 2>&1 || exit 0; swiz status-line"

export async function installStatusLine(dryRun: boolean): Promise<void> {
  const claudeAgent = AGENTS.find((a) => a.id === "claude")
  if (!claudeAgent) return

  const settingsPath = claudeAgent.settingsPath
  const existing = await readJsonFile(settingsPath)
  const oldText = (await readFileText(settingsPath)).trimEnd()

  const current = existing.statusLine as Record<string, any> | undefined
  const alreadySet = current?.command === STATUS_LINE_CMD

  if (dryRun) {
    if (alreadySet) {
      console.log(`  ${DIM}statusLine: already configured${RESET}\n`)
    } else {
      console.log(`  ${GREEN}+ statusLine: swiz status-line${RESET}\n`)
      const proposed = { ...existing, statusLine: { type: "command", command: STATUS_LINE_CMD } }
      const newText = JSON.stringify(proposed, null, 2)
      console.log(formatUnifiedDiff(settingsPath, oldText, newText))
    }
    return
  }

  if (alreadySet) {
    console.log(`  ${DIM}statusLine: already configured${RESET}\n`)
    return
  }

  const proposed = { ...existing, statusLine: { type: "command", command: STATUS_LINE_CMD } }
  await writeWithBackup(settingsPath, `${JSON.stringify(proposed, null, 2)}\n`)
  console.log(`  ${GREEN}✓${RESET} statusLine configured in ${settingsPath}\n`)
}

export async function uninstallStatusLine(dryRun: boolean): Promise<void> {
  const claudeAgent = AGENTS.find((a) => a.id === "claude")
  if (!claudeAgent) return

  const settingsPath = claudeAgent.settingsPath
  const existing = await readJsonFile(settingsPath)
  const oldText = (await readFileText(settingsPath)).trimEnd()

  const current = existing.statusLine as Record<string, any> | undefined
  const isSwiz = current?.command === STATUS_LINE_CMD

  if (dryRun) {
    if (!isSwiz) {
      console.log(`  ${DIM}statusLine: not set to swiz (skip)${RESET}\n`)
    } else {
      console.log(`  ${RED}- statusLine: remove swiz status-line${RESET}\n`)
      const proposed = { ...existing }
      delete proposed.statusLine
      const newText = JSON.stringify(proposed, null, 2)
      console.log(formatUnifiedDiff(settingsPath, oldText, newText))
    }
    return
  }

  if (!isSwiz) {
    console.log(`  ${DIM}statusLine: not set to swiz (skip)${RESET}\n`)
    return
  }

  const proposed = { ...existing }
  delete proposed.statusLine
  await writeWithBackup(settingsPath, `${JSON.stringify(proposed, null, 2)}\n`)
  console.log(`  ${GREEN}✓${RESET} statusLine removed from ${settingsPath}\n`)
}

// ─── Git mergetool configuration ─────────────────────────────────────────────

export const MERGETOOL_SWIZ_CMD = 'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"'

export async function installMergeTool(dryRun: boolean): Promise<void> {
  const configs = [
    ["merge.tool", "swiz"],
    ["mergetool.swiz.cmd", MERGETOOL_SWIZ_CMD],
    ["mergetool.swiz.trustExitCode", "true"],
  ]

  if (dryRun) {
    console.log("  Git mergetool configuration (global):\n")
    for (const [key, value] of configs) {
      console.log(`    ${GREEN}+ git config --global ${key} ${value}${RESET}`)
    }
    console.log()
    return
  }

  for (const [key, value] of configs) {
    if (!key || !value) continue
    const proc = Bun.spawnSync(["git", "config", "--global", key, value])
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to set git config ${key}`)
    }
  }

  console.log(`  ${GREEN}✓${RESET} Git mergetool configured globally:\n`)
  console.log(`    merge.tool = swiz`)
  console.log(`    mergetool.swiz.cmd = ${MERGETOOL_SWIZ_CMD}`)
  console.log(`    mergetool.swiz.trustExitCode = true\n`)
}

export async function uninstallMergeTool(dryRun: boolean): Promise<void> {
  const getProc = Bun.spawnSync(["git", "config", "--global", "--get", "merge.tool"])
  const mergeTool =
    getProc.exitCode === 0 ? String(new TextDecoder().decode(getProc.stdout)).trim() : ""
  const cmdProc = Bun.spawnSync(["git", "config", "--global", "--get", "mergetool.swiz.cmd"])
  const swizCmd =
    cmdProc.exitCode === 0 ? String(new TextDecoder().decode(cmdProc.stdout)).trim() : ""

  const mergeToolIsSwiz = mergeTool === "swiz"
  const swizCmdMatchesInstall = swizCmd === MERGETOOL_SWIZ_CMD
  const willChange = mergeToolIsSwiz || swizCmdMatchesInstall

  if (dryRun) {
    console.log("  Git mergetool removal (global):\n")
    if (!willChange) {
      console.log(`    ${DIM}no swiz mergetool config found${RESET}`)
    } else if (mergeToolIsSwiz) {
      console.log(`    ${RED}- git config --global --unset merge.tool${RESET}`)
      console.log(`    ${RED}- git config --global --unset mergetool.swiz.cmd${RESET}`)
      console.log(`    ${RED}- git config --global --unset mergetool.swiz.trustExitCode${RESET}`)
    } else {
      console.log(`    ${RED}- git config --global --unset mergetool.swiz.cmd${RESET}`)
      console.log(`    ${RED}- git config --global --unset mergetool.swiz.trustExitCode${RESET}`)
    }
    console.log()
    return
  }

  if (!willChange) {
    console.log(`  ${DIM}Git mergetool: no swiz config found${RESET}\n`)
    return
  }

  if (mergeToolIsSwiz) {
    Bun.spawnSync(["git", "config", "--global", "--unset", "merge.tool"])
    Bun.spawnSync(["git", "config", "--global", "--unset", "mergetool.swiz.cmd"])
    Bun.spawnSync(["git", "config", "--global", "--unset", "mergetool.swiz.trustExitCode"])
  } else {
    Bun.spawnSync(["git", "config", "--global", "--unset", "mergetool.swiz.cmd"])
    Bun.spawnSync(["git", "config", "--global", "--unset", "mergetool.swiz.trustExitCode"])
  }

  console.log(`  ${GREEN}✓${RESET} Git mergetool swiz entries removed (global)\n`)
}
