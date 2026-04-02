import { AGENTS } from "../../agents.ts"
import { DIM, GREEN, RED, RESET, YELLOW } from "../../ansi.ts"
import {
  getLaunchAgentPlistPath,
  loadLaunchAgentSync,
  SWIZ_PR_POLL_LABEL,
  unloadLaunchAgentSync,
} from "../../launch-agents.ts"
import { swizPrPollErrorLogPath, swizPrPollLogPath } from "../../temp-paths.ts"
import { formatUnifiedDiff } from "../../utils/diff-utils.ts"
import { backup, readFileText, readJsonFile } from "../../utils/file-utils.ts"

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

  await backup(settingsPath)
  const proposed = { ...existing, statusLine: { type: "command", command: STATUS_LINE_CMD } }
  await Bun.write(settingsPath, `${JSON.stringify(proposed, null, 2)}\n`)
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

  await backup(settingsPath)
  const proposed = { ...existing }
  delete proposed.statusLine
  await Bun.write(settingsPath, `${JSON.stringify(proposed, null, 2)}\n`)
  console.log(`  ${GREEN}✓${RESET} statusLine removed from ${settingsPath}\n`)
}

// ─── PR poll LaunchAgent ─────────────────────────────────────────────────────

const PR_POLL_LABEL = SWIZ_PR_POLL_LABEL
const PR_POLL_PLIST = getLaunchAgentPlistPath(PR_POLL_LABEL)

export function buildPrPollPlist(bunBin: string, indexPath: string): string {
  const logPath = swizPrPollLogPath()
  const errorLogPath = swizPrPollErrorLogPath()
  const projectCwd = process.cwd()
  const shellQuotedCwd = projectCwd.replaceAll("'", "'\"'\"'")

  // Route prPoll through daemon dispatch first; fallback to standalone dispatch.
  const payload = JSON.stringify({ cwd: projectCwd })
  const dispatchUrl = "http://localhost:7943/dispatch?event=prPoll&hookEventName=prPoll"
  const curlCmd = `curl -sSf -X POST "${dispatchUrl}" -d '${payload}' -H 'Content-Type: application/json'`
  const fallbackCmd = `cd '${shellQuotedCwd}' && '${bunBin}' '${indexPath}' dispatch prPoll`

  const cmd = `${curlCmd} > /dev/null 2>>${errorLogPath} || ${fallbackCmd} >>${logPath} 2>>${errorLogPath}`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${PR_POLL_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/bin/sh</string>
\t\t<string>-c</string>
\t\t<string>${cmd}</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>300</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${logPath}</string>
\t<key>StandardErrorPath</key>
\t<string>${errorLogPath}</string>
</dict>
</plist>
`
}

export async function installPrPoll(dryRun: boolean): Promise<void> {
  const bunBin = Bun.which("bun") ?? "bun"
  const indexPath = Bun.main
  const plistContent = buildPrPollPlist(bunBin, indexPath)

  const existingContent = await readFileText(PR_POLL_PLIST)
  const alreadyCurrent = existingContent.trim() === plistContent.trim()

  if (dryRun) {
    if (alreadyCurrent) {
      console.log(`  ${DIM}prPoll LaunchAgent: already installed${RESET}\n`)
    } else {
      console.log(`  ${GREEN}+ prPoll LaunchAgent: ${PR_POLL_PLIST}${RESET}\n`)
      console.log(formatUnifiedDiff(PR_POLL_PLIST, existingContent, plistContent))
    }
    return
  }

  if (alreadyCurrent) {
    console.log(`  ${DIM}prPoll LaunchAgent: already installed${RESET}\n`)
    return
  }

  await Bun.write(PR_POLL_PLIST, plistContent)
  unloadLaunchAgentSync(PR_POLL_PLIST)
  const loadExitCode = loadLaunchAgentSync(PR_POLL_PLIST)
  if (loadExitCode !== 0) {
    console.log(
      `  ${YELLOW}⚠${RESET} prPoll LaunchAgent written but launchctl load failed — reload manually:\n` +
        `    launchctl load ${PR_POLL_PLIST}\n`
    )
  } else {
    console.log(`  ${GREEN}✓${RESET} prPoll LaunchAgent installed and loaded:\n`)
    console.log(`    ${DIM}${PR_POLL_PLIST}${RESET}`)
    console.log(`    Polls every 5 minutes for new PR review/comment notifications.\n`)
  }
}

export async function uninstallPrPoll(dryRun: boolean): Promise<void> {
  const file = Bun.file(PR_POLL_PLIST)
  const exists = await file.exists()

  if (dryRun) {
    if (!exists) {
      console.log(`  ${DIM}prPoll LaunchAgent: not installed${RESET}\n`)
    } else {
      console.log(`  ${RED}- prPoll LaunchAgent: unload + trash ${PR_POLL_PLIST}${RESET}\n`)
    }
    return
  }

  if (!exists) {
    console.log(`  ${DIM}prPoll LaunchAgent: not installed${RESET}\n`)
    return
  }

  unloadLaunchAgentSync(PR_POLL_PLIST)
  const proc = Bun.spawnSync(["trash", PR_POLL_PLIST])
  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to trash ${PR_POLL_PLIST} — is the trash CLI installed? (${proc.exitCode ?? "unknown"})`
    )
  }
  console.log(`  ${GREEN}✓${RESET} prPoll LaunchAgent unloaded and removed:\n`)
  console.log(`    ${DIM}${PR_POLL_PLIST}${RESET}\n`)
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
