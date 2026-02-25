#!/usr/bin/env bun
import { registerCommand, run } from "./src/cli.ts";
import { skillCommand } from "./src/commands/skill.ts";
import { hooksCommand } from "./src/commands/hooks.ts";
import { installCommand } from "./src/commands/install.ts";

registerCommand(skillCommand);
registerCommand(hooksCommand);
registerCommand(installCommand);

run();
