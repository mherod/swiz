/** Check if a binary exists on PATH. Returns its path or null. */
export async function whichExists(binary: string): Promise<string | null> {
  return Bun.which(binary)
}
