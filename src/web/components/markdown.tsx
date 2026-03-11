/** Lightweight markdown-to-HTML renderer for assistant transcript messages. */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderInline(text: string): string {
  let out = escapeHtml(text)
  // inline code (must come before bold/italic to avoid conflicts)
  out = out.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
  // bold
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  // italic
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
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

function renderMarkdown(src: string): string {
  const lines = normalizeMarkdownSource(src).split("\n")
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    // fenced code block
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        codeLines.push(escapeHtml(lines[i]!))
        i++
      }
      i++ // skip closing ```
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
      html.push(`<pre class="md-codeblock"><code${cls}>${codeLines.join("\n")}</code></pre>`)
      continue
    }

    // headings
    const headingMatch = line.match(/^\s*(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length + 2 // h3-h6 (offset since h1/h2 used by page)
      const capped = Math.min(level, 6)
      html.push(`<h${capped} class="md-heading">${renderInline(headingMatch[2]!)}</h${capped}>`)
      i++
      continue
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      html.push('<ul class="md-list">')
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        html.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*]\s+/, ""))}</li>`)
        i++
      }
      html.push("</ul>")
      continue
    }

    // ordered list
    if (/^\s*\d+[.]\s+/.test(line)) {
      html.push('<ol class="md-list">')
      while (i < lines.length && /^\s*\d+[.]\s+/.test(lines[i]!)) {
        html.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+[.]\s+/, ""))}</li>`)
        i++
      }
      html.push("</ol>")
      continue
    }

    // blank line
    if (trimmed === "") {
      i++
      continue
    }

    // paragraph (join wrapped lines until next block)
    const paragraphLines: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const next = lines[i]!
      if (
        next.trim() === "" ||
        /^\s*```/.test(next) ||
        /^\s*(#{1,4})\s+/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        /^\s*\d+[.]\s+/.test(next)
      ) {
        break
      }
      paragraphLines.push(next.trim())
      i++
    }
    html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`)
  }

  return html.join("\n")
}

export function Markdown({ text }: { text: string }) {
  const html = renderMarkdown(text)
  // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped via escapeHtml before rendering
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}
