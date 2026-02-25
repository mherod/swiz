#!/usr/bin/env bun
import { registerCommand, run } from "./src/cli.ts";
import { skillCommand } from "./src/commands/skill.ts";

registerCommand(skillCommand);

run();
