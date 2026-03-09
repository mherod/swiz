import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectBlockedToolUseIds } from "../hooks/hook-utils.ts"
import {
  bashMutatesWorkspace,
  buildReadOutputStep,
  buildRemediationHints,
  classifyCommand,
  commandFingerprint,
  extractPreviousOutput,
  extractToolUseIdFromLine,
  parseTranscriptEvents,
} from "../hooks/pretooluse-repeated-lint-test.ts"
import { extractSessionLines, parseTranscriptSummary } from "../src/transcript-summary.ts"

// ── classifyCommand ───────────────────────────────────────────────────────────

describe("classifyCommand", () => {
  test("detects bun test", () => {
    expect(classifyCommand("bun test")).toBe("test")
    expect(classifyCommand("bun test --watch")).toBe("test")
    expect(classifyCommand("cd src && bun test")).toBe("test")
  })

  test("detects bun run lint as lint", () => {
    expect(classifyCommand("bun run lint")).toBe("lint")
    expect(classifyCommand("bun run lint 2>&1")).toBe("lint")
  })

  test("detects bun run typecheck as typecheck (distinct from lint)", () => {
    expect(classifyCommand("bun run typecheck")).toBe("typecheck")
    expect(classifyCommand("bun run typecheck 2>&1")).toBe("typecheck")
  })

  test("detects bun run check as check (distinct from lint)", () => {
    expect(classifyCommand("bun run check")).toBe("check")
    expect(classifyCommand("bun run check --write")).toBe("check")
  })

  test("detects bun run build", () => {
    expect(classifyCommand("bun run build")).toBe("build")
    expect(classifyCommand("bun run build --minify")).toBe("build")
  })

  test("returns null for unrelated commands", () => {
    expect(classifyCommand("git status")).toBeNull()
    expect(classifyCommand("ls -la")).toBeNull()
    expect(classifyCommand("echo hello")).toBeNull()
  })
})

// ── commandFingerprint ────────────────────────────────────────────────────────

describe("commandFingerprint", () => {
  test("returns null for unrecognised commands", () => {
    expect(commandFingerprint("git status")).toBeNull()
    expect(commandFingerprint("ls -la")).toBeNull()
  })

  test("non-test kinds return kind string only (project-wide scope)", () => {
    expect(commandFingerprint("bun run lint")).toBe("lint")
    expect(commandFingerprint("bun run typecheck")).toBe("typecheck")
    expect(commandFingerprint("bun run build")).toBe("build")
  })

  test("bun test with no arguments returns 'test' (no scope suffix)", () => {
    expect(commandFingerprint("bun test")).toBe("test")
    expect(commandFingerprint("bun test --concurrent")).toBe("test")
  })

  test("bun test with a single file path returns scoped fingerprint", () => {
    expect(commandFingerprint("bun test src/a.test.ts")).toBe("test:src/a.test.ts")
    expect(commandFingerprint("bun test src/b.test.ts")).toBe("test:src/b.test.ts")
  })

  test("bun test with multiple files returns sorted, comma-joined scope", () => {
    // Tokens are sorted so order in command doesn't matter
    expect(commandFingerprint("bun test src/b.test.ts src/a.test.ts")).toBe(
      "test:src/a.test.ts,src/b.test.ts"
    )
  })

  test("flags (starting with -) are excluded from scope tokens", () => {
    expect(commandFingerprint("bun test --concurrent src/foo.test.ts --timeout 5000")).toBe(
      "test:src/foo.test.ts"
    )
  })

  test("tokens after pipe boundary are not included in scope", () => {
    // 'bun test src/a.test.ts | tee out.txt' — 'tee' and 'out.txt' must not appear
    expect(commandFingerprint("bun test src/a.test.ts | tee out.txt")).toBe("test:src/a.test.ts")
  })

  test("different file targets produce different fingerprints", () => {
    const fp1 = commandFingerprint("bun test src/a.test.ts")
    const fp2 = commandFingerprint("bun test src/b.test.ts")
    expect(fp1).not.toBe(fp2)
  })

  test("same file target produces identical fingerprints (gate should fire)", () => {
    const fp1 = commandFingerprint("bun test src/a.test.ts")
    const fp2 = commandFingerprint("bun test src/a.test.ts")
    expect(fp1).toBe(fp2)
  })
})

// ── bashMutatesWorkspace — mutations that MUST be detected ───────────────────

describe("bashMutatesWorkspace — shell redirects", () => {
  test("plain output redirect >", () => {
    expect(bashMutatesWorkspace("cmd > file.txt")).toBe(true)
    expect(bashMutatesWorkspace("echo hello > out.log")).toBe(true)
  })

  test("append redirect >>", () => {
    expect(bashMutatesWorkspace("cmd >> file.txt")).toBe(true)
  })

  test("bash &> redirect (stdout + stderr)", () => {
    expect(bashMutatesWorkspace("cmd &> out.txt")).toBe(true)
    expect(bashMutatesWorkspace("cmd &>> out.txt")).toBe(true)
  })

  test("numbered FD redirect N>", () => {
    expect(bashMutatesWorkspace("cmd 1> out.txt")).toBe(true)
    expect(bashMutatesWorkspace("cmd 2> err.txt")).toBe(true)
    expect(bashMutatesWorkspace("cmd 1>> out.txt")).toBe(true)
  })

  test("does NOT flag /dev/ redirects", () => {
    expect(bashMutatesWorkspace("cmd > /dev/null")).toBe(false)
    expect(bashMutatesWorkspace("cmd > /dev/stderr")).toBe(false)
  })

  test("does NOT flag FD-to-FD redirect 2>&1", () => {
    expect(bashMutatesWorkspace("cmd 2>&1")).toBe(false)
  })
})

