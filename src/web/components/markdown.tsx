/** Lightweight markdown-to-HTML renderer for assistant transcript messages. */

import type { ReactElement } from "react"

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderInline(text: string): string {
  let out = escapeHtml(text)
  const placeholders: string[] = []

  // 1. Code blocks
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    placeholders.push(`<code class="md-code">${code}</code>`)
    return `__PLACEHOLDER_${placeholders.length - 1}__`
  })

  // 2. Markdown links (process inner text for bold/italic, but NO issues)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    let inner = linkText
    inner = inner.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    inner = inner.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    placeholders.push(
      `<a href="${url}" class="md-link" target="_blank" rel="noreferrer">${inner}</a>`
    )
    return `__PLACEHOLDER_${placeholders.length - 1}__`
  })

  // 3. Issues
  out = out.replace(
    /(^|\s)#(\d+)\b/g,
    '$1<a href="https://github.com/mherod/swiz/issues/$2" class="md-link md-issue" target="_blank" rel="noreferrer">#$2</a>'
  )

  // 4. Bold / Italic
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")

  // 5. Restore placeholders
  while (/__PLACEHOLDER_/.test(out)) {
    out = out.replace(/__PLACEHOLDER_(\d+)__/g, (_, i) => placeholders[Number(i)]!)
  }

  return out
}

function normalizeMarkdownSource(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const normalizedLine = line
        // Common bullet variants emitted by models.
        .replace(/^(\s*)[•●▪◦‣]\s+/, "$1- ")
        .replace(/^(\s*)[–—−]\s+/, "$1- ")
        // Ordered lists often use ")" in assistant output.
        .replace(/^(\s*)(\d+)\)\s+/, "$1$2. ")
      const inlineBulletParts = normalizedLine.split(/\s-\s+/)
      const looksLikeInlineList =
        inlineBulletParts.length >= 3 &&
        /(\*\*|`)/.test(normalizedLine) &&
        !/^\s*[-*]\s+/.test(normalizedLine)
      if (!looksLikeInlineList) return [normalizedLine]

      const [head, ...tail] = inlineBulletParts
      const expanded = [head?.trimEnd() ?? "", ...tail.map((part) => `- ${part.trim()}`)].filter(
        Boolean
      )
      return expanded
    })
    .join("\n")
}

interface BlockResult {
  html: string[]
  consumed: number
}

function parseFencedCodeBlock(lines: string[], i: number): BlockResult | null {
  if (!/^\s*```/.test(lines[i]!)) return null
  const lang = lines[i]!.replace(/^\s*```/, "").trim()
  const codeLines: string[] = []
  let j = i + 1
  while (j < lines.length && !/^\s*```/.test(lines[j]!)) {
    codeLines.push(escapeHtml(lines[j]!))
    j++
  }
  j++ // skip closing ```
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
  return {
    html: [`<pre class="md-codeblock"><code${cls}>${codeLines.join("\n")}</code></pre>`],
    consumed: j - i,
  }
}

function parseHeading(line: string): BlockResult | null {
  const m = line.match(/^\s*(#{1,4})\s+(.+)$/)
  if (!m) return null
  const level = Math.min(m[1]!.length + 2, 6)
  return { html: [`<h${level} class="md-heading">${renderInline(m[2]!)}</h${level}>`], consumed: 1 }
}

function parseList(lines: string[], i: number, pattern: RegExp, tag: string): BlockResult | null {
  if (!pattern.test(lines[i]!)) return null
  const html = [`<${tag} class="md-list">`]
  let j = i
  while (j < lines.length && pattern.test(lines[j]!)) {
    html.push(`<li>${renderInline(lines[j]!.replace(pattern, ""))}</li>`)
    j++
  }
  html.push(`</${tag}>`)
  return { html, consumed: j - i }
}

const BLOCK_START_RE = /^\s*```|^\s*#{1,4}\s+|^\s*[-*]\s+|^\s*\d+[.]\s+/

function parseParagraph(lines: string[], i: number): BlockResult {
  const paragraphLines: string[] = [lines[i]!.trim()]
  let j = i + 1
  while (j < lines.length && lines[j]!.trim() !== "" && !BLOCK_START_RE.test(lines[j]!)) {
    paragraphLines.push(lines[j]!.trim())
    j++
  }
  return { html: [`<p>${renderInline(paragraphLines.join(" "))}</p>`], consumed: j - i }
}

function renderMarkdown(src: string): string {
  const lines = normalizeMarkdownSource(src).split("\n")
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      i++
      continue
    }

    const result =
      parseFencedCodeBlock(lines, i) ??
      parseHeading(lines[i]!) ??
      parseList(lines, i, /^\s*[-*]\s+/, "ul") ??
      parseList(lines, i, /^\s*\d+[.]\s+/, "ol") ??
      parseParagraph(lines, i)

    html.push(...result.html)
    i += result.consumed
  }

  return html.join("\n")
}

export function Markdown({ text }: { text: string }): ReactElement {
  const html = renderMarkdown(text)
  // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped via escapeHtml before rendering
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}
