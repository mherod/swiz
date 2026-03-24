#!/usr/bin/env bun

// Guard: require invocation via the globally linked `swiz` command.
// The shell sets process.env._ to the command that was actually executed.
// When run via `swiz`, it ends with "/swiz"; when run via `bun index.ts`, it points to bun.
// Only enforce in interactive terminals — subprocess/test invocations (piped stdio) are allowed.
const invokedAs = process.env._ ?? ""
const isInteractive = process.stderr.isTTY === true
if (isInteractive && !invokedAs.endsWith("/swiz") && !process.env.SWIZ_DIRECT) {
  process.stderr.write(
    "Error: swiz must be invoked via the globally linked command.\n" +
      "\n" +
      "  Run: swiz <command>\n" +
      "\n" +
      "If you haven't linked yet, run: bun link\n" +
      "To bypass this check: SWIZ_DIRECT=1 bun index.ts <command>\n"
  )
  process.exit(1)
}

import { registerCommand, run } from "./src/cli.ts"
import { ciWaitCommand } from "./src/commands/ci-wait.ts"
import { cleanupCommand } from "./src/commands/cleanup.ts"
import { compactCommand } from "./src/commands/compact.ts"
import { continueCommand } from "./src/commands/continue.ts"
import { crossRepoIssueCommand } from "./src/commands/cross-repo-issue.ts"
import { daemonCommand } from "./src/commands/daemon.ts"
import { dispatchCommand } from "./src/commands/dispatch.ts"
import { doctorCommand } from "./src/commands/doctor.ts"
import { emergencyBypassCommand } from "./src/commands/emergency-bypass.ts"
import { hooksCommand } from "./src/commands/hooks.ts"
import { ideaCommand } from "./src/commands/idea.ts"
import { installCommand } from "./src/commands/install.ts"
import { issueCommand } from "./src/commands/issue.ts"
import { manageCommand } from "./src/commands/manage.ts"
import { memoryCommand } from "./src/commands/memory.ts"
import { mergetoolCommand } from "./src/commands/mergetool.ts"
import { modelCommand } from "./src/commands/model.ts"
import { pushCiCommand } from "./src/commands/push-ci.ts"
import { pushWaitCommand } from "./src/commands/push-wait.ts"
import { reflectCommand } from "./src/commands/reflect.ts"
import { sentimentCommand } from "./src/commands/sentiment.ts"
import { sessionCommand } from "./src/commands/session.ts"
import { settingsCommand } from "./src/commands/settings.ts"
import { shimCommand } from "./src/commands/shim.ts"
import { skillCommand } from "./src/commands/skill.ts"
import { stateCommand } from "./src/commands/state.ts"
import { statusCommand } from "./src/commands/status.ts"
import { statusLineCommand } from "./src/commands/status-line.ts"
import { tasksCommand } from "./src/commands/tasks.ts"
import { transcriptCommand } from "./src/commands/transcript.ts"
import { uninstallCommand } from "./src/commands/uninstall.ts"
import { usageCommand } from "./src/commands/usage.ts"

registerCommand(skillCommand)
registerCommand(hooksCommand)
registerCommand(installCommand)
registerCommand(uninstallCommand)
registerCommand(statusCommand)
registerCommand(statusLineCommand)
registerCommand(settingsCommand)
registerCommand(stateCommand)
registerCommand(tasksCommand)
registerCommand(shimCommand)
registerCommand(dispatchCommand)
registerCommand(transcriptCommand)
registerCommand(continueCommand)
registerCommand(cleanupCommand)
registerCommand(issueCommand)
registerCommand(crossRepoIssueCommand)
registerCommand(ideaCommand)
registerCommand(reflectCommand)
registerCommand(sentimentCommand)
registerCommand(sessionCommand)
registerCommand(ciWaitCommand)
registerCommand(memoryCommand)
registerCommand(modelCommand)
registerCommand(manageCommand)
registerCommand(compactCommand)
registerCommand(mergetoolCommand)
registerCommand(pushWaitCommand)
registerCommand(pushCiCommand)
registerCommand(doctorCommand)
registerCommand(emergencyBypassCommand)
registerCommand(usageCommand)
registerCommand(daemonCommand)

await run()
