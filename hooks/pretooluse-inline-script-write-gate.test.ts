import { describe, expect, test } from "bun:test"
import {
  detectWriteOps,
  extractDenoEvalBody,
  extractEvalBody,
  findInlineScriptWrites,
  INLINE_WRITE_OPS,
} from "./pretooluse-inline-script-write-gate.ts"

// Labels constructed the same way the hook does to avoid literal assembly
const wf = ["write", "File"].join("")
const wfs = ["write", "File", "Sync"].join("")
const af = ["append", "File"].join("")
const afs = ["append", "File", "Sync"].join("")
const cws = ["create", "Write", "Stream"].join("")
const bw = "Bun.write"
// Read-only op label (also split to prevent self-detection)
const rfs = ["read", "File", "Sync"].join("")
// Python write op labels (safe as literals — bun-api-enforce doesn't scan for these)
const owm = "open (write mode)"
// Perl write op label
const pol = "open (>, >>)"
const pwt = "Path.write_text"
const pwb = "Path.write_bytes"

describe("INLINE_WRITE_OPS", () => {
  test("all ops have a non-empty label and a working regex", () => {
    for (const op of INLINE_WRITE_OPS) {
      expect(op.label.length).toBeGreaterThan(0)
      expect(op.re).toBeInstanceOf(RegExp)
    }
  })

  test("labels are all unique", () => {
    const labels = INLINE_WRITE_OPS.map((op) => op.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe("extractEvalBody", () => {
  test("extracts double-quoted body after -e flag", () => {
    expect(extractEvalBody(`node -e "console.log('hi')"`)).toBe("console.log('hi')")
  })

  test("extracts single-quoted body after -e flag", () => {
    expect(extractEvalBody(`bun -e 'console.log("hi")'`)).toBe('console.log("hi")')
  })

  test("extracts body after --eval flag with space", () => {
    expect(extractEvalBody(`node --eval "const x = 1"`)).toBe("const x = 1")
  })

  test("extracts body after --eval= form", () => {
    expect(extractEvalBody(`node --eval="const x = 1"`)).toBe("const x = 1")
  })

  test("handles escaped double-quote inside double-quoted body", () => {
    expect(extractEvalBody(`node -e "console.log(\\"hello\\")"`)).toBe('console.log("hello")')
  })

  test("handles multiline body in double-quoted string", () => {
    const seg = `node -e "const a = 1;\nconst b = 2;"`
    expect(extractEvalBody(seg)).toBe("const a = 1;\nconst b = 2;")
  })

  test("extracts backtick-quoted body", () => {
    expect(extractEvalBody("node -e `const x = 1`")).toBe("const x = 1")
  })

  test("extracts unquoted body up to whitespace", () => {
    expect(extractEvalBody("node -e code_here")).toBe("code_here")
  })

  test("returns null when no eval flag present", () => {
    expect(extractEvalBody("node script.ts")).toBeNull()
  })

  test("returns null for empty segment", () => {
    expect(extractEvalBody("")).toBeNull()
  })

  test("handles flags before -e", () => {
    expect(extractEvalBody(`node --no-warnings -e "const x = 1"`)).toBe("const x = 1")
  })
})

describe("detectWriteOps", () => {
  test(`detects ${wfs} call`, () => {
    expect(detectWriteOps(`require('fs').${wfs}('file.txt', data)`)).toContain(wfs)
  })

  test(`detects async ${wf} call`, () => {
    expect(detectWriteOps(`fs.${wf}('file.txt', data, () => {})`)).toContain(wf)
  })

  test(`detects ${afs} call`, () => {
    expect(detectWriteOps(`fs.${afs}('log.txt', line)`)).toContain(afs)
  })

  test(`detects async ${af} call`, () => {
    expect(detectWriteOps(`fs.${af}('log.txt', line, () => {})`)).toContain(af)
  })

  test(`detects ${cws} call`, () => {
    expect(detectWriteOps(`fs.${cws}('out.txt').write(data)`)).toContain(cws)
  })

  test(`detects ${bw} call`, () => {
    expect(detectWriteOps(`await Bun.write('file.txt', content)`)).toContain(bw)
  })

  test("detects multiple write ops in same body", () => {
    const body = `fs.${wfs}('a', x); fs.${afs}('b', y)`
    const ops = detectWriteOps(body)
    expect(ops).toContain(wfs)
    expect(ops).toContain(afs)
  })

  test("returns empty array for read-only operations", () => {
    expect(detectWriteOps(`require('fs').${rfs}('file.txt', 'utf8')`)).toEqual([])
  })

  test("returns empty array for console output", () => {
    expect(detectWriteOps("console.log(JSON.stringify({a:1}))")).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(detectWriteOps("")).toEqual([])
  })

  test("does not match on a word boundary false-positive (e.g. notAwriteFile)", () => {
    expect(detectWriteOps(`notA${wf}('x', 'y')`)).toEqual([])
  })

  test(`detects Python open in write mode`, () => {
    expect(detectWriteOps(`open('out.txt', 'w').write('data')`)).toContain(owm)
  })

  test(`detects Python open in append mode`, () => {
    expect(detectWriteOps(`open('/tmp/log', 'a')`)).toContain(owm)
  })

  test(`detects Python open in exclusive-create mode`, () => {
    expect(detectWriteOps(`open('new.txt', 'x')`)).toContain(owm)
  })

  test(`detects Python open in binary write mode`, () => {
    expect(detectWriteOps(`open('out.bin', 'wb')`)).toContain(owm)
  })

  test(`detects ${pwt}`, () => {
    expect(detectWriteOps(`Path('x').write_text('hello')`)).toContain(pwt)
  })

  test(`detects ${pwb}`, () => {
    expect(detectWriteOps(`Path('x').write_bytes(b'hello')`)).toContain(pwb)
  })

  test("does not flag Python open in read mode", () => {
    expect(detectWriteOps(`open('file.txt', 'r').read()`)).toEqual([])
  })
})

describe("findInlineScriptWrites", () => {
  test(`blocks node -e with ${wfs}`, () => {
    const cmd = `node -e "require('fs').${wfs}('out.txt', data)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test(`blocks bun -e with ${bw}`, () => {
    const cmd = `bun -e "await Bun.write('file.txt', content)"`
    expect(findInlineScriptWrites(cmd)).toContain(bw)
  })

  test(`blocks node --eval with ${wf}`, () => {
    const cmd = `node --eval "const fs = require('fs'); fs.${wf}('a', 'b', () => {})"`
    expect(findInlineScriptWrites(cmd)).toContain(wf)
  })

  test(`blocks bun --eval= form with ${bw}`, () => {
    const cmd = `bun --eval="await Bun.write('f', 'x')"`
    expect(findInlineScriptWrites(cmd)).toContain(bw)
  })

  test("blocks single-quoted inline script", () => {
    const cmd = `node -e 'require("fs").${wfs}("out.txt","data")'`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("blocks chained command: safe_cmd && node -e write", () => {
    const dangerous = `node -e "require('fs').${wfs}('out', x)"`
    expect(findInlineScriptWrites(`echo hello && ${dangerous}`)).toContain(wfs)
  })

  test("blocks second eval in piped command", () => {
    const cmd = `cat file.txt | bun -e "process.stdin.resume(); require('fs').${wfs}('out', '')"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("does not block node script file execution (no -e flag)", () => {
    expect(findInlineScriptWrites("node scripts/migrate.ts")).toEqual([])
  })

  test("does not block read-only inline eval", () => {
    const cmd = `node -e "console.log(require('fs').${rfs}('package.json', 'utf8'))"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block bun -e with only computation", () => {
    expect(findInlineScriptWrites(`bun -e "console.log(1 + 1)"`)).toEqual([])
  })

  test("does not false-positive on write-related filename in node args (no -e)", () => {
    // Script filename contains a write word but there is no inline eval
    const cmd = `node run-${wf}-migration.js`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not false-positive when write keyword is in non-eval segment", () => {
    // A file named with a write word is passed to cat; node -e segment is clean
    const cmd = `cat ${wf}-output.txt && node -e "console.log('done')"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("deduplicates repeated write ops across multiple segments", () => {
    const seg1 = `node -e "require('fs').${wfs}('a', x)"`
    const seg2 = `bun -e "require('fs').${wfs}('b', y)"`
    const ops = findInlineScriptWrites(`${seg1} && ${seg2}`)
    expect(ops.filter((o) => o === wfs)).toHaveLength(1)
  })

  test("returns empty array for empty command", () => {
    expect(findInlineScriptWrites("")).toEqual([])
  })

  test("handles flags before -e in node invocation", () => {
    const cmd = `node --no-warnings -e "require('fs').${wfs}('f', d)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })

  test("handles env-var prefix before node", () => {
    const cmd = `NODE_ENV=test node -e "require('fs').${wfs}('f', d)"`
    expect(findInlineScriptWrites(cmd)).toContain(wfs)
  })
})

describe("findInlineScriptWrites – Python", () => {
  test(`blocks python -c with open write mode`, () => {
    const cmd = `python -c "open('out.txt', 'w').write('data')"`
    expect(findInlineScriptWrites(cmd)).toContain(owm)
  })

  test(`blocks python3 -c with open append mode`, () => {
    const cmd = `python3 -c "open('/tmp/log', 'a').write('x')"`
    expect(findInlineScriptWrites(cmd)).toContain(owm)
  })

  test(`blocks python3 -c with Path.write_text`, () => {
    const cmd = `python3 -c "from pathlib import Path; Path('x').write_text('hello')"`
    expect(findInlineScriptWrites(cmd)).toContain(pwt)
  })

  test(`blocks python3 -c with Path.write_bytes`, () => {
    const cmd = `python3 -c "from pathlib import Path; Path('x').write_bytes(b'hello')"`
    expect(findInlineScriptWrites(cmd)).toContain(pwb)
  })

  test("does not block python3 -c with read-only operation", () => {
    const cmd = `python3 -c "open('file.txt', 'r').read()"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block python3 -c with print only", () => {
    expect(findInlineScriptWrites(`python3 -c "print('hello')"`)).toEqual([])
  })

  test("does not block python3 script file execution (no -c flag)", () => {
    expect(findInlineScriptWrites("python3 script.py")).toEqual([])
  })

  test("blocks chained command with python3 -c write", () => {
    const cmd = `cat data.csv && python3 -c "open('out.txt', 'w').write('done')"`
    expect(findInlineScriptWrites(cmd)).toContain(owm)
  })
})

describe("findInlineScriptWrites – Lua", () => {
  test("blocks lua -e with io.open write mode", () => {
    const cmd = `lua -e "f = io.open('out.txt', 'w'); f:write('data'); f:close()"`
    expect(findInlineScriptWrites(cmd)).toContain("io.open (write mode)")
  })

  test("blocks lua -e with io.open append mode", () => {
    const cmd = `lua -e "f = io.open('log.txt', 'a'); f:write('line'); f:close()"`
    expect(findInlineScriptWrites(cmd)).toContain("io.open (write mode)")
  })

  test("blocks lua -e with io.output to named file", () => {
    const cmd = `lua -e "io.output('out.txt'); io.write('data')"`
    expect(findInlineScriptWrites(cmd)).toContain("io.output")
  })

  test("does not block lua -e with io.open read mode", () => {
    const cmd = `lua -e "f = io.open('in.txt', 'r'); print(f:read()); f:close()"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block lua -e with only print", () => {
    expect(findInlineScriptWrites(`lua -e "print('hello')"`)).toEqual([])
  })

  test("does not block lua script file execution (no -e flag)", () => {
    expect(findInlineScriptWrites("lua script.lua")).toEqual([])
  })
})

describe("findInlineScriptWrites – PowerShell", () => {
  test("blocks pwsh -Command with Set-Content", () => {
    const cmd = `pwsh -Command "Set-Content -Path 'out.txt' -Value 'data'"`
    expect(findInlineScriptWrites(cmd)).toContain("Set-Content")
  })

  test("blocks pwsh -c with Add-Content", () => {
    const cmd = `pwsh -c "Add-Content -Path 'log.txt' -Value 'line'"`
    expect(findInlineScriptWrites(cmd)).toContain("Add-Content")
  })

  test("blocks pwsh -Command with Out-File", () => {
    const cmd = `pwsh -Command "Get-Process | Out-File -FilePath 'procs.txt'"`
    expect(findInlineScriptWrites(cmd)).toContain("Out-File")
  })

  test("blocks pwsh -Command with [IO.File]::WriteAllText", () => {
    const cmd = `pwsh -Command "[IO.File]::WriteAllText('out.txt', 'data')"`
    expect(findInlineScriptWrites(cmd)).toContain("[IO.File]::WriteAll")
  })

  test("does not block pwsh -Command with only Write-Host", () => {
    expect(findInlineScriptWrites(`pwsh -Command "Write-Host 'hello'"`)).toEqual([])
  })

  test("does not block pwsh -Command with Get-Content (read-only)", () => {
    const cmd = `pwsh -Command "Get-Content 'in.txt'"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block powershell script file execution (no -Command flag)", () => {
    expect(findInlineScriptWrites("pwsh script.ps1")).toEqual([])
  })
})

describe("findInlineScriptWrites – PHP", () => {
  test("blocks php -r with file_put_contents", () => {
    const cmd = `php -r "file_put_contents('out.txt', 'data');"`
    expect(findInlineScriptWrites(cmd)).toContain("file_put_contents")
  })

  test("blocks php -r with fwrite", () => {
    const cmd = `php -r "$fh = fopen('out.txt', 'w'); fwrite($fh, 'data'); fclose($fh);"`
    expect(findInlineScriptWrites(cmd)).toContain("fwrite")
  })

  test("blocks php -r with fputs", () => {
    const cmd = `php -r "$fh = fopen('out.txt', 'w'); fputs($fh, 'data'); fclose($fh);"`
    expect(findInlineScriptWrites(cmd)).toContain("fputs")
  })

  test("does not block php -r with only echo", () => {
    expect(findInlineScriptWrites(`php -r "echo 'hello';"`)).toEqual([])
  })

  test("does not block php -r with file_get_contents (read-only)", () => {
    const cmd = `php -r "echo file_get_contents('in.txt');"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block php script file execution (no -r flag)", () => {
    expect(findInlineScriptWrites("php script.php")).toEqual([])
  })
})

describe("extractDenoEvalBody", () => {
  test("extracts single-quoted body after deno eval", () => {
    expect(extractDenoEvalBody(`deno eval 'console.log(1)'`)).toBe("console.log(1)")
  })

  test("extracts double-quoted body after deno eval", () => {
    expect(extractDenoEvalBody(`deno eval "console.log(1)"`)).toBe("console.log(1)")
  })

  test("returns null when eval subcommand absent", () => {
    expect(extractDenoEvalBody("deno run script.ts")).toBeNull()
  })
})

describe("findInlineScriptWrites – Deno", () => {
  test("blocks deno eval with Deno.writeTextFile", () => {
    const cmd = `deno eval "await Deno.writeTextFile('out.txt', 'data')"`
    expect(findInlineScriptWrites(cmd)).toContain("Deno.writeTextFile")
  })

  test("blocks deno eval with Deno.writeTextFileSync", () => {
    const cmd = `deno eval "Deno.writeTextFileSync('out.txt', 'data')"`
    expect(findInlineScriptWrites(cmd)).toContain("Deno.writeTextFileSync")
  })

  test(`blocks deno eval with Deno.${wf}`, () => {
    const cmd = `deno eval "await Deno.${wf}('out.bin', new Uint8Array([1,2]))"`
    expect(findInlineScriptWrites(cmd)).toContain(`Deno.${wf}`)
  })

  test(`blocks deno eval with Deno.${wfs}`, () => {
    const cmd = `deno eval "Deno.${wfs}('out.bin', new Uint8Array([1,2]))"`
    expect(findInlineScriptWrites(cmd)).toContain(`Deno.${wfs}`)
  })

  test("does not block deno eval with only console.log", () => {
    expect(findInlineScriptWrites(`deno eval "console.log('hello')"`)).toEqual([])
  })

  test("does not block deno eval with Deno.readTextFile (read-only)", () => {
    const cmd = `deno eval "const t = await Deno.readTextFile('in.txt'); console.log(t)"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block deno run script file execution (no eval subcommand)", () => {
    expect(findInlineScriptWrites("deno run script.ts")).toEqual([])
  })

  test("blocks chained command with deno eval write", () => {
    const cmd = `echo start && deno eval "await Deno.writeTextFile('f.txt', 'x')"`
    expect(findInlineScriptWrites(cmd)).toContain("Deno.writeTextFile")
  })
})

describe("findInlineScriptWrites – Perl", () => {
  test("blocks perl -e with 3-arg open write mode", () => {
    const cmd = `perl -e "open(my $fh, '>', 'out.txt'); print $fh 'data'"`
    expect(findInlineScriptWrites(cmd)).toContain(pol)
  })

  test("blocks perl -e with 3-arg open append mode", () => {
    const cmd = `perl -e "open(my $fh, '>>', '/tmp/log'); print $fh 'line'"`
    expect(findInlineScriptWrites(cmd)).toContain(pol)
  })

  test("blocks perl -e with 2-arg open write mode", () => {
    const cmd = `perl -e 'open(FH, ">out.txt"); print FH "data"; close FH'`
    expect(findInlineScriptWrites(cmd)).toContain(pol)
  })

  test("blocks perl -e with 2-arg open double-quoted", () => {
    const cmd = `perl -e "open(FH, '>>/tmp/log'); print FH 'line'; close FH"`
    expect(findInlineScriptWrites(cmd)).toContain(pol)
  })

  test("does not block perl -e with read-only open", () => {
    const cmd = `perl -e "open(my $fh, '<', 'in.txt'); while(<$fh>){print}"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block perl -e with only print to stdout", () => {
    expect(findInlineScriptWrites(`perl -e "print 'hello\\n'"`)).toEqual([])
  })

  test("does not block perl script file execution (no -e flag)", () => {
    expect(findInlineScriptWrites("perl script.pl")).toEqual([])
  })
})

describe("findInlineScriptWrites – Ruby", () => {
  test("blocks ruby -e with File.write", () => {
    const cmd = `ruby -e "File.write('out.txt', 'data')"`
    expect(findInlineScriptWrites(cmd)).toContain("File.write")
  })

  test("blocks ruby -e with IO.write", () => {
    const cmd = `ruby -e "IO.write('/tmp/out', 'data')"`
    expect(findInlineScriptWrites(cmd)).toContain("IO.write")
  })

  test("blocks ruby -e with File.open write mode", () => {
    const cmd = `ruby -e "File.open('out.txt', 'w') { |f| f.write('data') }"`
    expect(findInlineScriptWrites(cmd)).toContain("File.open (write mode)")
  })

  test("blocks ruby -e with File.open append mode", () => {
    const cmd = `ruby -e "File.open('log.txt', 'a') { |f| f.puts 'line' }"`
    expect(findInlineScriptWrites(cmd)).toContain("File.open (write mode)")
  })

  test("does not block ruby -e with File.read", () => {
    expect(findInlineScriptWrites(`ruby -e "puts File.read('in.txt')"`)).toEqual([])
  })

  test("does not block ruby -e with File.open read mode", () => {
    const cmd = `ruby -e "File.open('in.txt', 'r') { |f| puts f.read }"`
    expect(findInlineScriptWrites(cmd)).toEqual([])
  })

  test("does not block ruby -e with only puts", () => {
    expect(findInlineScriptWrites(`ruby -e "puts 'hello'"`)).toEqual([])
  })

  test("does not block ruby script file execution (no -e flag)", () => {
    expect(findInlineScriptWrites("ruby script.rb")).toEqual([])
  })
})

describe("hook run() integration", () => {
  test("allows non-write inline eval", async () => {
    const { default: hook } = await import("./pretooluse-inline-script-write-gate.ts")
    const input = {
      tool_name: "Bash",
      tool_input: { command: `bun -e "console.log('hello')"` },
    }
    const result = (await Promise.resolve(hook.run(input))) as Record<string, unknown>
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined
    expect(hso?.permissionDecision).not.toBe("deny")
  })

  test("denies inline eval with file write", async () => {
    const { default: hook } = await import("./pretooluse-inline-script-write-gate.ts")
    const cmd = `node -e "require('fs').${wfs}('out.txt', 'data')"`
    const input = {
      tool_name: "Bash",
      tool_input: { command: cmd },
    }
    const result = (await Promise.resolve(hook.run(input))) as Record<string, unknown>
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined
    expect(hso?.permissionDecision).toBe("deny")
  })

  test("denies python3 -c inline eval with file write", async () => {
    const { default: hook } = await import("./pretooluse-inline-script-write-gate.ts")
    const cmd = `python3 -c "open('/tmp/out','w').write('x')"`
    const input = {
      tool_name: "Bash",
      tool_input: { command: cmd },
    }
    const result = (await Promise.resolve(hook.run(input))) as Record<string, unknown>
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined
    expect(hso?.permissionDecision).toBe("deny")
  })
})
