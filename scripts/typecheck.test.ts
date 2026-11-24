import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"
import { runTypecheck } from "./typecheck.ts"

const tmp = useTempDir("swiz-typecheck-fast-")

async function createFixture(): Promise<string> {
  const root = await realpath(await tmp.create())
  await mkdir(join(root, "src"))
  await Bun.write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src/**/*.ts"],
    })
  )
  return root
}

describe("fail-fast incremental typecheck", () => {
  test("stops after the first failing file and prioritizes changed files", async () => {
    const root = await createFixture()
    await Bun.write(join(root, "src", "a.ts"), 'export const a: number = "bad-a"\n')
    await Bun.write(join(root, "src", "b.ts"), "export const b: number = 2\n")
    await Bun.write(join(root, "src", "z.ts"), 'export const z: number = "bad-z"\n')

    const fast = await runTypecheck(root, {
      failFast: true,
      changedFiles: [join(root, "src", "z.ts")],
    })
    expect(fast.stoppedEarly).toBe(true)
    expect(fast.checkedFiles).toBe(1)
    expect(fast.diagnostics).toHaveLength(1)
    expect(fast.diagnostics[0]?.file?.fileName).toBe(join(root, "src", "z.ts"))

    const all = await runTypecheck(root, {
      failFast: false,
      changedFiles: [join(root, "src", "z.ts")],
    })
    expect(all.stoppedEarly).toBe(false)
    expect(all.checkedFiles).toBe(3)
    expect(all.diagnostics).toHaveLength(2)
  })

  test("writes incremental tsbuildinfo on clean pass and catches downstream breakage", async () => {
    const root = await createFixture()
    const buildInfo = join(root, ".cache", "tsconfig.tsbuildinfo")
    await Bun.write(
      join(root, "src", "provider.ts"),
      "export function value(): number { return 1 }\n"
    )
    await Bun.write(
      join(root, "src", "consumer.ts"),
      'import { value } from "./provider"\nexport const n: number = value()\n'
    )

    const clean = await runTypecheck(root, {
      changedFiles: [],
      tsBuildInfoFile: buildInfo,
    })
    expect(clean.diagnostics).toEqual([])
    expect(await Bun.file(buildInfo).exists()).toBe(true)

    // Break the exported return type; the unchanged consumer must still fail under incremental cache.
    await Bun.write(
      join(root, "src", "provider.ts"),
      'export function value(): string { return "nope" }\n'
    )
    const broken = await runTypecheck(root, {
      changedFiles: [join(root, "src", "provider.ts")],
      tsBuildInfoFile: buildInfo,
    })
    expect(broken.diagnostics).toHaveLength(1)
    expect(broken.diagnostics[0]?.file?.fileName).toBe(join(root, "src", "consumer.ts"))
  })
})
