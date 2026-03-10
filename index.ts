#!/usr/bin/env bun
import { registerCommand, run } from "./src/cli.ts"
import { ciWaitCommand } from "./src/commands/ci-wait.ts"
import { cleanupCommand } from "./src/commands/cleanup.ts"
import { compactCommand } from "./src/commands/compact.ts"
import { continueCommand } from "./src/commands/continue.ts"
import { crossRepoIssueCommand } from "./src/commands/cross-repo-issue.ts"
import { daemonCommand } from "./src/commands/daemon.ts"
import { dispatchCommand } from "./src/commands/dispatch.ts"
import { doctorCommand } from "./src/commands/doctor.ts"
import { hooksCommand } from "./src/commands/hooks.ts"
import { ideaCommand } from "./src/commands/idea.ts"
import { installCommand } from "./src/commands/install.ts"
import { issueCommand } from "./src/commands/issue.ts"
import { manageCommand } from "./src/commands/manage.ts"
import { memoryCommand } from "./src/commands/memory.ts"
import { mergetoolCommand } from "./src/commands/mergetool.ts"
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
registerCommand(manageCommand)
registerCommand(compactCommand)
registerCommand(mergetoolCommand)
registerCommand(pushWaitCommand)
registerCommand(pushCiCommand)
registerCommand(doctorCommand)
registerCommand(usageCommand)
registerCommand(daemonCommand)

await run()
