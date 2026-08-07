interface WorkerPoolFixtureInput {
  delayMs?: number
  label?: string
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as WorkerPoolFixtureInput
  if (input.delayMs && input.delayMs > 0) {
    await Bun.sleep(input.delayMs)
  }
  process.stdout.write(`${JSON.stringify({ systemMessage: input.label ?? "done" })}\n`)
}

void main()