describe("bashMutatesWorkspace — tee", () => {
  test("tee to a file", () => {
    expect(bashMutatesWorkspace("cmd | tee output.txt")).toBe(true)
    expect(bashMutatesWorkspace("cmd | tee -a log.txt")).toBe(true)
  })

  test("tee to /dev/null is not a mutation", () => {
    expect(bashMutatesWorkspace("cmd | tee /dev/null")).toBe(false)
    expect(bashMutatesWorkspace("cmd | tee /dev/stderr")).toBe(false)
  })
})

describe("bashMutatesWorkspace — sed in-place", () => {
  test("sed -i (simple)", () => {
    expect(bashMutatesWorkspace("sed -i 's/a/b/' file.txt")).toBe(true)
  })

  test("sed -iE (combined flag, i not last)", () => {
    expect(bashMutatesWorkspace("sed -iE 's/a/b/' file.txt")).toBe(true)
  })

  test("sed -Ei (combined flag, i last)", () => {
    expect(bashMutatesWorkspace("sed -Ei 's/a/b/' file.txt")).toBe(true)
  })

  test("sed -i.bak (backup suffix)", () => {
    expect(bashMutatesWorkspace("sed -i.bak 's/a/b/' file.txt")).toBe(true)
  })

  test("sed --in-place (GNU long form)", () => {
    expect(bashMutatesWorkspace("sed --in-place 's/a/b/' file.txt")).toBe(true)
    expect(bashMutatesWorkspace("sed --in-place=.bak 's/a/b/' file.txt")).toBe(true)
  })
})

describe("bashMutatesWorkspace — perl in-place", () => {
  test("perl -i", () => {
    expect(bashMutatesWorkspace("perl -i -pe 's/a/b/' file.txt")).toBe(true)
  })

  test("perl -pi (combined, i not first)", () => {
    expect(bashMutatesWorkspace("perl -pi -e 's/a/b/' file.txt")).toBe(true)
  })

  test("perl -pie (combined, i middle)", () => {
    expect(bashMutatesWorkspace("perl -pie 's/a/b/' file.txt")).toBe(true)
  })

  test("perl -i.bak (backup suffix)", () => {
    expect(bashMutatesWorkspace("perl -i.bak -pe 's/a/b/' file.txt")).toBe(true)
  })
})

describe("bashMutatesWorkspace — ruby in-place", () => {
  test("ruby -i", () => {
    expect(bashMutatesWorkspace("ruby -i -pe 'sub /a/, \"b\"' file.txt")).toBe(true)
  })

  test("ruby -ri (combined)", () => {
    expect(bashMutatesWorkspace("ruby -ri -e 'puts \"x\"' file.txt")).toBe(true)
  })

  test("ruby -i.bak (backup suffix)", () => {
    expect(bashMutatesWorkspace("ruby -i.bak file.txt")).toBe(true)
  })
})

describe("bashMutatesWorkspace — awk in-place", () => {
  test("awk -i inplace", () => {
    expect(bashMutatesWorkspace("awk -i inplace '{print}' file.txt")).toBe(true)
  })

  test("gawk -i inplace", () => {
    expect(bashMutatesWorkspace("gawk -i inplace '{print}' file.txt")).toBe(true)
  })
})

describe("bashMutatesWorkspace — patch", () => {
  test("patch command", () => {
    expect(bashMutatesWorkspace("patch file.diff")).toBe(true)
    expect(bashMutatesWorkspace("patch -p1 < changes.diff")).toBe(true)
  })
})

describe("bashMutatesWorkspace — Python -c inline", () => {
  test("open() with write mode 'w'", () => {
    expect(bashMutatesWorkspace("python3 -c \"open('f','w').write('x')\"\n")).toBe(true)
    expect(bashMutatesWorkspace(`python3 -c "f=open('out.txt','w'); f.write('hello')"`)).toBe(true)
  })

  test("open() with append mode 'a'", () => {
    expect(bashMutatesWorkspace(`python -c "open('log.txt','a').write('line')"`)).toBe(true)
  })

  test("open() with exclusive-create mode 'x'", () => {
    expect(bashMutatesWorkspace(`python3 -c "open('new.txt','x').write('data')"`)).toBe(true)
  })

  test("open() with binary write mode 'wb'", () => {
    expect(bashMutatesWorkspace(`python3 -c "open('f','wb').write(b'data')"`)).toBe(true)
  })

  test("does NOT flag open() with read mode 'r'", () => {
    expect(bashMutatesWorkspace(`python3 -c "print(open('f').read())"`)).toBe(false)
    expect(bashMutatesWorkspace(`python3 -c "data=open('f','r').read()"`)).toBe(false)
  })

  test("pathlib .write_text()", () => {
    expect(
      bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('f').write_text('x')"`)
    ).toBe(true)
  })

  test("pathlib .write_bytes()", () => {
    expect(
      bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('f').write_bytes(b'x')"`)
    ).toBe(true)
  })

  test("pathlib .unlink()", () => {
    expect(bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('f').unlink()"`)).toBe(
      true
    )
  })

  test("pathlib .rename()", () => {
    expect(
      bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('a').rename('b')"`)
    ).toBe(true)
  })

  test("pathlib .replace()", () => {
    expect(
      bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('a').replace('b')"`)
    ).toBe(true)
  })

  test("pathlib .rmdir()", () => {
    expect(bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('d').rmdir()"`)).toBe(
      true
    )
  })

  test("pathlib .mkdir()", () => {
    expect(bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('d').mkdir()"`)).toBe(
      true
    )
  })

  test("pathlib .touch()", () => {
    expect(bashMutatesWorkspace(`python3 -c "from pathlib import Path; Path('f').touch()"`)).toBe(
      true
    )
  })

  test("os.remove()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.remove('f')"`)).toBe(true)
  })

  test("os.unlink()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.unlink('f')"`)).toBe(true)
  })

  test("os.rename()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.rename('a','b')"`)).toBe(true)
  })

  test("os.replace()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.replace('a','b')"`)).toBe(true)
  })

  test("os.makedirs()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.makedirs('a/b')"`)).toBe(true)
  })

  test("os.mkdir() — fixed makedirs? bug", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.mkdir('newdir')"`)).toBe(true)
  })

  test("os.rmdir()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import os; os.rmdir('d')"`)).toBe(true)
  })

  test("shutil.copy()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import shutil; shutil.copy('a','b')"`)).toBe(true)
  })

  test("shutil.copy2()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import shutil; shutil.copy2('a','b')"`)).toBe(true)
  })

  test("shutil.move()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import shutil; shutil.move('a','b')"`)).toBe(true)
  })

  test("shutil.rmtree()", () => {
    expect(bashMutatesWorkspace(`python3 -c "import shutil; shutil.rmtree('dir')"`)).toBe(true)
  })

  test("does NOT flag python3 -c read-only script", () => {
    expect(bashMutatesWorkspace(`python3 -c "import json; print(json.load(open('f')))"`)).toBe(
      false
    )
  })
})

