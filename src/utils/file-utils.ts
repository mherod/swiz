export async function readLines(path: string, count: number): Promise<string[]> {
  try {
    const file = Bun.file(path)
    const text = await file.text()
    return text.split("\n").slice(0, count)
  } catch {
    return []
  }
}

export async function readFileText(path: string): Promise<string> {
  const f = Bun.file(path)
  return (await f.exists()) ? await f.text() : ""
}

export async function readJsonFile(path: string): Promise<Record<string, any>> {
  const f = Bun.file(path)
  return (await f.exists()) ? await f.json() : {}
}

export async function backup(path: string): Promise<boolean> {
  const file = Bun.file(path)
  if (await file.exists()) {
    await Bun.write(`${path}.bak`, await file.text())
    return true
  }
  return false
}
