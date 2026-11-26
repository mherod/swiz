import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"
import {
  classifyScriptName,
  type DiskHeavyCategory,
  evaluateLowDiskSpace,
  findDiskHeavyCommand,
  MIN_FREE_DISK_BYTES,
} from "./pretooluse-low-disk-space.ts"

const HOOK = "hooks/pretooluse-low-disk-space.ts"
const LOW_DISK_BYTES = 512 * 1024 * 1024 // 512 MiB (< 1 GiB)
const HEALTHY_DISK_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB (>= 1 GiB)

function shellInput(command: string, toolName = "Bash") {
  return {
    tool_name: toolName,
    tool_input: { command },
    cwd: process.cwd(),
    session_id: "test-low-disk-space",
  }
}

describe("pretooluse-low-disk-space", () => {
  describe("findDiskHeavyCommand — primary pnpm commands", () => {
    const cases: Array<[string, DiskHeavyCategory]> = [
      ["pnpm dev", "dev"],
      ["pnpm build", "build"],
      ["pnpm typecheck", "typecheck"],
      ["pnpm lint", "lint"],
      ["pnpm run dev", "dev"],
      ["pnpm run build", "build"],
      ["pnpm run typecheck", "typecheck"],
      ["pnpm run lint", "lint"],
      ["pnpm --filter @org/web dev", "dev"],
      ["pnpm --filter=@org/web run build", "build"],
      ["pnpm -r build", "build"],
      ["pnpm -C packages/app typecheck", "typecheck"],
      ["pnpm --dir apps/web lint:fix", "lint"],
      ["pnpm dev:web", "dev"],
      ["pnpm build:prod", "build"],
      ["pnpm type-check", "typecheck"],
      ["pnpm check-types", "typecheck"],
      ["pnpm check:types", "typecheck"],
      ["pnpm check", "lint"],
    ]

    test.each(cases)("detects %s as %s", (command, expectedCategory) => {
      const match = findDiskHeavyCommand(command)
      expect(match?.category).toBe(expectedCategory)
    })
  })

  describe("findDiskHeavyCommand — package manager & runner equivalents", () => {
    const cases: Array<[string, DiskHeavyCategory]> = [
      // npm
      ["npm run dev", "dev"],
      ["npm run build", "build"],
      ["npm run typecheck", "typecheck"],
      ["npm run lint", "lint"],
      ["npm --prefix apps/web run build", "build"],
      ["npm -w web run dev", "dev"],
      ["npm exec -- tsc --noEmit", "typecheck"],
      ["npm exec -c 'eslint .'", "lint"],
      // yarn
      ["yarn dev", "dev"],
      ["yarn build", "build"],
      ["yarn typecheck", "typecheck"],
      ["yarn lint", "lint"],
      ["yarn run build", "build"],
      ["yarn workspace @app/web dev", "dev"],
      ["yarn workspaces run build", "build"],
      ["yarn workspaces foreach -A run lint", "lint"],
      ["yarn dlx next build", "build"],
      // bun
      ["bun dev", "dev"],
      ["bun run dev", "dev"],
      ["bun build src/index.ts --outdir dist", "build"],
      ["bun run build", "build"],
      ["bun run typecheck", "typecheck"],
      ["bun run lint", "lint"],
      ["bun run lint:eslint", "lint"],
      ["bun --cwd apps/web run build", "build"],
      ["bun x tsc --noEmit", "typecheck"],
      // npx / pnpx / bunx / pnpm exec / pnpm dlx
      ["npx tsc --noEmit", "typecheck"],
      ["npx --yes eslint .", "lint"],
      ["npx -c 'next build'", "build"],
      ["pnpx next@15 dev", "dev"],
      ["bunx @biomejs/biome check .", "lint"],
      ["pnpm exec vite build", "build"],
      ["pnpm dlx oxlint", "lint"],
      // corepack / node --run / deno
      ["corepack pnpm build", "build"],
      ["node --run build", "build"],
      ["node --run=typecheck", "typecheck"],
      ["deno task dev", "dev"],
      ["deno lint", "lint"],
      ["deno check src/main.ts", "typecheck"],
      ["deno compile main.ts", "build"],
    ]

    test.each(cases)("detects %s as %s", (command, expectedCategory) => {
      const match = findDiskHeavyCommand(command)
      expect(match?.category).toBe(expectedCategory)
    })
  })

  describe("findDiskHeavyCommand — orchestrators & task runners", () => {
    const cases: Array<[string, DiskHeavyCategory]> = [
      ["turbo dev", "dev"],
      ["turbo run build", "build"],
      ["turbo run build --filter=web", "build"],
      ["turbo run web#typecheck", "typecheck"],
      ["pnpm turbo run lint", "lint"],
      ["npx turbo build", "build"],
      ["nx build web", "build"],
      ["nx run web:dev", "dev"],
      ["nx run-many --target=typecheck", "typecheck"],
      ["nx run-many -t lint", "lint"],
      ["nx affected --targets=build,test", "build"],
      ["nx affected:lint", "lint"],
      ["lerna run build", "build"],
      ["moon run :build", "build"],
      ["moon check", "lint"],
      ["make build", "build"],
      ["make dev", "dev"],
      ["just lint", "lint"],
      ["just typecheck", "typecheck"],
    ]

    test.each(cases)("detects %s as %s", (command, expectedCategory) => {
      const match = findDiskHeavyCommand(command)
      expect(match?.category).toBe(expectedCategory)
    })
  })

  describe("findDiskHeavyCommand — direct compiler/bundler/linter escape hatches", () => {
    const cases: Array<[string, DiskHeavyCategory]> = [
      ["tsc --noEmit", "typecheck"],
      ["tsgo --noEmit", "typecheck"],
      ["vue-tsc --noEmit", "typecheck"],
      ["svelte-check", "typecheck"],
      ["eslint .", "lint"],
      ["biome check .", "lint"],
      ["biome lint src", "lint"],
      ["biome ci .", "lint"],
      ["oxlint src", "lint"],
      ["stylelint '**/*.css'", "lint"],
      ["next dev", "dev"],
      ["next build", "build"],
      ["next lint", "lint"],
      ["vite", "dev"],
      ["vite dev", "dev"],
      ["vite build", "build"],
      ["nuxt dev", "dev"],
      ["nuxi build", "build"],
      ["nuxi typecheck", "typecheck"],
      ["astro dev", "dev"],
      ["astro build", "build"],
      ["astro check", "typecheck"],
      ["webpack --mode production", "build"],
      ["webpack-dev-server", "dev"],
      ["esbuild src/index.ts --bundle", "build"],
      ["rollup -c", "build"],
      ["tsup src/index.ts", "build"],
      ["rsbuild build", "build"],
      ["storybook dev -p 6006", "dev"],
      ["wrangler dev", "dev"],
      ["wrangler pages dev ./dist", "dev"],
      ["wrangler deploy", "build"],
      ["cargo build", "build"],
      ["cargo check", "typecheck"],
      ["cargo clippy", "lint"],
      ["go build ./...", "build"],
      ["go vet ./...", "lint"],
      // Direct paths & node_modules entrypoints
      ["./node_modules/.bin/tsc --noEmit", "typecheck"],
      ["node_modules/.bin/eslint .", "lint"],
      ["/opt/homebrew/bin/pnpm build", "build"],
      ["node ./node_modules/typescript/bin/tsc --noEmit", "typecheck"],
      ["node node_modules/next/dist/bin/next build", "build"],
      ["bun ./node_modules/.bin/biome check .", "lint"],
      ["$(pnpm bin)/tsc --noEmit", "typecheck"],
      ['"$(pnpm bin)"/next build', "build"],
      ["`npm bin`/eslint .", "lint"],
    ]

    test.each(cases)("detects %s as %s", (command, expectedCategory) => {
      const match = findDiskHeavyCommand(command)
      expect(match?.category).toBe(expectedCategory)
    })
  })

  describe("findDiskHeavyCommand — shell wrappers, chains, substitutions, and evasion", () => {
    const cases: Array<[string, DiskHeavyCategory]> = [
      ["NODE_ENV=production pnpm build", "build"],
      ["CI=true TURBO_FORCE=1 pnpm lint", "lint"],
      ["env NODE_ENV=production pnpm dev", "dev"],
      ['env -S "pnpm build"', "build"],
      ["command pnpm typecheck", "typecheck"],
      ["exec pnpm build", "build"],
      ["nohup pnpm dev &", "dev"],
      ["timeout 60 pnpm build", "build"],
      ["nice -n 10 pnpm lint", "lint"],
      ["time pnpm typecheck", "typecheck"],
      ["dotenv -- pnpm dev", "dev"],
      ["dotenvx run -- pnpm build", "build"],
      ['sh -c "pnpm build"', "build"],
      ["bash -lc 'tsc --noEmit'", "typecheck"],
      ['zsh -c "eslint ."', "lint"],
      ['eval "pnpm dev"', "dev"],
      ["echo starting && pnpm build", "build"],
      ["ls; pnpm lint", "lint"],
      ["(pnpm dev)", "dev"],
      ["{ pnpm typecheck; }", "typecheck"],
      ['echo "$(pnpm build)"', "build"],
      ["echo `tsc --noEmit`", "typecheck"],
      ["pnpm \\\n  build", "build"],
      ["\\pnpm build", "build"],
      ["'pnpm' lint", "lint"],
      ["\uFF50\uFF4E\uFF50\uFF4D build", "build"], // NFKC fullwidth "pnpm build"
      ["sh <<'EOF'\npnpm build\nEOF", "build"],
      ["cat <<EOF\n$(pnpm typecheck)\nEOF", "typecheck"],
    ]

    test.each(cases)("detects evasion form %j as %s", (command, expectedCategory) => {
      const match = findDiskHeavyCommand(command)
      expect(match?.category).toBe(expectedCategory)
    })
  })

  describe("findDiskHeavyCommand — safe / unrelated commands remain allowed", () => {
    const allowed = [
      "df -h",
      "du -sh *",
      "trash .next",
      "pnpm store prune",
      "pnpm cache delete",
      "npm cache clean --force",
      "bun pm cache rm",
      "pnpm test",
      "bun test src/foo.test.ts",
      "pnpm install",
      "bun run format",
      "bun run scripts/check-disk-space.ts",
      "pnpm check:disk",
      "biome format --write .",
      "git status",
      'git commit -m "fix pnpm build error"',
      'rg "pnpm dev" src/',
      'echo "run pnpm lint and tsc"',
      "printf '%s\\n' 'pnpm build; eslint .'",
      "sh -c \"echo 'pnpm build'\"",
      "cat <<'EOF'\npnpm build\ntsc --noEmit\nEOF",
      "pnpm --version",
      "pnpm build --help",
      "tsc --version",
      "tsc -v",
      "eslint -h",
      "biome --version",
      "command -v pnpm",
      "which eslint",
      "make clean",
      "make check",
    ]

    test.each(allowed)("allows %s", (command) => {
      expect(findDiskHeavyCommand(command)).toBeNull()
    })
  })

  describe("classifyScriptName", () => {
    test("classifies common variants and ignores unrelated script names", () => {
      expect(classifyScriptName("dev")).toBe("dev")
      expect(classifyScriptName("start:dev")).toBe("dev")
      expect(classifyScriptName("build:prod")).toBe("build")
      expect(classifyScriptName("type-check")).toBe("typecheck")
      expect(classifyScriptName("lint:ci")).toBe("lint")
      expect(classifyScriptName("check", { allowBareCheck: true })).toBe("lint")
      expect(classifyScriptName("check", { allowBareCheck: false })).toBeNull()
      expect(classifyScriptName("test")).toBeNull()
      expect(classifyScriptName("check:disk")).toBeNull()
    })
  })

  describe("evaluateLowDiskSpace — threshold and fail-open behavior", () => {
    test("denies when free space is below 1 GiB", async () => {
      const result = await evaluateLowDiskSpace(shellInput("pnpm build"), () =>
        Promise.resolve(LOW_DISK_BYTES)
      )
      expect("hookSpecificOutput" in result).toBe(true)
      const hso = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
      expect(hso?.permissionDecision).toBe("deny")
      expect(hso?.permissionDecisionReason).toContain("512 MiB")
      expect(hso?.permissionDecisionReason).toContain("1 GiB")
      expect(hso?.permissionDecisionReason).toContain("pnpm build")
    })

    test("denies at 1 byte below 1 GiB", async () => {
      const result = await evaluateLowDiskSpace(shellInput("pnpm dev"), () =>
        Promise.resolve(MIN_FREE_DISK_BYTES - 1)
      )
      const hso = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
      expect(hso?.permissionDecision).toBe("deny")
    })

    test("allows at exactly 1 GiB free space", async () => {
      const result = await evaluateLowDiskSpace(shellInput("pnpm build"), () =>
        Promise.resolve(MIN_FREE_DISK_BYTES)
      )
      expect(result).toEqual({})
    })

    test("allows when free space exceeds 1 GiB", async () => {
      const result = await evaluateLowDiskSpace(shellInput("pnpm lint"), () =>
        Promise.resolve(HEALTHY_DISK_BYTES)
      )
      expect(result).toEqual({})
    })

    test("fails open when disk space cannot be determined", async () => {
      const result = await evaluateLowDiskSpace(shellInput("pnpm typecheck"), () =>
        Promise.resolve(null)
      )
      expect(result).toEqual({})
    })

    test("does not query disk space for unrelated commands", async () => {
      let called = false
      const result = await evaluateLowDiskSpace(shellInput("pnpm store prune"), () => {
        called = true
        return Promise.resolve(0)
      })
      expect(result).toEqual({})
      expect(called).toBe(false)
    })

    test("ignores non-shell tools", async () => {
      let called = false
      const result = await evaluateLowDiskSpace(shellInput("pnpm build", "Read"), () => {
        called = true
        return Promise.resolve(0)
      })
      expect(result).toEqual({})
      expect(called).toBe(false)
    })

    test("enforces across cross-agent shell tool aliases", async () => {
      for (const toolName of [
        "Bash",
        "Shell",
        "run_shell_command",
        "shell_command",
        "exec_command",
      ]) {
        const result = await evaluateLowDiskSpace(shellInput("tsc --noEmit", toolName), () =>
          Promise.resolve(LOW_DISK_BYTES)
        )
        const hso = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
        expect(hso?.permissionDecision).toBe("deny")
      }
    })
  })

  describe("standalone script contract", () => {
    test("exits cleanly with no output for unrelated commands", async () => {
      const result = await runBashHook(HOOK, "df -h")
      expect(result.decision).toBeUndefined()
      expect(result.stdout).toBe("")
    })
  })
})