describe("bashMutatesWorkspace — Python -m in-place formatters", () => {
  test("python -m black", () => {
    expect(bashMutatesWorkspace("python3 -m black .")).toBe(true)
    expect(bashMutatesWorkspace("python -m black src/")).toBe(true)
  })

  test("python -m isort", () => {
    expect(bashMutatesWorkspace("python3 -m isort .")).toBe(true)
  })

  test("python -m autopep8", () => {
    expect(bashMutatesWorkspace("python3 -m autopep8 file.py")).toBe(true)
  })

  test("python -m 2to3 -w", () => {
    expect(bashMutatesWorkspace("python3 -m 2to3 -w file.py")).toBe(true)
  })
})

describe("bashMutatesWorkspace — CLI output flags", () => {
  test("-o path (space-separated)", () => {
    expect(bashMutatesWorkspace("compiler -o output.bin src.c")).toBe(true)
  })

  test("--output path (space-separated)", () => {
    expect(bashMutatesWorkspace("tool --output report.txt")).toBe(true)
  })

  test("--outfile=path (equals-separated)", () => {
    expect(bashMutatesWorkspace("bundler --outfile=dist/bundle.js")).toBe(true)
  })

  test("--outdir=path (equals-separated)", () => {
    expect(bashMutatesWorkspace("esbuild --outdir=dist src/index.ts")).toBe(true)
  })
})

describe("bashMutatesWorkspace — file deletions, moves, copies", () => {
  test("rm", () => {
    expect(bashMutatesWorkspace("rm file.txt")).toBe(true)
    expect(bashMutatesWorkspace("rm -rf dir/")).toBe(true)
  })

  test("trash", () => {
    expect(bashMutatesWorkspace("trash file.txt")).toBe(true)
  })

  test("unlink", () => {
    expect(bashMutatesWorkspace("unlink file.txt")).toBe(true)
  })

  test("mv", () => {
    expect(bashMutatesWorkspace("mv src.txt dst.txt")).toBe(true)
  })

  test("cp", () => {
    expect(bashMutatesWorkspace("cp src.txt dst.txt")).toBe(true)
  })
})

describe("bashMutatesWorkspace — directory operations", () => {
  test("mkdir", () => {
    expect(bashMutatesWorkspace("mkdir newdir")).toBe(true)
    expect(bashMutatesWorkspace("mkdir -p a/b/c")).toBe(true)
  })

  test("rmdir", () => {
    expect(bashMutatesWorkspace("rmdir emptydir")).toBe(true)
  })
})

describe("bashMutatesWorkspace — env-var driven paths", () => {
  test("KEY=./path prefix", () => {
    expect(bashMutatesWorkspace("OUTPUT=./out.json bun test")).toBe(true)
    expect(bashMutatesWorkspace("REPORT_FILE=./report.html tool")).toBe(true)
  })

  test("does NOT flag absolute-path env vars", () => {
    expect(bashMutatesWorkspace("HOME=/tmp/test bun run")).toBe(false)
  })
})

// ── bashMutatesWorkspace — commands that must NOT be detected ─────────────────

describe("bashMutatesWorkspace — non-mutations (false-positive guard)", () => {
  test("read-only shell commands", () => {
    expect(bashMutatesWorkspace("cat file.txt")).toBe(false)
    expect(bashMutatesWorkspace("less file.txt")).toBe(false)
    expect(bashMutatesWorkspace("ls -la")).toBe(false)
    expect(bashMutatesWorkspace("git status")).toBe(false)
    expect(bashMutatesWorkspace("git log --oneline -10")).toBe(false)
  })

  test("echo without redirect", () => {
    expect(bashMutatesWorkspace("echo hello")).toBe(false)
  })

  test("pipeline without file output", () => {
    expect(bashMutatesWorkspace("git log | head -20")).toBe(false)
    expect(bashMutatesWorkspace("cat file | grep pattern")).toBe(false)
  })

  test("bun run without file output", () => {
    expect(bashMutatesWorkspace("bun run lint")).toBe(false)
    expect(bashMutatesWorkspace("bun test")).toBe(false)
  })
})

