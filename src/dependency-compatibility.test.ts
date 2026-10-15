import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatch, createPatch } from "diff"
import { simpleGit } from "simple-git"
import { v4, validate } from "uuid"

test("patched Git and diff dependencies preserve repository and patch operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "swiz-git-compat-"))
  try {
    const git = simpleGit(root)
    await git.init()
    await Bun.write(join(root, "example.txt"), "before\n")
    await git.add("example.txt")
    expect((await git.status()).staged).toContain("example.txt")
    expect(applyPatch("before\n", createPatch("example.txt", "before\n", "after\n"))).toBe(
      "after\n"
    )
    expect(validate(v4())).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Gemini telemetry exports with the patched OpenTelemetry family", async () => {
  const root = await mkdtemp(join(tmpdir(), "swiz-telemetry-compat-"))
  const output = join(root, "telemetry.jsonl")
  const sdk = Bun.resolveSync("@google/gemini-cli-core", import.meta.dir)
  const telemetry = new URL("./src/telemetry/sdk.js", `file://${sdk}`).href
  const logs = Bun.resolveSync("@opentelemetry/api-logs", import.meta.dir)
  const script = `
    const telemetry = await import(${JSON.stringify(telemetry)});
    const { logs } = await import(${JSON.stringify(logs)});
    const config = {
      getTelemetryEnabled: () => true,
      getTelemetryUseCollector: () => false,
      getTelemetryUseCliAuth: () => false,
      getSessionId: () => "dependency-test",
      isInteractive: () => false,
      getTelemetryOtlpEndpoint: () => undefined,
      getTelemetryOtlpProtocol: () => "http",
      getTelemetryTarget: () => "local",
      getTelemetryOutfile: () => ${JSON.stringify(output)},
      getDebugMode: () => false,
    };
    await telemetry.initializeTelemetry(config);
    if (!telemetry.isTelemetrySdkInitialized()) throw new Error("telemetry did not initialize");
    logs.getLogger("dependency-test").emit({ body: "compatibility-marker" });
    await telemetry.flushTelemetry(config);
    await telemetry.shutdownTelemetry(config, false);
  `
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: root,
      env: { ...process.env, HOME: root, AI_TEST_NO_BACKEND: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect({ exitCode: proc.exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })
    expect(await Bun.file(output).text()).toContain("compatibility-marker")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
