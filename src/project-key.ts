export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.\\:]/g, "-")
}