describe("bashMutatesWorkspace — script-wrapper formatters", () => {
  test("bun run format is a mutation", () => {
    expect(bashMutatesWorkspace("bun run format")).toBe(true)
  })

  test("bun run lint:fix is a mutation", () => {
    expect(bashMutatesWorkspace("bun run lint:fix")).toBe(true)
  })

  test("bun run lint-fix is a mutation (hyphen variant)", () => {
    expect(bashMutatesWorkspace("bun run lint-fix")).toBe(true)
  })

  test("bun run fix is a mutation", () => {
    expect(bashMutatesWorkspace("bun run fix")).toBe(true)
  })

  test("biome format --write is a mutation", () => {
    expect(bashMutatesWorkspace("biome format --write .")).toBe(true)
    expect(bashMutatesWorkspace("biome check --write .")).toBe(true)
  })

  test("biome format without --write is not a mutation", () => {
    expect(bashMutatesWorkspace("biome format .")).toBe(false)
    expect(bashMutatesWorkspace("biome check .")).toBe(false)
  })

  test("eslint --fix is a mutation", () => {
    expect(bashMutatesWorkspace("eslint --fix src/")).toBe(true)
    expect(bashMutatesWorkspace("npx eslint --fix .")).toBe(true)
  })

  test("prettier --write is a mutation", () => {
    expect(bashMutatesWorkspace("prettier --write src/")).toBe(true)
  })

  test("prettier -w is a mutation", () => {
    expect(bashMutatesWorkspace("prettier -w src/")).toBe(true)
  })

  test("bun run lint (read-only) is NOT a mutation", () => {
    expect(bashMutatesWorkspace("bun run lint")).toBe(false)
  })
})

// ── parseTranscriptEvents ─────────────────────────────────────────────────────

/** Build a single JSONL assistant line containing one tool_use block. */
function assistantLine(name: string, command: string): string {
  const entry = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input: { command } }],
    },
  }
  return JSON.stringify(entry)
}

/** Build a JSONL assistant line with an Edit tool call (no command field). */
function editLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts", new_string: "x" } }],
    },
  })
}

/** Write JSONL lines to a temp file and return the path. */
async function writeTranscript(dir: string, lines: string[]): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await writeFile(path, `${lines.join("\n")}\n`, "utf-8")
  return path
}

