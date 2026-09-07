import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { clearCaches } from "@typescript-eslint/parser"
import { ESLint } from "eslint"
import { useTempDir } from "../src/utils/test-utils.ts"
import { createTypeFingerprint } from "./lint-eslint.ts"

const tmp = useTempDir("swiz-eslint-cache-")
const tseslintModule = join(import.meta.dir, "../node_modules/typescript-eslint/dist/index.js")

async function fixture(): Promise<string> {
  const root = await realpath(await tmp.create())
  await mkdir(join(root, "src"))
  await Bun.write(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        types: [],
      },
      include: ["src/**/*.ts"],
    })
  )
  await Bun.write(
    join(root, "src", "consumer.ts"),
    'import { work } from "./provider.js"\nwork()\n'
  )
  await Bun.write(join(root, "src", "provider.d.ts"), "export declare function work(): void\n")
  await Bun.write(
    join(root, "eslint.config.mjs"),
    `
import tseslint from ${JSON.stringify(tseslintModule)}
export default [{
  files: ["**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: import.meta.dirname,
      // This fixture performs several independent lint runs in the same process.
      disallowAutomaticSingleRunInference: true,
    },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  settings: { swizTypeFingerprint: process.env.SWIZ_ESLINT_TYPE_FINGERPRINT },
  rules: { "@typescript-eslint/no-floating-promises": "error" },
}]
`
  )
  return root
}

async function lintConsumer(root: string, fingerprint: string): Promise<ESLint.LintResult[]> {
  /** Each production invocation starts with a fresh parser process. */
  clearCaches()
  const eslint = new ESLint({
    cwd: root,
    cache: true,
    cacheStrategy: "content",
    overrideConfig: { settings: { swizTypeFingerprint: fingerprint } },
  })
  return eslint.lintFiles(["src/consumer.ts"])
}

describe("ESLint dependency cache", () => {
  test("invalidates an unchanged consumer after its imported declaration changes", async () => {
    const root = await fixture()
    const before = await createTypeFingerprint(root)
    expect((await lintConsumer(root, before))[0]?.messages).toEqual([])
    expect(await createTypeFingerprint(root)).toBe(before)

    await Bun.write(
      join(root, "src", "provider.d.ts"),
      "export declare function work(): Promise<void>\n"
    )
    const after = await createTypeFingerprint(root)
    expect(after).not.toBe(before)
    // ESLint's ordinary per-file cache misses this dependency-only change.
    expect((await lintConsumer(root, before))[0]?.errorCount).toBe(0)
    const result = await lintConsumer(root, after)
    expect(result[0]?.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-floating-promises",
    ])
  })

  test("invalidates on source additions, compiler settings and dependency inputs", async () => {
    const root = await fixture()
    let previous = await createTypeFingerprint(root)
    for (const [name, content] of [
      ["src/extra.ts", "export const extra = 1\n"],
      [
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src/**/*.ts"] }),
      ],
      ["package.json", JSON.stringify({ type: "module" })],
      ["bun.lock", "dependency-version-changed"],
    ]) {
      await Bun.write(join(root, name!), content!)
      const next = await createTypeFingerprint(root)
      expect(next).not.toBe(previous)
      previous = next
    }
  })

  test("refuses to fingerprint invalid compiler configuration", async () => {
    const root = await fixture()
    await Bun.write(join(root, "tsconfig.json"), '{"compilerOptions":{"target":"invalid"}}')
    await expect(createTypeFingerprint(root)).rejects.toThrow()
  })
})
