export async function readLines(path: string, count: number): Promise<string[]> {
  try {
    const file = Bun.file(path)
    const text = await file.text()
    return text.split("\n").slice(0, count)
  } catch {
    return []
  }
}