describe("parseTranscriptEvents", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "swiz-transcript-test-"))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("empty transcript returns no events", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(0)
    }))

  test("missing transcript file returns no events", () =>
    withDir(async (dir) => {
      const events = await parseTranscriptEvents(join(dir, "nonexistent.jsonl"))
      expect(events).toHaveLength(0)
    }))

  test("malformed JSON lines are ignored", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        "not json at all",
        "{ broken json",
        assistantLine("Bash", "bun test"),
      ])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe("test")
    }))

  test("non-assistant entries are ignored", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        JSON.stringify({ type: "user", message: "hello" }),
        JSON.stringify({ type: "tool_result", content: "done" }),
        assistantLine("Bash", "bun test"),
      ])
      const events = await parseTranscriptEvents(path)
      // Only the assistant line produces an event
      expect(events).toHaveLength(1)
    }))

  test("bun test → test event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [assistantLine("Bash", "bun test")])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: "test", fingerprint: "test", sourceLineIdx: 0 })
    }))

  test("bun run lint → lint event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [assistantLine("Bash", "bun run lint")])
      const events = await parseTranscriptEvents(path)
      expect(events[0]).toEqual({ kind: "lint", fingerprint: "lint", sourceLineIdx: 0 })
    }))

  test("bun run build → build event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [assistantLine("Bash", "bun run build")])
      const events = await parseTranscriptEvents(path)
      expect(events[0]).toEqual({ kind: "build", fingerprint: "build", sourceLineIdx: 0 })
    }))

  test("unrelated bash command → no event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [assistantLine("Bash", "git status")])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(0)
    }))

  test("Edit tool call → any_edit event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [editLine()])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: "any_edit", sourceLineIdx: 0 })
    }))

  test("bash mutation (rm) → any_edit event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [assistantLine("Bash", "rm file.txt")])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ kind: "any_edit", sourceLineIdx: 0 })
    }))

  test("classified command + mutation emits both test and any_edit", () =>
    withDir(async (dir) => {
      // bun test | tee out.txt — classified as test AND mutates workspace
      const path = await writeTranscript(dir, [assistantLine("Bash", "bun test | tee out.txt")])
      const events = await parseTranscriptEvents(path)
      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ kind: "test", fingerprint: "test", sourceLineIdx: 0 })
      expect(events[1]).toEqual({ kind: "any_edit", sourceLineIdx: 0 })
    }))

  test("sourceLineIdx increments per non-empty line", () =>
    withDir(async (dir) => {
      // Empty lines are skipped (no increment); blank lines do not get own lineIdx
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // lineIdx 0
        assistantLine("Bash", "bun run lint"), // lineIdx 1
      ])
      const events = await parseTranscriptEvents(path)
      expect(events[0]).toEqual({ kind: "test", fingerprint: "test", sourceLineIdx: 0 })
      expect(events[1]).toEqual({ kind: "lint", fingerprint: "lint", sourceLineIdx: 1 })
    }))

  test("two same-kind events on different source lines (no intervening edit)", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // prior
        assistantLine("Bash", "bun test"), // current
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      expect(testEvents).toHaveLength(2)
      expect(testEvents[0]?.sourceLineIdx).toBe(0)
      expect(testEvents[1]?.sourceLineIdx).toBe(1)
      // No any_edit between them — gate should block
      const hasIntervening = events
        .slice(events.indexOf(testEvents[0]!) + 1)
        .some((e) => e.kind === "any_edit")
      expect(hasIntervening).toBe(false)
    }))

  test("two same-kind events with intervening Edit → hasInterveningWork is true", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // prior run
        editLine(), // intervening edit
        assistantLine("Bash", "bun test"), // repeat run
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      const priorIdx = events.indexOf(testEvents[0]!)
      const hasIntervening = events.slice(priorIdx + 1).some((e) => e.kind === "any_edit")
      expect(hasIntervening).toBe(true)
    }))

  test("parallel dispatch: two test events on same sourceLineIdx", () =>
    withDir(async (dir) => {
      // When the model emits two Bash tool_use blocks in a single assistant message,
      // they land in the transcript on the same JSONL line (same sourceLineIdx).
      const entry = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "bun test" } },
            { type: "tool_use", name: "Bash", input: { command: "bun test" } },
          ],
        },
      })
      const path = await writeTranscript(dir, [entry])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      expect(testEvents).toHaveLength(2)
      // Both from the same line — parallel dispatch guard applies
      expect(testEvents[0]?.sourceLineIdx).toBe(testEvents[1]?.sourceLineIdx)
    }))

  test("bun test fileA then bun test fileB produce different fingerprints", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test src/a.test.ts"),
        assistantLine("Bash", "bun test src/b.test.ts"),
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      expect(testEvents).toHaveLength(2)
      expect(testEvents[0]?.fingerprint).toBe("test:src/a.test.ts")
      expect(testEvents[1]?.fingerprint).toBe("test:src/b.test.ts")
      // Different fingerprints — gate must NOT fire for this pair
      expect(testEvents[0]?.fingerprint).not.toBe(testEvents[1]?.fingerprint)
    }))

  test("bun test fileA then bun test fileA produce identical fingerprints (gate fires)", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test src/a.test.ts"),
        assistantLine("Bash", "bun test src/a.test.ts"),
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      expect(testEvents).toHaveLength(2)
      expect(testEvents[0]?.fingerprint).toBe("test:src/a.test.ts")
      expect(testEvents[1]?.fingerprint).toBe("test:src/a.test.ts")
      // Same fingerprint — gate should fire for this pair
      expect(testEvents[0]?.fingerprint).toBe(testEvents[1]?.fingerprint)
    }))

  test("bun run format between lint runs emits any_edit event", () =>
    withDir(async (dir) => {
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun run lint"),
        assistantLine("Bash", "bun run format"),
        assistantLine("Bash", "bun run lint"),
      ])
      const events = await parseTranscriptEvents(path)
      const lintEvents = events.filter((e) => e.kind === "lint")
      const editEvents = events.filter((e) => e.kind === "any_edit")
      expect(lintEvents).toHaveLength(2)
      // bun run format is a workspace mutation → any_edit event between the lints
      expect(editEvents).toHaveLength(1)
      // The any_edit must appear between the two lint events
      const firstLintIdx = events.indexOf(lintEvents[0]!)
      const editIdx = events.indexOf(editEvents[0]!)
      const secondLintIdx = events.indexOf(lintEvents[1]!)
      expect(firstLintIdx).toBeLessThan(editIdx)
      expect(editIdx).toBeLessThan(secondLintIdx)
    }))

  test("blocked first run is excluded: only one test event produced", () =>
    withDir(async (dir) => {
      // Simulate: first bun test was denied by a PreToolUse hook (tool_result
      // contains "ACTION REQUIRED:"), then a second bun test actually ran.
      const blockedId = "tu_blocked_001"
      const succeededId = "tu_ok_002"
      const assistant1 = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: blockedId, name: "Bash", input: { command: "bun test" } },
          ],
        },
      })
      // Denial tool_result — contains "ACTION REQUIRED:" marker
      const denial = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: blockedId,
              content:
                "Use `bun test` with `--concurrent`.\n\nACTION REQUIRED: Fix the underlying issue.",
            },
          ],
        },
      })
      const assistant2 = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: succeededId,
              name: "Bash",
              input: { command: "bun test --concurrent" },
            },
          ],
        },
      })
      const path = await writeTranscript(dir, [assistant1, denial, assistant2])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      // The blocked run must not count — only the successful run should appear
      expect(testEvents).toHaveLength(1)
    }))

  test("compaction boundary: bun test from prior session is discarded", () =>
    withDir(async (dir) => {
      // Simulate a transcript that spans two sessions separated by compaction:
      //   session 1: bun test  (prior session — must be invisible)
      //   {"type":"system"} compaction marker
      //   session 2: bun test  (current session — the only visible run)
      const systemLine = JSON.stringify({ type: "system" })
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // prior session run — before boundary
        systemLine, // compaction marker
        assistantLine("Bash", "bun test"), // current session run
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      // Only the post-compaction run should be visible — prior session is discarded
      expect(testEvents).toHaveLength(1)
    }))

  test("compaction boundary: consecutive runs within the new session are still detected", () =>
    withDir(async (dir) => {
      // Compacted session followed by two bun test calls with no intervening edit:
      //   prior session bun test (discarded)
      //   {"type":"system"}
      //   current session: bun test, bun test (second should be blocked)
      const systemLine = JSON.stringify({ type: "system" })
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // prior session — discarded
        systemLine,
        assistantLine("Bash", "bun test"), // current session run 1
        assistantLine("Bash", "bun test"), // current session run 2 — gate should fire
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      // Both post-compaction runs are visible; no intervening edit → gate fires
      expect(testEvents).toHaveLength(2)
      const hasIntervening = events
        .slice(events.indexOf(testEvents[0]!) + 1)
        .some((e) => e.kind === "any_edit")
      expect(hasIntervening).toBe(false)
    }))

  test("compaction boundary: multiple system entries — only last is the boundary", () =>
    withDir(async (dir) => {
      // Multiple compaction cycles: only the LAST {"type":"system"} is the boundary
      const systemLine = JSON.stringify({ type: "system" })
      const path = await writeTranscript(dir, [
        assistantLine("Bash", "bun test"), // session 1 — discarded
        systemLine, // first compaction
        assistantLine("Bash", "bun test"), // session 2 — also discarded (before final boundary)
        systemLine, // second compaction (the actual boundary)
        assistantLine("Bash", "bun test"), // current session — only this visible
      ])
      const events = await parseTranscriptEvents(path)
      const testEvents = events.filter((e) => e.kind === "test")
      expect(testEvents).toHaveLength(1)
    }))
})

