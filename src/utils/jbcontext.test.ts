import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { chmod, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectJbcontext,
  isJbcontextAvailable,
  isJbcontextConfigured,
  resolveJbcontextBinary,
} from "./jbcontext.ts"

describe("src/utils/jbcontext.ts", () => {
  let tempBaseDir: string

  beforeAll(async () => {
    tempBaseDir = join(
      tmpdir(),
      `swiz-jbcontext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(tempBaseDir, { recursive: true })
  })

  afterAll(async () => {
    try {
      await rm(tempBaseDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  describe("resolveJbcontextBinary", () => {
    it("returns null when an explicit empty binaryPath is passed", async () => {
      const resolved = await resolveJbcontextBinary({ binaryPath: "" })
      expect(resolved).toBeNull()
    })

    it("returns null when an explicit non-existent path is passed", async () => {
      const resolved = await resolveJbcontextBinary({
        binaryPath: "/path/to/definitely_nonexistent_jbcontext_binary_xyz",
      })
      expect(resolved).toBeNull()
    })

    it("resolves an explicit existing binary path", async () => {
      const binDir = join(tempBaseDir, "custom-bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "mock-jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\necho 'jbcontext version 1.0.0'\n")
      await chmod(fakeBin, 0o755)

      const resolved = await resolveJbcontextBinary({ binaryPath: fakeBin })
      expect(resolved).toBe(fakeBin)
    })

    it("resolves binary in custom home directory (.jbcontext/bin/jbcontext)", async () => {
      const mockHome = join(tempBaseDir, "mock-home-1")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\necho 'jbcontext version 0.9.0'\n")
      await chmod(fakeBin, 0o755)

      const resolved = await resolveJbcontextBinary({ homeDir: mockHome })
      expect(resolved).toBe(fakeBin)
    })

    it("returns null when custom home has no jbcontext binary", async () => {
      const emptyHome = join(tempBaseDir, "mock-home-empty")
      await mkdir(emptyHome, { recursive: true })

      const resolved = await resolveJbcontextBinary({ homeDir: emptyHome })
      expect(resolved).toBeNull()
    })
  })

  describe("isJbcontextAvailable", () => {
    it("returns false when binary does not exist", async () => {
      const available = await isJbcontextAvailable({
        binaryPath: "/nonexistent/binary",
      })
      expect(available).toBe(false)
    })

    it("returns true when binary exists and checkVersion succeeds", async () => {
      const mockHome = join(tempBaseDir, "mock-home-avail")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\necho 'jbcontext version 0.9.15 (build 100)'\n")
      await chmod(fakeBin, 0o755)

      const available = await isJbcontextAvailable({
        homeDir: mockHome,
        checkVersion: true,
      })
      expect(available).toBe(true)
    })
  })

  describe("detectJbcontext", () => {
    it("returns available=false and configured=false when binary is missing", async () => {
      const mockHome = join(tempBaseDir, "mock-home-missing")
      await mkdir(mockHome, { recursive: true })

      const result = await detectJbcontext({ homeDir: mockHome })
      expect(result.available).toBe(false)
      expect(result.configured).toBe(false)
      expect(result.binaryPath).toBeNull()
      expect(result.hasConfigFile).toBe(false)
      expect(result.authenticated).toBe(false)
    })

    it("detects configuration with auth pins and agent setups in config.json", async () => {
      const mockHome = join(tempBaseDir, "mock-home-configured")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(
        fakeBin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "jbcontext version 0.9.13 (build 860, commit 123456, channel stable)"
  exit 0
fi
exit 0
`
      )
      await chmod(fakeBin, 0o755)

      const configData = {
        activeVersion: "0.9.13.860",
        jbaAuthPins: ["prod"],
        agentSetups: {
          "CLAUDE:USER": { auto: true, skills: true },
        },
        aiAccessSelections: {
          prod: { type: "license", licenseId: "TEST1234" },
        },
      }
      await Bun.write(
        join(mockHome, ".jbcontext", "config.json"),
        JSON.stringify(configData, null, 2)
      )

      const result = await detectJbcontext({ homeDir: mockHome })
      expect(result.available).toBe(true)
      expect(result.configured).toBe(true)
      expect(result.version).toBe("0.9.13")
      expect(result.hasConfigFile).toBe(true)
      expect(result.authenticated).toBe(true)
      expect(result.activeVersion).toBe("0.9.13.860")
      expect(result.agentSetups).toBeDefined()
      expect(result.agentSetups?.["CLAUDE:USER"]).toBeDefined()
    })

    it("detects authentication via token file when auth pins are absent", async () => {
      const mockHome = join(tempBaseDir, "mock-home-token")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\necho 'jbcontext version 0.9.13'\n")
      await chmod(fakeBin, 0o755)

      // Config without auth pins
      await Bun.write(
        join(mockHome, ".jbcontext", "config.json"),
        JSON.stringify({ activeVersion: "0.9.13" })
      )
      // Token file
      await Bun.write(
        join(mockHome, ".jbcontext", "grazie-token-prod.json"),
        JSON.stringify({ accessToken: "secret-token" })
      )

      const result = await detectJbcontext({ homeDir: mockHome })
      expect(result.available).toBe(true)
      expect(result.hasConfigFile).toBe(true)
      expect(result.authenticated).toBe(true)
      expect(result.configured).toBe(true)
    })

    it("handles malformed config.json gracefully", async () => {
      const mockHome = join(tempBaseDir, "mock-home-corrupt")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\necho 'jbcontext version 0.9.13'\n")
      await chmod(fakeBin, 0o755)

      await Bun.write(join(mockHome, ".jbcontext", "config.json"), "{ broken json ")

      const result = await detectJbcontext({ homeDir: mockHome })
      expect(result.available).toBe(true)
      expect(result.hasConfigFile).toBe(true)
      expect(result.authenticated).toBe(false)
      expect(result.configured).toBe(false)
    })

    it("checks project indexing status via status --json-output", async () => {
      const mockHome = join(tempBaseDir, "mock-home-project")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")

      const mockStatusJson = JSON.stringify({
        type: "status_result",
        repositoryId: "github.com/mherod/test-repo",
        repositoryUrl: "https://github.com/mherod/test-repo.git",
        indices: [
          {
            indexAlias: { name: "test-index" },
            snapshots: [
              { revision: "rev-12345", branches: ["main"], clusters: 10, totalSizeKB: 500 },
            ],
          },
        ],
        message: "Status retrieved successfully",
        storage: "local",
      })

      await Bun.write(
        fakeBin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "jbcontext version 0.9.13"
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '${mockStatusJson}'
  exit 0
fi
exit 0
`
      )
      await chmod(fakeBin, 0o755)

      await Bun.write(
        join(mockHome, ".jbcontext", "config.json"),
        JSON.stringify({ jbaAuthPins: ["prod"] })
      )

      const result = await detectJbcontext({
        homeDir: mockHome,
        projectPath: "/some/test/repo",
      })

      expect(result.available).toBe(true)
      expect(result.configured).toBe(true)
      expect(result.project).toBeDefined()
      expect(result.project?.indexed).toBe(true)
      expect(result.project?.repositoryId).toBe("github.com/mherod/test-repo")
      expect(result.project?.indices.length).toBe(1)
      expect(result.project?.indices[0]?.name).toBe("test-index")
    })

    it("marks project unindexed when status returns no indices", async () => {
      const mockHome = join(tempBaseDir, "mock-home-unindexed")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")

      const mockEmptyStatus = JSON.stringify({
        type: "status_result",
        repositoryId: "some-unindexed-id",
        repositoryUrl: "",
        indices: [],
        message: "No indices found",
      })

      await Bun.write(
        fakeBin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "jbcontext version 0.9.13"
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '${mockEmptyStatus}'
  exit 0
fi
exit 0
`
      )
      await chmod(fakeBin, 0o755)

      await Bun.write(
        join(mockHome, ".jbcontext", "config.json"),
        JSON.stringify({ jbaAuthPins: ["prod"] })
      )

      const result = await detectJbcontext({
        homeDir: mockHome,
        projectPath: "/some/unindexed/path",
        requireProjectIndexed: true,
      })

      expect(result.available).toBe(true)
      expect(result.project?.indexed).toBe(false)
      // Because requireProjectIndexed is true, configured should be false
      expect(result.configured).toBe(false)
    })
  })

  describe("isJbcontextConfigured", () => {
    it("returns false if jbcontext is not available", async () => {
      const configured = await isJbcontextConfigured({
        binaryPath: "/path/to/nonexistent",
      })
      expect(configured).toBe(false)
    })

    it("returns true when global configuration and auth exist", async () => {
      const mockHome = join(tempBaseDir, "mock-home-configured-bool")
      const binDir = join(mockHome, ".jbcontext", "bin")
      await mkdir(binDir, { recursive: true })
      const fakeBin = join(binDir, "jbcontext")
      await Bun.write(fakeBin, "#!/bin/sh\nexit 0\n")
      await chmod(fakeBin, 0o755)

      await Bun.write(
        join(mockHome, ".jbcontext", "config.json"),
        JSON.stringify({ jbaAuthPins: ["prod"] })
      )

      const configured = await isJbcontextConfigured({ homeDir: mockHome })
      expect(configured).toBe(true)
    })
  })

  describe("live environment detection", () => {
    it("detects real system jbcontext if installed or handles absence gracefully", async () => {
      const realAvailable = await isJbcontextAvailable()
      const detection = await detectJbcontext()

      if (realAvailable) {
        expect(detection.available).toBe(true)
        expect(detection.binaryPath).toContain("jbcontext")
        expect(detection.hasConfigFile).toBe(true)
        expect(detection.authenticated).toBe(true)
        expect(detection.configured).toBe(true)
      } else {
        expect(detection.available).toBe(false)
        expect(detection.configured).toBe(false)
      }
    })
  })
})
