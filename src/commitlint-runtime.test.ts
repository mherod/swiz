import { describe, expect, test } from "bun:test"
import { chmod, mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-commitlint-runtime-")
const projectRoot = join(import.meta.dir, "..")

async function runCommitHook(message: string) {
  const cwd = await tmp.create()
  await mkdir(join(cwd, ".git"))
  const config = parse(await Bun.file(join(projectRoot, "lefthook.yml")).text())
  const command = config["commit-msg"].commands.commitlint.run.replaceAll("{1}", "COMMIT_EDITMSG")
  await Bun.write(join(cwd, "COMMIT_EDITMSG"), message)
  await Bun.write(
    join(cwd, "commitlint.config.cjs"),
    await Bun.file(join(projectRoot, "commitlint.config.cjs")).text()
  )
  await symlink(join(projectRoot, "node_modules"), join(cwd, "node_modules"))
  await symlink(process.execPath, join(cwd, "bunx"))
  await symlink(process.execPath, join(cwd, "bun"))
  const mocks = {
    swiz: "#!/bin/sh\ncat >/dev/null\n",
    node: "#!/bin/sh\necho 'Unexpected external invocation: node' >&2\nexit 97\n",
    git: '#!/bin/sh\n[ "$*" = "interpret-trailers --parse" ] || exit 97\ncat\n',
  }
  for (const [name, script] of Object.entries(mocks)) {
    await Bun.write(join(cwd, name), script)
    await chmod(join(cwd, name), 0o755)
  }
  const proc = Bun.spawn(["/bin/sh", "-c", command], {
    cwd,
    env: { ...process.env, HOME: cwd, PATH: `${cwd}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { exitCode: proc.exitCode, output: stdout + stderr }
}

describe("commit-msg runtime", () => {
  test("accepts a conventional commit with mocked Git and no usable Node executable", async () => {
    const result = await runCommitHook("fix(hooks): preserve Bun runtime\n")
    expect(result.output).not.toContain("Unexpected external invocation")
    expect(result.exitCode).toBe(0)
  })

  test("rejects an invalid subject through the configured rules", async () => {
    const result = await runCommitHook("invalid commit subject\n")
    expect(result.output).not.toContain("Unexpected external invocation")
    expect(result.output).toContain("type-empty")
    expect(result.exitCode).toBe(1)
  })

  test("retains the forbidden attribution rule", async () => {
    const result = await runCommitHook("fix(hooks): preserve rules\n\nCo-authored-by: test\n")
    expect(result.output).not.toContain("Unexpected external invocation")
    expect(result.output).toContain("trailer-exists")
    expect(result.exitCode).toBe(1)
  })
})