// ── collectBlockedToolUseIds ──────────────────────────────────────────────────

describe("collectBlockedToolUseIds", () => {
  function toolResultLine(toolUseId: string, content: string): string {
    return JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
      },
    })
  }

  test("returns empty set for transcript with no user messages", () => {
    const lines = [JSON.stringify({ type: "assistant", message: {} })]
    expect(collectBlockedToolUseIds(lines).size).toBe(0)
  })

  test("detects tool_use_id with ACTION REQUIRED: in string content", () => {
    const lines = [toolResultLine("tu_abc", "Blocked.\n\nACTION REQUIRED: Fix this.")]
    const blocked = collectBlockedToolUseIds(lines)
    expect(blocked.has("tu_abc")).toBe(true)
  })

  test("detects tool_use_id with ACTION REQUIRED: in array content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_arr",
            content: [{ type: "text", text: "Denied.\n\nACTION REQUIRED: Do the thing." }],
          },
        ],
      },
    })
    const blocked = collectBlockedToolUseIds([line])
    expect(blocked.has("tu_arr")).toBe(true)
  })

  test("does not flag tool_result without ACTION REQUIRED:", () => {
    const lines = [toolResultLine("tu_ok", "4 pass\n0 fail\nRan 4 tests across 1 file.")]
    const blocked = collectBlockedToolUseIds(lines)
    expect(blocked.has("tu_ok")).toBe(false)
  })

  test("ignores malformed JSON lines", () => {
    const lines = ["{ not valid json", toolResultLine("tu_good", "ACTION REQUIRED: Fix.")]
    const blocked = collectBlockedToolUseIds(lines)
    expect(blocked.has("tu_good")).toBe(true)
    expect(blocked.size).toBe(1)
  })
})

// ── extractToolUseIdFromLine ──────────────────────────────────────────────────

describe("extractToolUseIdFromLine", () => {
  test("returns tool_use_id for matching bash command", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tu_abc", name: "Bash", input: { command: "bun test" } }],
      },
    })
    expect(extractToolUseIdFromLine(line, "test")).toBe("tu_abc")
  })

  test("returns null when command is wrong kind", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_abc", name: "Bash", input: { command: "bun run lint" } },
        ],
      },
    })
    expect(extractToolUseIdFromLine(line, "test")).toBeNull()
  })

  test("returns null for non-assistant entry", () => {
    const line = JSON.stringify({ type: "user", message: {} })
    expect(extractToolUseIdFromLine(line, "test")).toBeNull()
  })

  test("returns null for malformed JSON", () => {
    expect(extractToolUseIdFromLine("{ not valid json", "test")).toBeNull()
  })

  test("returns first matching id when multiple tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu_first", name: "Bash", input: { command: "bun test" } },
          { type: "tool_use", id: "tu_second", name: "Bash", input: { command: "bun test" } },
        ],
      },
    })
    expect(extractToolUseIdFromLine(line, "test")).toBe("tu_first")
  })
})

// ── buildRemediationHints ─────────────────────────────────────────────────────

