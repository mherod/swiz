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

function renderMarkdown(src: string): string {
  const lines = src.split("\n")
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(escapeHtml(lines[i]!))
        i++
      }
      i++ // skip closing ```
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
      html.push(`<pre class="md-codeblock"><code${cls}>${codeLines.join("\n")}</code></pre>`)
      continue
    }

    // headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length + 2 // h3-h6 (offset since h1/h2 used by page)
      const capped = Math.min(level, 6)
      html.push(`<h${capped} class="md-heading">${renderInline(headingMatch[2]!)}</h${capped}>`)
      i++
      continue
    }

    // unordered list
    if (/^[-*]\s/.test(line)) {
      html.push('<ul class="md-list">')
      while (i < lines.length && /^[-*]\s/.test(lines[i]!)) {
        html.push(`<li>${renderInline(lines[i]!.replace(/^[-*]\s/, ""))}</li>`)
        i++
      }
      html.push("</ul>")
      continue
    }

    // ordered list
    if (/^\d+\.\s/.test(line)) {
      html.push('<ol class="md-list">')
      while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) {
        html.push(`<li>${renderInline(lines[i]!.replace(/^\d+\.\s/, ""))}</li>`)
        i++
      }
      html.push("</ol>")
      continue
    }

    // blank line
    if (line.trim() === "") {
      i++
      continue
    }

    // paragraph
    html.push(`<p>${renderInline(line)}</p>`)
    i++
  }

  return html.join("\n")
}

export function Markdown({ text }: { text: string }) {
  const html = renderMarkdown(text)
  // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped via escapeHtml before rendering
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
}
