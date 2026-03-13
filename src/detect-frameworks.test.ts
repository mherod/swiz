import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _clearFrameworkCache, detectFrameworks } from "./detect-frameworks.ts"

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "swiz-detect-frameworks-"))
})

afterEach(() => {
  // Clear cache between tests so each fixture gets a fresh detection result
  _clearFrameworkCache()
})

// afterAll runs after all tests in the file; clean up the temp tree
import { afterAll } from "bun:test"

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

async function fixture(name: string): Promise<string> {
  const dir = join(tmpDir, name)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writePkg(dir: string, content: object): Promise<void> {
  await Bun.write(join(dir, "package.json"), JSON.stringify(content))
}

// ─── Empty project ────────────────────────────────────────────────────────────

describe("empty project", () => {
  it("returns an empty Set when no indicator files exist", async () => {
    const dir = await fixture("empty")
    expect((await detectFrameworks(dir)).size).toBe(0)
  })
})

// ─── Next.js ─────────────────────────────────────────────────────────────────

describe("nextjs detection", () => {
  it("detects next.config.js", async () => {
    const dir = await fixture("next-config-js")
    await Bun.write(join(dir, "next.config.js"), "module.exports = {}")
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("detects next.config.ts", async () => {
    const dir = await fixture("next-config-ts")
    await Bun.write(join(dir, "next.config.ts"), "export default {}")
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("detects next.config.mjs", async () => {
    const dir = await fixture("next-config-mjs")
    await Bun.write(join(dir, "next.config.mjs"), "export default {}")
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("detects next.config.cjs", async () => {
    const dir = await fixture("next-config-cjs")
    await Bun.write(join(dir, "next.config.cjs"), "module.exports = {}")
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("detects 'next' in dependencies", async () => {
    const dir = await fixture("next-dep")
    await writePkg(dir, { dependencies: { next: "14.0.0", react: "18.0.0" } })
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("detects 'next' in devDependencies", async () => {
    const dir = await fixture("next-devdep")
    await writePkg(dir, { devDependencies: { next: "14.0.0" } })
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(true)
  })

  it("does not detect nextjs when package.json has no next dep", async () => {
    const dir = await fixture("next-absent")
    await writePkg(dir, { dependencies: { react: "18.0.0" } })
    expect((await detectFrameworks(dir)).has("nextjs")).toBe(false)
  })
})

// ─── Vite ─────────────────────────────────────────────────────────────────────

describe("vite detection", () => {
  it("detects vite.config.js", async () => {
    const dir = await fixture("vite-js")
    await Bun.write(join(dir, "vite.config.js"), "export default {}")
    expect((await detectFrameworks(dir)).has("vite")).toBe(true)
  })

  it("detects vite.config.ts", async () => {
    const dir = await fixture("vite-ts")
    await Bun.write(join(dir, "vite.config.ts"), "export default {}")
    expect((await detectFrameworks(dir)).has("vite")).toBe(true)
  })

  it("detects 'vite' in dependencies", async () => {
    const dir = await fixture("vite-dep")
    await writePkg(dir, { devDependencies: { vite: "5.0.0" } })
    expect((await detectFrameworks(dir)).has("vite")).toBe(true)
  })
})

// ─── Express ─────────────────────────────────────────────────────────────────

describe("express detection", () => {
  it("detects 'express' in dependencies", async () => {
    const dir = await fixture("express-dep")
    await writePkg(dir, { dependencies: { express: "4.18.0" } })
    expect((await detectFrameworks(dir)).has("express")).toBe(true)
  })

  it("does not detect express when dep is absent", async () => {
    const dir = await fixture("express-absent")
    await writePkg(dir, { dependencies: { koa: "2.0.0" } })
    expect((await detectFrameworks(dir)).has("express")).toBe(false)
  })
})

// ─── Fastify ─────────────────────────────────────────────────────────────────

describe("fastify detection", () => {
  it("detects 'fastify' in dependencies", async () => {
    const dir = await fixture("fastify-dep")
    await writePkg(dir, { dependencies: { fastify: "4.0.0" } })
    expect((await detectFrameworks(dir)).has("fastify")).toBe(true)
  })
})

// ─── NestJS ──────────────────────────────────────────────────────────────────

describe("nestjs detection", () => {
  it("detects '@nestjs/core' in dependencies", async () => {
    const dir = await fixture("nestjs-dep")
    await writePkg(dir, { dependencies: { "@nestjs/core": "10.0.0" } })
    expect((await detectFrameworks(dir)).has("nestjs")).toBe(true)
  })
})

// ─── Remix ───────────────────────────────────────────────────────────────────

describe("remix detection", () => {
  it("detects remix.config.js", async () => {
    const dir = await fixture("remix-config-js")
    await Bun.write(join(dir, "remix.config.js"), "module.exports = {}")
    expect((await detectFrameworks(dir)).has("remix")).toBe(true)
  })

  it("detects remix.config.ts", async () => {
    const dir = await fixture("remix-config-ts")
    await Bun.write(join(dir, "remix.config.ts"), "export default {}")
    expect((await detectFrameworks(dir)).has("remix")).toBe(true)
  })

  it("detects '@remix-run/node' in dependencies", async () => {
    const dir = await fixture("remix-dep")
    await writePkg(dir, { dependencies: { "@remix-run/node": "2.0.0" } })
    expect((await detectFrameworks(dir)).has("remix")).toBe(true)
  })
})

// ─── Astro ───────────────────────────────────────────────────────────────────

describe("astro detection", () => {
  it("detects astro.config.mjs", async () => {
    const dir = await fixture("astro-config-mjs")
    await Bun.write(join(dir, "astro.config.mjs"), "export default {}")
    expect((await detectFrameworks(dir)).has("astro")).toBe(true)
  })

  it("detects 'astro' in dependencies", async () => {
    const dir = await fixture("astro-dep")
    await writePkg(dir, { dependencies: { astro: "4.0.0" } })
    expect((await detectFrameworks(dir)).has("astro")).toBe(true)
  })
})

// ─── Python ──────────────────────────────────────────────────────────────────

describe("python detection", () => {
  it("detects pyproject.toml", async () => {
    const dir = await fixture("python-pyproject")
    await Bun.write(join(dir, "pyproject.toml"), "[tool.poetry]\nname = 'app'\n")
    expect((await detectFrameworks(dir)).has("python")).toBe(true)
  })

  it("detects setup.py", async () => {
    const dir = await fixture("python-setup")
    await Bun.write(join(dir, "setup.py"), "from setuptools import setup\n")
    expect((await detectFrameworks(dir)).has("python")).toBe(true)
  })

  it("detects requirements.txt", async () => {
    const dir = await fixture("python-requirements")
    await Bun.write(join(dir, "requirements.txt"), "django==4.2.0\n")
    expect((await detectFrameworks(dir)).has("python")).toBe(true)
  })
})

// ─── Go ──────────────────────────────────────────────────────────────────────

describe("go detection", () => {
  it("detects go.mod", async () => {
    const dir = await fixture("go-mod")
    await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
    expect((await detectFrameworks(dir)).has("go")).toBe(true)
  })
})

// ─── Rust ─────────────────────────────────────────────────────────────────────

describe("rust detection", () => {
  it("detects Cargo.toml", async () => {
    const dir = await fixture("rust-cargo")
    await Bun.write(join(dir, "Cargo.toml"), "[package]\nname = 'app'\n")
    expect((await detectFrameworks(dir)).has("rust")).toBe(true)
  })
})

// ─── Ruby ─────────────────────────────────────────────────────────────────────

describe("ruby detection", () => {
  it("detects Gemfile", async () => {
    const dir = await fixture("ruby-gemfile")
    await Bun.write(join(dir, "Gemfile"), "source 'https://rubygems.org'\ngem 'rails'\n")
    expect((await detectFrameworks(dir)).has("ruby")).toBe(true)
  })
})

// ─── Java ─────────────────────────────────────────────────────────────────────

describe("java detection", () => {
  it("detects pom.xml", async () => {
    const dir = await fixture("java-pom")
    await Bun.write(join(dir, "pom.xml"), "<project></project>")
    expect((await detectFrameworks(dir)).has("java")).toBe(true)
  })

  it("detects build.gradle", async () => {
    const dir = await fixture("java-gradle")
    await Bun.write(join(dir, "build.gradle"), "plugins { id 'java' }")
    expect((await detectFrameworks(dir)).has("java")).toBe(true)
  })
})

// ─── PHP ──────────────────────────────────────────────────────────────────────

describe("php detection", () => {
  it("detects composer.json", async () => {
    const dir = await fixture("php-composer")
    await Bun.write(join(dir, "composer.json"), JSON.stringify({ require: { php: ">=8.1" } }))
    expect((await detectFrameworks(dir)).has("php")).toBe(true)
  })
})

// ─── Multi-framework ──────────────────────────────────────────────────────────

describe("multi-framework detection", () => {
  it("detects multiple frameworks simultaneously", async () => {
    const dir = await fixture("multi")
    // Monorepo root: Go service + Next.js frontend
    await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
    await Bun.write(join(dir, "next.config.ts"), "export default {}")
    const frameworks = await detectFrameworks(dir)
    expect(frameworks.has("go")).toBe(true)
    expect(frameworks.has("nextjs")).toBe(true)
  })

  it("detects all JS framework deps from a single package.json", async () => {
    const dir = await fixture("multi-js")
    await writePkg(dir, {
      dependencies: { express: "4.18.0", fastify: "4.0.0" },
    })
    const frameworks = await detectFrameworks(dir)
    expect(frameworks.has("express")).toBe(true)
    expect(frameworks.has("fastify")).toBe(true)
  })
})

// ─── Caching ──────────────────────────────────────────────────────────────────

describe("result caching", () => {
  it("returns equal results on repeated calls", async () => {
    const dir = await fixture("cache-test")
    await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
    const first = await detectFrameworks(dir)
    const second = await detectFrameworks(dir)
    expect(first).toEqual(second) // value equality (concurrent tests may clear shared cache)
  })

  it("different cwd values produce independent results", async () => {
    const dirA = await fixture("cache-a")
    const dirB = await fixture("cache-b")
    await Bun.write(join(dirA, "go.mod"), "module a\n\ngo 1.21\n")
    await Bun.write(join(dirB, "Cargo.toml"), "[package]\nname = 'b'\n")
    expect((await detectFrameworks(dirA)).has("go")).toBe(true)
    expect((await detectFrameworks(dirA)).has("rust")).toBe(false)
    expect((await detectFrameworks(dirB)).has("rust")).toBe(true)
    expect((await detectFrameworks(dirB)).has("go")).toBe(false)
  })
})

// ─── Plain CLI project (like swiz itself) ─────────────────────────────────────

describe("plain CLI / non-framework project", () => {
  it("does not detect any framework for a bare bun CLI project", async () => {
    const dir = await fixture("bun-cli")
    await writePkg(dir, {
      name: "my-cli",
      devDependencies: { "@biomejs/biome": "1.0.0" },
    })
    await Bun.write(join(dir, "bun.lockb"), "")
    const frameworks = await detectFrameworks(dir)
    expect(frameworks.has("nextjs")).toBe(false)
    expect(frameworks.has("vite")).toBe(false)
    expect(frameworks.has("go")).toBe(false)
    expect(frameworks.size).toBe(0)
  })
})