describe("buildRemediationHints", () => {
  test("returns empty string for empty output", () => {
    expect(buildRemediationHints("", "lint")).toBe("")
    expect(buildRemediationHints("   \n  ", "test")).toBe("")
  })

  test("extracts file:line lint errors", () => {
    const output = [
      "src/commands/foo.ts:34:5 lint/style/useTemplate FIXABLE",
      "src/commands/foo.ts:67:1 lint/suspicious/noExplicitAny",
      "Checked 10 files in 12ms. Found 2 errors.",
    ].join("\n")
    const hints = buildRemediationHints(output, "lint")
    expect(hints).toContain("src/commands/foo.ts:34")
    expect(hints).toContain("src/commands/foo.ts:67")
  })

  test("extracts TypeScript TS-error lines for build kind", () => {
    const output = [
      "src/utils.ts:10:5 - error TS2345: Argument of type 'string' is not assignable.",
      "Found 1 error.",
    ].join("\n")
    const hints = buildRemediationHints(output, "build")
    expect(hints).toContain("TS2345")
  })

  test("extracts failing test lines for test kind", () => {
    const output = [
      "(fail) parseTranscriptEvents > bun test → test event [5ms]",
      "error: expect(received).toEqual(expected)",
    ].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("(fail)")
  })

  test("extracts Vitest × failure marker lines", () => {
    const output = [
      " FAIL  src/components/Button.test.ts [ 123ms ]",
      "  × renders without crashing [ 5ms ]",
      "  ✓ passes accessibility check",
      "AssertionError: expected 1 to equal 2",
    ].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("FAIL  src/components/Button.test.ts")
    expect(hints).toContain("× renders without crashing")
    expect(hints).toContain("AssertionError:")
  })

  test("extracts Jest ● and ✕ failure lines", () => {
    const output = [
      " FAIL src/utils/format.test.js",
      "  ● formatDate › returns ISO string",
      "    Expected: '2024-01-01'",
      "    Received: '01/01/2024'",
      "  ✕ formatDate returns ISO string (12 ms)",
    ].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("FAIL src/utils/format.test.js")
    expect(hints).toContain("● formatDate")
    expect(hints).toContain("✕ formatDate")
  })

  test("extracts Vitest FAIL file path for test kind", () => {
    const output = [" FAIL  src/hooks/useAuth.test.ts", "  × login redirects on success"].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("useAuth.test.ts")
  })

  test("extracts Playwright ✘ (U+2718) heavy ballot X failure line", () => {
    const output = "  ✘ 1 [chromium] › tests/login.spec.ts:23:5 › Login › should redirect (3.2s)"
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("✘")
  })

  test("extracts Playwright numbered browser context line", () => {
    const output = [
      "  1) [chromium] › tests/auth.spec.ts:10:5 › Auth › login redirects",
      "     Error: expect(received).toBe(expected)",
    ].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("[chromium]")
  })

  test("extracts Playwright .spec.ts file reference with line number", () => {
    const output = "    at tests/auth.spec.ts:42:5"
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("auth.spec.ts:42")
  })

  test("extracts Playwright N failed summary line", () => {
    const output = ["  2 passed", "  1 failed"].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("1 failed")
  })

  test("extracts Cypress N failing summary line", () => {
    const output = ["  2 passing (3s)", "  1 failing"].join("\n")
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("1 failing")
  })

  test("extracts Cypress CypressError: line", () => {
    const output = "    CypressError: Timed out retrying after 4000ms"
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("CypressError:")
  })

  test("extracts Cypress .cy.ts file reference with line number", () => {
    const output = "    at Context.<anonymous> (cypress/e2e/login.cy.ts:15:5)"
    const hints = buildRemediationHints(output, "test")
    expect(hints).toContain("login.cy.ts:15")
  })

  test("does not flag Playwright/Cypress patterns for lint kind", () => {
    const output = [
      "  1) [chromium] › tests/auth.spec.ts:10:5",
      "  1 failed",
      "  CypressError: timeout",
    ].join("\n")
    const hints = buildRemediationHints(output, "lint")
    // lint kind only matches file:line patterns — auth.spec.ts:10 will match .(ts):\d+
    // but CypressError and "1 failed" must NOT appear as lint errors
    expect(hints).not.toContain("CypressError")
    expect(hints).not.toContain("1 failed")
  })

  test("does not flag FAIL lines for lint kind (not a test runner)", () => {
    // "FAIL" appears in some lint output (e.g. summary lines) but should not
    // be treated as a test-runner pattern when kind is lint.
    const output = "src/utils.ts:5:1 lint/style FAIL"
    const hints = buildRemediationHints(output, "lint")
    // Lint kind only matches file:line patterns
    expect(hints).toContain("src/utils.ts:5")
  })

  test("returns empty string when no matching error lines", () => {
    const output = "All checks passed. 0 errors.\n4 pass\n0 fail"
    expect(buildRemediationHints(output, "lint")).toBe("")
  })

  test("caps output at 6 hits", () => {
    const lintLines = Array.from(
      { length: 10 },
      (_, i) => `src/file${i}.ts:${i + 1}:1 lint/style/useTemplate`
    )
    const hints = buildRemediationHints(lintLines.join("\n"), "lint")
    // Should contain at most 6 bullet points
    const bullets = (hints.match(/•/g) ?? []).length
    expect(bullets).toBeLessThanOrEqual(6)
  })
})

// ── extractPreviousOutput ─────────────────────────────────────────────────────

describe("extractPreviousOutput", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "swiz-remediation-test-"))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Build a JSONL transcript with assistant tool_use + user tool_result pair. */
  function transcriptWithResult(command: string, toolOutput: string): string[] {
    const toolUseId = "tu_test_123"
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
      },
    })
    const user = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: [{ type: "text", text: toolOutput }],
          },
        ],
      },
    })
    return [assistant, user]
  }

  test("extracts text from array-form tool_result content", () =>
    withDir(async (dir) => {
      const path = join(dir, "t.jsonl")
      const lines = transcriptWithResult("bun test", "2 pass\n1 fail")
      await writeFile(path, `${lines.join("\n")}\n`, "utf-8")
      const out = await extractPreviousOutput(path, 0, "test")
      expect(out).toContain("2 pass")
      expect(out).toContain("1 fail")
    }))

  test("extracts text from string-form tool_result content", () =>
    withDir(async (dir) => {
      const toolUseId = "tu_str"
      const assistant = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "bun run lint" } },
          ],
        },
      })
      const user = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "lint errors found" }],
        },
      })
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${[assistant, user].join("\n")}\n`, "utf-8")
      const out = await extractPreviousOutput(path, 0, "lint")
      expect(out).toBe("lint errors found")
    }))

  test("returns empty string when tool_use_id not found", () =>
    withDir(async (dir) => {
      const assistant = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu_x", name: "Bash", input: { command: "bun test" } }],
        },
      })
      // Tool result references a different id
      const user = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_other", content: "output" }],
        },
      })
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${[assistant, user].join("\n")}\n`, "utf-8")
      const out = await extractPreviousOutput(path, 0, "test")
      expect(out).toBe("")
    }))

  test("returns empty string for missing file", async () => {
    const out = await extractPreviousOutput("/nonexistent/path.jsonl", 0, "test")
    expect(out).toBe("")
  })

  test("returns empty string when priorSourceLineIdx out of range", () =>
    withDir(async (dir) => {
      const lines = transcriptWithResult("bun test", "output")
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${lines.join("\n")}\n`, "utf-8")
      const out = await extractPreviousOutput(path, 99, "test")
      expect(out).toBe("")
    }))

  test("skips wrong-kind commands when extracting id", () =>
    withDir(async (dir) => {
      const toolUseId = "tu_lint"
      const assistant = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "bun run lint" } },
          ],
        },
      })
      const user = JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: "lint output" }],
        },
      })
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${[assistant, user].join("\n")}\n`, "utf-8")
      // Ask for "test" kind — line has "lint" command — should return ""
      const out = await extractPreviousOutput(path, 0, "test")
      expect(out).toBe("")
    }))
})

