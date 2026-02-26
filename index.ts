#!/usr/bin/env bun
import { registerCommand, run } from "./src/cli.ts";
import { skillCommand } from "./src/commands/skill.ts";
import { hooksCommand } from "./src/commands/hooks.ts";
import { installCommand } from "./src/commands/install.ts";
import { uninstallCommand } from "./src/commands/uninstall.ts";
import { statusCommand } from "./src/commands/status.ts";
import { tasksCommand } from "./src/commands/tasks.ts";
import { shimCommand } from "./src/commands/shim.ts";

registerCommand(skillCommand);
registerCommand(hooksCommand);
registerCommand(installCommand);
registerCommand(uninstallCommand);
registerCommand(statusCommand);
registerCommand(tasksCommand);
registerCommand(shimCommand);

run();
