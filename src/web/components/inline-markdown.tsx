import type { ReactElement } from "react"

/** Renders inline markdown as React elements — no unsafe HTML injection. */

const INLINE_TOKEN_RE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(^| )(#\d+)\b|\*\*(.+?)\*\*|(?<!\*)\*([^*]+)\*(?!\*)/g

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "issue"; num: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }

function matchToTokens(m: RegExpMatchArray): InlineToken[] {
  if (m[1] !== undefined) return [{ kind: "code", text: m[1] }]
  if (m[2] !== undefined) return [{ kind: "link", text: m[2], href: m[3]! }]
  if (m[5] !== undefined) {
    const tokens: InlineToken[] = []
    if (m[4]) tokens.push({ kind: "text", text: m[4] })
    tokens.push({ kind: "issue", num: m[5].slice(1) })
    return tokens
  }
  if (m[6] !== undefined) return [{ kind: "strong", text: m[6] }]
  if (m[7] !== undefined) return [{ kind: "em", text: m[7] }]
  return []
}

function tokenizeInline(src: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let lastIndex = 0
  for (const m of src.matchAll(new RegExp(INLINE_TOKEN_RE.source, INLINE_TOKEN_RE.flags))) {
    const idx = m.index ?? 0
    if (idx > lastIndex) tokens.push({ kind: "text", text: src.slice(lastIndex, idx) })
    tokens.push(...matchToTokens(m))
    lastIndex = idx + m[0].length
  }
  if (lastIndex < src.length) tokens.push({ kind: "text", text: src.slice(lastIndex) })
  return tokens
}

function renderInlineToken(token: InlineToken, i: number) {
  switch (token.kind) {
    case "text":
      return token.text
    case "code":
      return (
        <code key={i} className="md-code">
          {token.text}
        </code>
      )
    case "link":
      return (
        <a key={i} href={token.href} className="md-link" target="_blank" rel="noreferrer">
          {token.text}
        </a>
      )
    case "issue":
      return (
        <a
          key={i}
          href={`https://github.com/mherod/swiz/issues/${token.num}`}
          className="md-link md-issue"
          target="_blank"
          rel="noreferrer"
        >
          #{token.num}
        </a>
      )
    case "strong":
      return <strong key={i}>{token.text}</strong>
    case "em":
      return <em key={i}>{token.text}</em>
  }
}

/** Renders inline markdown (`` `code` ``, links, #issues, **bold**, *italic*) as React elements. */
export function InlineMarkdown({ text }: { text: string }): ReactElement {
  return <>{tokenizeInline(text).map(renderInlineToken)}</>
}
