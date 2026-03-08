import { describe, expect, test } from "bun:test"
import { bashMutatesWorkspace, classifyCommand } from "../hooks/pretooluse-repeated-lint-test.ts"

// ── classifyCommand ───────────────────────────────────────────────────────────

describe("classifyCommand", () => {
  test("detects bun test", () => {
    expect(classifyCommand("bun test")).toBe("test")
    expect(classifyCommand("bun test --watch")).toBe("test")
    expect(classifyCommand("cd src && bun test")).toBe("test")
  })

  test("detects bun run lint / typecheck / check", () => {
    expect(classifyCommand("bun run lint")).toBe("lint")
    expect(classifyCommand("bun run typecheck")).toBe("lint")
    expect(classifyCommand("bun run check")).toBe("lint")
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
