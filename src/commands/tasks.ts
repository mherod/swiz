import { readdir, stat, readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Command } from "../types.ts";

const HOME = process.env.HOME ?? "~";
const TASKS_DIR = join(HOME, ".claude", "tasks");
const PROJECTS_DIR = join(HOME, ".claude", "projects");

// ─── Types ──────────────────────────────────────────────────────────────────

interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  blocks: string[];
  blockedBy: string[];
  completionEvidence?: string;
  completionTimestamp?: string;
}

interface AuditEntry {
  timestamp: string;
  taskId: string;
  action: "create" | "status_change" | "delete";
  oldStatus?: Task["status"];
  newStatus?: Task["status"];
  verificationText?: string;
  evidence?: string;
  subject?: string;
}

// ─── ANSI ───────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const STATUS_STYLE: Record<Task["status"], { emoji: string; color: string }> = {
  pending: { emoji: "⏳", color: "\x1b[33m" },
  in_progress: { emoji: "🔄", color: "\x1b[36m" },
  completed: { emoji: "✅", color: "\x1b[32m" },
  cancelled: { emoji: "❌", color: "\x1b[31m" },
};

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(ms / 86400000);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ─── Session discovery ──────────────────────────────────────────────────────

async function getSessionCwd(sessionId: string): Promise<string | null> {
  try {
    const dirs = await readdir(PROJECTS_DIR);
    for (const dir of dirs) {
      const transcriptPath = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      try {
        const content = await readFile(transcriptPath, "utf-8");
        for (const line of content.split("\n").slice(0, 10)) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.cwd) return data.cwd;
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function getSessions(filterCwd?: string): Promise<string[]> {
  try {
    const entries = await readdir(TASKS_DIR);
    const stats = await Promise.all(
      entries.map(async (s) => {
        const p = join(TASKS_DIR, s);
        const st = await stat(p);
        const cwd = await getSessionCwd(s);
        return { session: s, mtime: st.mtime, cwd };
      })
    );
    const filtered = filterCwd
      ? stats.filter((s) => s.cwd === filterCwd)
      : stats;
    filtered.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return filtered.map((s) => s.session);
  } catch {
    return [];
  }
}

// ─── Task I/O ───────────────────────────────────────────────────────────────

async function readTasks(sessionId: string): Promise<Task[]> {
  const dir = join(TASKS_DIR, sessionId);
  try {
    const files = await readdir(dir);
    const tasks = await Promise.all(
      files
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as Task)
    );
    return tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  } catch {
    return [];
  }
}

async function writeTask(sessionId: string, task: Task) {
  const dir = join(TASKS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2));
}

async function writeAudit(sessionId: string, entry: AuditEntry) {
  try {
    const dir = join(TASKS_DIR, sessionId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, ".audit-log.jsonl"), JSON.stringify(entry) + "\n");
  } catch {}
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function listTasks(sessionId: string, label: string) {
  const tasks = await readTasks(sessionId);
  console.log(
    `\n  ${BOLD}Tasks${RESET} ${DIM}(${label}: ${sessionId.slice(0, 8)}...)${RESET}\n`
  );

  if (tasks.length === 0) {
    console.log("  No tasks found.\n");
    return;
  }

  const groups: [string, Task[]][] = [
    ["IN PROGRESS", tasks.filter((t) => t.status === "in_progress")],
    ["PENDING", tasks.filter((t) => t.status === "pending")],
    ["COMPLETED", tasks.filter((t) => t.status === "completed")],
    ["CANCELLED", tasks.filter((t) => t.status === "cancelled")],
  ];

  for (const [title, group] of groups) {
    if (group.length === 0) continue;
    console.log(`  ${BOLD}${title}${RESET} (${group.length})\n`);
    for (const task of group) {
      const { emoji, color } = STATUS_STYLE[task.status];
      console.log(
        `  ${emoji} ${BOLD}#${task.id}${RESET} ${color}[${task.status.replace("_", " ").toUpperCase()}]${RESET} ${task.subject}`
      );
      if (task.description) {
        const lines = task.description.split("\n").slice(0, 3);
        for (const line of lines) console.log(`     ${DIM}${line}${RESET}`);
        if (task.description.split("\n").length > 3)
          console.log(`     ${DIM}...${RESET}`);
      }
      if (task.completionEvidence)
        console.log(`     ${DIM}✓ Evidence: ${task.completionEvidence}${RESET}`);
      if (task.completionTimestamp)
        console.log(`     ${DIM}✓ Completed: ${timeAgo(new Date(task.completionTimestamp))}${RESET}`);
      if (task.blockedBy.length)
        console.log(`     ${DIM}Blocked by: #${task.blockedBy.join(", #")}${RESET}`);
      if (task.blocks.length)
        console.log(`     ${DIM}Blocks: #${task.blocks.join(", #")}${RESET}`);
      console.log();
    }
  }

  const incomplete = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  ).length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  console.log(
    `  ${BOLD}Summary:${RESET} ${incomplete}/${tasks.length} incomplete, ${completed} completed\n`
  );
}

async function createTask(
  sessionId: string,
  subject: string,
  description: string
) {
  const tasks = await readTasks(sessionId);
  const maxId = tasks.reduce((m, t) => Math.max(m, parseInt(t.id)), 0);
  const id = (maxId + 1).toString();

  const task: Task = {
    id,
    subject,
    description,
    status: "pending",
    blocks: [],
    blockedBy: [],
  };

  await writeTask(sessionId, task);
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId: id,
    action: "create",
    newStatus: "pending",
    subject,
  });

  const { emoji, color } = STATUS_STYLE.pending;
  console.log(`\n  ${emoji} Created #${id}: ${color}pending${RESET}`);
  console.log(`     ${subject}\n`);
}