// ── buildReadOutputStep ─────────────────────────────────────────────────────

describe("buildReadOutputStep", () => {
  test("includes transcript path and source line index when output was extracted", () => {
    const step = buildReadOutputStep("bun test", "/tmp/transcript.jsonl", 5, "2 pass\n1 fail")
    expect(step).toContain("/tmp/transcript.jsonl")
    expect(step).toContain("source line index: 5")
    expect(step).toContain("Read the full output")
  })

  test("uses softer language when output could not be extracted", () => {
    const step = buildReadOutputStep("bun run lint", "/tmp/transcript.jsonl", 3, "")
    expect(step).toContain("/tmp/transcript.jsonl")
    expect(step).toContain("source line index: 3")
    expect(step).toContain("could not be extracted automatically")
    expect(step).toContain("Review the previous")
  })

  test("falls back to generic message when no transcript path", () => {
    const step = buildReadOutputStep("bun test", "", 0, "")
    expect(step).toBe("Read the full output from the previous bun test run.")
    expect(step).not.toContain("transcript")
  })

  test("uses label in all three branches", () => {
    const withOutput = buildReadOutputStep("bun run build", "/t.jsonl", 1, "output")
    const withoutOutput = buildReadOutputStep("bun run build", "/t.jsonl", 1, "")
    const noTranscript = buildReadOutputStep("bun run build", "", 0, "")

    expect(withOutput).toContain("bun run build")
    expect(withoutOutput).toContain("bun run build")
    expect(noTranscript).toContain("bun run build")
  })
})

// ── Cached-lines optimization paths ──────────────────────────────────────────

describe("extractSessionLines", () => {
  test("returns all lines when no system boundary present", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "user", message: { content: [] } }),
    ]
    const result = extractSessionLines(lines.join("\n"))
    // All lines returned when no compaction boundary
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test("returns only post-compaction lines when system boundary exists", () => {
    const preCompaction = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun run lint" } }],
      },
    })
    const boundary = JSON.stringify({ type: "system", content: "compaction" })
    const postCompaction = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] },
    })
    const text = [preCompaction, boundary, postCompaction].join("\n")
    const result = extractSessionLines(text)
    // Should only include lines after the boundary
    expect(result.some((l) => l.includes('"system"'))).toBe(false)
    expect(result.some((l) => l.includes("bun test"))).toBe(true)
    expect(result.some((l) => l.includes("bun run lint"))).toBe(false)
  })
})

describe("parseTranscriptSummary sessionLines field", () => {
  test("includes sessionLines in returned summary", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
      },
    })
    const summary = parseTranscriptSummary(line)
    expect(summary.sessionLines).toBeDefined()
    expect(Array.isArray(summary.sessionLines)).toBe(true)
    expect(summary.sessionLines.some((l) => l.includes("bun test"))).toBe(true)
  })

  test("sessionLines respects compaction boundary", () => {
    const preCompaction = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun run lint" } }],
      },
    })
    const boundary = JSON.stringify({ type: "system", content: "compaction" })
    const postCompaction = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
      },
    })
    const text = [preCompaction, boundary, postCompaction].join("\n")
    const summary = parseTranscriptSummary(text)
    // sessionLines should exclude pre-compaction content
    expect(summary.sessionLines.some((l) => l.includes("bun run lint"))).toBe(false)
    expect(summary.sessionLines.some((l) => l.includes("bun test"))).toBe(true)
    // bashCommands parsed from sessionLines only — no pre-compaction commands
    expect(summary.bashCommands).not.toContain("bun run lint")
  })
})

describe("parseTranscriptEvents with cachedSessionLines", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "swiz-cached-lines-test-"))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("produces same events with cached lines as file read", () =>
    withDir(async (dir) => {
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Edit",
                input: { file_path: "a.ts", new_string: "x" },
              },
            ],
          },
        }),
      ]
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${lines.join("\n")}\n`, "utf-8")

      const eventsFromFile = await parseTranscriptEvents(path)
      const eventsFromCache = await parseTranscriptEvents(path, lines)

      expect(eventsFromCache.length).toBe(eventsFromFile.length)
      for (let i = 0; i < eventsFromFile.length; i++) {
        expect(eventsFromCache[i]?.kind).toBe(eventsFromFile[i]?.kind)
        expect(eventsFromCache[i]?.sourceLineIdx).toBe(eventsFromFile[i]?.sourceLineIdx)
      }
    }))
})

describe("extractPreviousOutput with cachedLines", () => {
  async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "swiz-cached-output-test-"))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("produces same output with cached lines as file read", () =>
    withDir(async (dir) => {
      const toolUseId = "tu_cached_123"
      const assistant = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "bun test" } },
          ],
        },
      })
      const user = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: [{ type: "text", text: "3 pass\n2 fail" }],
            },
          ],
        },
      })
      const lines = [assistant, user]
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${lines.join("\n")}\n`, "utf-8")

      const fromFile = await extractPreviousOutput(path, 0, "test")
      const fromCache = await extractPreviousOutput(path, 0, "test", lines)

      expect(fromCache).toBe(fromFile)
      expect(fromCache).toContain("3 pass")
      expect(fromCache).toContain("2 fail")
    }))

  test("returns empty string with cached lines when no matching tool_result", () =>
    withDir(async (dir) => {
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_x", name: "Bash", input: { command: "bun test" } },
            ],
          },
        }),
      ]
      const path = join(dir, "t.jsonl")
      await writeFile(path, `${lines.join("\n")}\n`, "utf-8")

      const result = await extractPreviousOutput(path, 0, "test", lines)
      expect(result).toBe("")
    }))
})
