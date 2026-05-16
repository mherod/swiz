const REMOTE_BRANCH_RE = /^(?:origin|upstream)\/(.+)$/
const REFS_HEADS_RE = /^refs\/heads\/(.+)$/
const REFS_REMOTES_RE = /^refs\/remotes\/(?:origin|upstream)\/(.+)$/

function hasInvalidRefChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 32 || code === 127) return true
    if ("~^:?*[\\".includes(char)) return true
  }
  return false
}

export function isValidBranchReference(value: string): boolean {
  if (!value) return false
  return !hasInvalidRefShape(value) && !hasInvalidRefChar(value) && hasValidPathParts(value)
}

function hasInvalidRefShape(value: string): boolean {
  return (
    value.startsWith("-") ||
    value === "@" ||
    value.includes("@{") ||
    value.includes("..") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".")
  )
}

function hasValidPathParts(value: string): boolean {
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
}

function stripBoundaryMarkup(value: string): string {
  let stripped = value.trim()
  let previous = ""
  while (stripped !== previous) {
    previous = stripped
    stripped = stripped
      .replace(/^[`'"<]+/, "")
      .replace(/[`'">]+$/, "")
      .trim()
  }
  return stripped
}

function stripRejectedSentencePunctuation(value: string): string {
  return value.replace(/[.]+$/, "")
}

export function normalizeBranchReference(value: string): string | null {
  const direct = stripBoundaryMarkup(value.normalize("NFKC"))
  if (isValidBranchReference(direct)) return direct

  const withoutSentencePunctuation = stripBoundaryMarkup(stripRejectedSentencePunctuation(direct))
  if (isValidBranchReference(withoutSentencePunctuation)) return withoutSentencePunctuation

  return null
}

export function comparableLocalBranchName(value: string): string {
  const refsHeads = REFS_HEADS_RE.exec(value)
  if (refsHeads?.[1]) return refsHeads[1]

  const refsRemote = REFS_REMOTES_RE.exec(value)
  if (refsRemote?.[1]) return refsRemote[1]

  const remote = REMOTE_BRANCH_RE.exec(value)
  if (remote?.[1]) return remote[1]

  return value
}

export function branchReferencesAlign(currentBranch: string, declaredBranch: string): boolean {
  if (currentBranch === declaredBranch) return true
  return currentBranch === comparableLocalBranchName(declaredBranch)
}

export function branchReferenceAliases(value: string): string[] {
  const comparable = comparableLocalBranchName(value)
  return comparable === value ? [value] : [value, comparable]
}
