#!/usr/bin/env bun
import { registerCommand, run } from "./src/cli.ts"
import { cleanupCommand } from "./src/commands/cleanup.ts"
import { continueCommand } from "./src/commands/continue.ts"
import { dispatchCommand } from "./src/commands/dispatch.ts"
import { hooksCommand } from "./src/commands/hooks.ts"
import { installCommand } from "./src/commands/install.ts"
import { sentimentCommand } from "./src/commands/sentiment.ts"
import { sessionCommand } from "./src/commands/session.ts"
import { settingsCommand } from "./src/commands/settings.ts"
import { shimCommand } from "./src/commands/shim.ts"
import { skillCommand } from "./src/commands/skill.ts"
import { statusCommand } from "./src/commands/status.ts"
import { tasksCommand } from "./src/commands/tasks.ts"
import { transcriptCommand } from "./src/commands/transcript.ts"
import { uninstallCommand } from "./src/commands/uninstall.ts"

registerCommand(skillCommand)
registerCommand(hooksCommand)
registerCommand(installCommand)
registerCommand(uninstallCommand)
registerCommand(statusCommand)
registerCommand(settingsCommand)
registerCommand(tasksCommand)
registerCommand(shimCommand)
registerCommand(dispatchCommand)
registerCommand(transcriptCommand)
registerCommand(continueCommand)
registerCommand(cleanupCommand)
registerCommand(sentimentCommand)
registerCommand(sessionCommand)

await run()