async function updateStatus(
  sessionId: string,
  taskId: string,
  newStatus: Task["status"],
  evidence?: string
) {
  const tasks = await readTasks(sessionId);
  const task = tasks.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task #${taskId} not found.`);
  }

  if (newStatus === "completed" && !evidence) {
    throw new Error("Evidence required when completing a task. Use --evidence.");
  }

  const oldStatus = task.status;
  task.status = newStatus;
  if (newStatus === "completed" && evidence) {
    task.completionEvidence = evidence;
    task.completionTimestamp = new Date().toISOString();
  }

  await writeTask(sessionId, task);
  await writeAudit(sessionId, {
    timestamp: new Date().toISOString(),
    taskId,
    action: "status_change",
    oldStatus,
    newStatus,
    evidence,
    subject: task.subject,
  });

  const { emoji, color } = STATUS_STYLE[newStatus];
  console.log(`\n  ${emoji} #${taskId}: ${oldStatus} → ${color}${newStatus}${RESET}`);
  console.log(`     ${task.subject}`);
  if (evidence) console.log(`     ${DIM}Evidence: ${evidence}${RESET}`);
  console.log();
}

async function completeAll(sessionId: string) {
  const tasks = await readTasks(sessionId);
  const incomplete = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  );

  if (incomplete.length === 0) {
    console.log("\n  No incomplete tasks.\n");
    return;
  }

  console.log(`\n  Completing ${incomplete.length} task(s)...\n`);
  for (const task of incomplete) {
    await updateStatus(sessionId, task.id, "completed", "bulk-complete");
  }
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

function extractFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

async function resolveSession(args: string[]): Promise<string> {
  const explicit = extractFlag(args, "--session");
  const allProjects = args.includes("--all-projects");
  const filterCwd = allProjects ? undefined : process.cwd();
  const sessions = await getSessions(filterCwd);

  if (sessions.length === 0) {
    if (filterCwd) {
      throw new Error(`No task sessions found for ${filterCwd}.\nUse --all-projects to see all.`);
    } else {
      throw new Error("No task sessions found.");
    }
  }

  if (explicit) {
    const match = sessions.find((s) => s.startsWith(explicit));
    if (!match) {
      throw new Error(`Session "${explicit}" not found.`);
    }
    return match;
  }

  return sessions[0]!;
}

// ─── Command ────────────────────────────────────────────────────────────────

export const tasksCommand: Command = {
  name: "tasks",
  description: "View and manage agent tasks",
  usage:
    "swiz tasks [create|complete|status|complete-all] [--session ID] [--all-projects] [--evidence TEXT]",
  async run(args) {
    const subcommand = args[0];

    if (
      !subcommand ||
      subcommand === "--session" ||
      subcommand === "--all-projects"
    ) {
      const sessionId = await resolveSession(args);
      const allProjects = args.includes("--all-projects");

      await listTasks(sessionId, allProjects ? "all projects" : "current project");

      if (!args.includes("--session") && !allProjects) {
        const tasks = await readTasks(sessionId);
        const hasIncomplete = tasks.some(
          (t) => t.status === "pending" || t.status === "in_progress"
        );
        if (!hasIncomplete && tasks.length > 0) {
          const filterCwd = process.cwd();
          const sessions = await getSessions(filterCwd);
          for (let i = 1; i < sessions.length; i++) {
            const prev = await readTasks(sessions[i]!);
            if (prev.some((t) => t.status === "pending" || t.status === "in_progress")) {
              console.log(
                `  ${DIM}Incomplete tasks in previous session: ${sessions[i]!.slice(0, 8)}...${RESET}\n`
              );
              break;
            }
          }
        }
      }
      return;
    }

    const rest = args.slice(1);

    switch (subcommand) {
      case "create": {
        const subject = rest[0];
        const description = rest[1];
        if (!subject || !description) {
          throw new Error('Usage: swiz tasks create "<subject>" "<description>"');
        }
        const sessionId = await resolveSession(rest.slice(2));
        await createTask(sessionId, subject, description);
        break;
      }

      case "complete": {
        const taskId = rest[0];
        if (!taskId) {
          throw new Error("Usage: swiz tasks complete <task-id> [--evidence TEXT]");
        }
        const evidence = extractFlag(rest, "--evidence");
        const sessionId = await resolveSession(rest.slice(1));
        await updateStatus(sessionId, taskId, "completed", evidence);
        break;
      }

      case "status": {
        const taskId = rest[0];
        const newStatus = rest[1] as Task["status"] | undefined;
        const valid: Task["status"][] = [
          "pending",
          "in_progress",
          "completed",
          "cancelled",
        ];
        if (!taskId || !newStatus || !valid.includes(newStatus)) {
          throw new Error(
            `Usage: swiz tasks status <task-id> <${valid.join("|")}> [--evidence TEXT]`
          );
        }
        const evidence = extractFlag(rest, "--evidence");
        const sessionId = await resolveSession(rest.slice(2));
        await updateStatus(sessionId, taskId, newStatus, evidence);
        break;
      }

      case "complete-all": {
        const sessionId = await resolveSession(rest);
        await completeAll(sessionId);
        break;
      }

      default:
        throw new Error(`Unknown subcommand: ${subcommand}\nRun "swiz help tasks" for usage.`);
    }
  },
};
