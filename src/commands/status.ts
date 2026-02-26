import { dirname } from "node:path";
import { join } from "node:path";
import type { Command } from "../types.ts";
import { AGENTS, detectInstalledAgents, type AgentDef } from "../agents.ts";

const SWIZ_ROOT = dirname(Bun.main);
const HOOKS_DIR = join(SWIZ_ROOT, "hooks");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function collectSwizCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      if (typeof e.command === "string" && e.command.includes(HOOKS_DIR)) {
        cmds.add(e.command);
      }
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          const hh = h as Record<string, unknown>;
          if (typeof hh.command === "string" && hh.command.includes(HOOKS_DIR)) {
            cmds.add(hh.command);
          }
        }
      }
    }
  }
  return cmds;
}

function countAllHooks(hooks: Record<string, unknown>): number {
  let total = 0;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e.hooks)) {
        total += e.hooks.length;
      } else {
        total++;
      }
    }
  }
  return total;
}

async function checkAgent(agent: AgentDef) {
  const file = Bun.file(agent.settingsPath);
  const binaryProc = Bun.spawnSync(["which", agent.binary]);
  const binaryInstalled = binaryProc.exitCode === 0;
  const binaryPath = binaryInstalled
    ? new TextDecoder().decode(binaryProc.stdout).trim()
    : null;

  const settingsExist = await file.exists();

  console.log(`  ${BOLD}${agent.name}${RESET}`);

  if (binaryPath) {
    console.log(`    Binary:   ${GREEN}✓${RESET} ${binaryPath}`);
  } else {
    console.log(`    Binary:   ${DIM}not found${RESET}`);
  }

  if (!settingsExist) {
    console.log(`    Settings: ${DIM}${agent.settingsPath} (not found)${RESET}`);
    console.log(`    Hooks:    ${RED}not installed${RESET}`);
    console.log();
    return;
  }

  console.log(`    Settings: ${GREEN}✓${RESET} ${agent.settingsPath}`);

  try {
    const json = await file.json();
    const hooks = json[agent.hooksKey] ?? json.hooks;

    if (!hooks || typeof hooks !== "object") {
      console.log(`    Hooks:    ${YELLOW}no hooks configured${RESET}`);
      console.log();
      return;
    }

    const hooksObj = hooks as Record<string, unknown>;
    const totalHooks = countAllHooks(hooksObj);
    const swizCmds = collectSwizCommands(hooksObj);
    const swizCount = swizCmds.length;
    const otherCount = totalHooks - swizCount;

    if (swizCount > 0) {
      console.log(
        `    Hooks:    ${GREEN}✓ ${swizCount} swiz hook(s)${RESET}` +
          (otherCount > 0
            ? ` + ${CYAN}${otherCount} other${RESET}`
            : "")
      );

      const events = new Set<string>();
      for (const [event, entries] of Object.entries(hooksObj)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const e = entry as Record<string, unknown>;
          const hasSwiz = (list: unknown[]) =>
            list.some(
              (h) =>
                typeof (h as Record<string, unknown>).command === "string" &&
                ((h as Record<string, unknown>).command as string).includes(HOOKS_DIR)
            );
          if (Array.isArray(e.hooks) && hasSwiz(e.hooks)) events.add(event);
          else if (typeof e.command === "string" && (e.command as string).includes(HOOKS_DIR))
            events.add(event);
        }
      }
      console.log(`    Events:   ${[...events].join(", ")}`);
    } else {
      console.log(
        `    Hooks:    ${YELLOW}${totalHooks} hook(s), none from swiz${RESET}`
      );
    }
  } catch {
    console.log(`    Hooks:    ${RED}failed to parse settings${RESET}`);
  }

  console.log();
}

export const statusCommand: Command = {
  name: "status",
  description: "Show swiz installation status across agents",
  usage: "swiz status",
  async run() {
    console.log(`\n  ${BOLD}swiz status${RESET}\n`);
    console.log(`  Hooks directory: ${HOOKS_DIR}\n`);

    for (const agent of AGENTS) {
      await checkAgent(agent);
    }
  },
};
