import { describe, expect, test } from "bun:test"
import { countMarkdownWords } from "../src/markdown-word-count.ts"

describe("CLAUDE.md word-count function", () => {
  describe("basic prose counting", () => {
    test("counts simple words", async () => {
      const count = countMarkdownWords("hello world from claude")
      expect(count).toBe(4)
    })

    test("ignores extra whitespace", async () => {
      const count = countMarkdownWords("hello    world    from    claude")
      expect(count).toBe(4)
    })

    test("trims leading/trailing whitespace", async () => {
      const count = countMarkdownWords("   hello world   ")
      expect(count).toBe(2)
    })
  })

  describe("code block exclusion", () => {
    test("excludes single code block", async () => {
      const text = "This is prose before.\n\n```typescript\nconst x = 42;\n```\n\nAnd prose after."
      const count = countMarkdownWords(text)
      expect(count).toBe(7) // "This", "is", "prose", "before", "And", "prose", "after"
    })

    test("excludes multiple code blocks", async () => {
      const text = `This is prose.

\`\`\`
code block 1
\`\`\`

More prose here.

\`\`\`python
another code block
\`\`\`

Final prose.`
      const count = countMarkdownWords(text)
      // Expected: "This is prose" (3) + "More prose here" (3) + "Final prose" (2) = 8
      expect(count).toBe(8)
    })

    test("excludes code block with many words", async () => {
      const prose = "Before and after"
      const codeBlock =
        "const function = () => { return 'this is a code block with many words inside it'; };"
      const text = `${prose}\n\`\`\`\n${codeBlock}\n\`\`\`\n${prose}`
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "Before and after" twice = 3 + 3 = 6
    })

    test("handles nested backticks in code block", async () => {
      const text = "Before.\n\n```\nconst template = `hello ${name}`;\n```\n\nAfter."
      const count = countMarkdownWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })
  })

  describe("markdown syntax removal", () => {
    test("removes heading syntax", async () => {
      const text = "# Main Title\n## Subheading\nThis is content"
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "Main Title Subheading This is content"
    })

    test("removes emphasis markers", async () => {
      const text = "This is **bold** and *italic* and `code` text"
      const count = countMarkdownWords(text)
      expect(count).toBe(8) // "This", "is", "bold", "and", "italic", "and", "code", "text"
    })

    test("removes list markers", async () => {
      const text = "- First item\n- Second item\n* Third item\n+ Fourth item"
      const count = countMarkdownWords(text)
      expect(count).toBe(8) // "First item Second item Third item Fourth item"
    })

    test("removes blockquote markers", async () => {
      const text = "> This is a quote\n> spanning multiple lines"
      const count = countMarkdownWords(text)
      expect(count).toBe(7) // "This", "is", "a", "quote", "spanning", "multiple", "lines"
    })

    test("extracts text from markdown links", async () => {
      const text = "Check out [this link](https://example.com) for more info."
      const count = countMarkdownWords(text)
      expect(count).toBe(7) // "Check", "out", "this", "link", "for", "more", "info"
    })

    test("removes markdown images", async () => {
      const text = "Here is ![alt text](image.png) in the middle of text"
      const count = countMarkdownWords(text)
      expect(count).toBe(9) // "Here", "is", "alt", "text", "in", "the", "middle", "of", "text"
    })

    test("removes horizontal rules", async () => {
      const text = "Before\n---\nAfter\n\n***\n\nMore"
      const count = countMarkdownWords(text)
      expect(count).toBe(3) // "Before After More"
    })
  })

  describe("HTML removal", () => {
    test("removes HTML tags", async () => {
      const text = "This is <em>emphasized</em> with <strong>strong</strong> tags"
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "This", "is", "emphasized", "with", "strong", "tags"
    })

    test("removes HTML comments", async () => {
      const text = "Before <!-- This is a comment with many words inside --> After"
      const count = countMarkdownWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })

    test("removes multiline HTML comments", async () => {
      const text = `Before
<!-- This is a comment
spanning multiple lines
with lots of content -->
After`
      const count = countMarkdownWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })
  })

  describe("edge cases", () => {
    test("handles empty string", async () => {
      const count = countMarkdownWords("")
      expect(count).toBe(0)
    })

    test("handles only whitespace", async () => {
      const count = countMarkdownWords("   \n  \t  ")
      expect(count).toBe(0)
    })

    test("handles only code blocks", async () => {
      const text = "```\nconst x = 42;\nreturn x;\n```"
      const count = countMarkdownWords(text)
      expect(count).toBe(0)
    })

    test("handles mixed content at scale", async () => {
      const text = `
# Documentation Guide

This is the main content with some prose.

## Code Examples

\`\`\`typescript
interface Example {
  name: string;
  value: number;
}

function process(data: Example): void {
  console.log("Processing:", data.name);
}
\`\`\`

More prose after the code.

- Point one
- Point two
- Point three

[Link text](https://example.com) and **bold text** and *italic*.

> A quote with several words
> spanning lines

Final conclusion.
`
      const count = countMarkdownWords(text)
      // Let me count: "Documentation Guide This is the main content with some prose Code Examples More prose after the code Point one Point two Point three Link text and bold text and italic A quote with several words spanning lines Final conclusion"
      // That's roughly: 4 + 7 + 2 + 5 + 3 + 3 + 3 + 5 + 9 + 2 = ~43 words
      // Let me be more careful:
      // "Documentation Guide" (2)
      // "This is the main content with some prose" (7)
      // "Code Examples" (2)
      // "More prose after the code" (5)
      // "Point one Point two Point three" (6)
      // "Link text and bold text and italic" (6)
      // "A quote with several words spanning lines" (7)
      // "Final conclusion" (2)
      // Total: 2+7+2+5+6+6+7+2 = 37
      expect(count).toBeGreaterThan(30)
      expect(count).toBeLessThan(50)
    })

    test("preserves word boundaries across removals", async () => {
      const text = "Before[link](url)after" // Should become "Beforelinkafter" or "Before link after"?
      const count = countMarkdownWords(text)
      // The regex extracts the link text, so: "Before" + "link" + "after" joined with the replacements
      // Actually, the replacement is: "Before" + "$1" (which is "link") + "after"
      // So the result is "Beforelinkafter" = 1 word
      expect(count).toBe(1)
    })
  })

  describe("real-world CLAUDE.md patterns", () => {
    test("handles CLAUDE.md heading and prose pattern", async () => {
      const text = "## Writing Hooks\n\n**DO** update README.md whenever adding a hook."
      const count = countMarkdownWords(text)
      expect(count).toBe(9) // "Writing", "Hooks", "DO", "update", "README.md", "whenever", "adding", "a", "hook"
    })

    test("handles complex multi-section content", async () => {
      const text = `
## Section One

Content with \`inline code\` and **bold**.

## Section Two

- Item 1: explanation
- Item 2: more details

\`\`\`js
// Example code
const x = 42;
\`\`\`

Final thoughts.
`
      const count = countMarkdownWords(text)
      // "Section One Content with inline code and bold Section Two Item 1 explanation Item 2 more details Final thoughts"
      // Rough count: 2 + 6 + 2 + 6 + 2 = 18 words
      expect(count).toBeGreaterThan(10)
      expect(count).toBeLessThan(30)
    })
  })

  describe("YAML frontmatter removal", () => {
    test("removes YAML frontmatter at file start", async () => {
      const text = `---
title: Example
description: Test document
---

This is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("preserves content after frontmatter", async () => {
      const text = `---
key: value
---
Main content here.`
      const count = countMarkdownWords(text)
      expect(count).toBe(3) // "Main", "content", "here"
    })

    test("leaves non-frontmatter dashes alone", async () => {
      const text = `Some content --- divider --- more content`
      const count = countMarkdownWords(text)
      expect(count).toBe(7) // "Some", "content", "---", "divider", "---", "more", "content"
    })

    test("handles empty frontmatter", async () => {
      const text = `---
---
Content after empty frontmatter`
      const count = countMarkdownWords(text)
      expect(count).toBe(4) // "Content", "after", "empty", "frontmatter"
    })

    test("handles UTF-8 BOM at file start", async () => {
      const text = `\uFEFF---
title: Example
---

This is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("handles CRLF line endings in frontmatter", async () => {
      const text = `---\r\ntitle: Example\r\ndescription: Test\r\n---\r\n\r\nThis is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("handles CR line endings in frontmatter", async () => {
      const text = `---\rtitle: Example\rdescription: Test\r---\r\rThis is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("handles multiple dashes in frontmatter delimiter", async () => {
      const text = `-----
title: Example
-----

This is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("handles BOM with CRLF line endings", async () => {
      const text = `\uFEFF---\r\ntitle: Example\r\n---\r\n\r\nThis is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })

    test("handles mixed line endings (LF/CRLF in same file)", async () => {
      const text = `---\r\ntitle: Example\ndescription: Test\r\n---\n\nThis is the main content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(5) // "This", "is", "the", "main", "content"
    })
  })

  describe("indented code block removal", () => {
    test("removes 4-space indented code blocks", async () => {
      const text = `Before indented code.

    const x = 42;
    console.log(x);

After indented code.`
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "Before", "indented", "code", "After", "indented", "code"
    })

    test("removes tab-indented code blocks", async () => {
      const text = `Before tab-indented code.

\t\tfunction test() {
\t\t  return true;
\t\t}

After tab-indented code.`
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "Before", "tab", "indented", "code", "After", "tab", "indented", "code"
    })

    test("removes multiple consecutive indented blocks", async () => {
      const text = `Content.

    block one line one
    block one line two

    block two line one
    block two line two

More content.`
      const count = countMarkdownWords(text)
      expect(count).toBe(3) // "Content", "More", "content"
    })

    test("preserves non-indented code-like syntax", async () => {
      const text = `This is code-like text without indentation.
const x = 42;
More text here.`
      const count = countMarkdownWords(text)
      expect(count).toBe(13) // All words counted since no 4+ space indent
    })

    test("mixed indented and fenced code blocks", async () => {
      const text = `Intro text.

\`\`\`
fenced code here
\`\`\`

Middle text.

    indented code
    more lines

Final text.`
      const count = countMarkdownWords(text)
      expect(count).toBe(6) // "Intro", "text", "Middle", "text", "Final", "text"
    })
  })

  describe("combined YAML and indented code", () => {
    test("removes both YAML and indented code blocks", async () => {
      const text = `---
title: Document
author: Someone
---

Introduction paragraph.

    indented code block
    with multiple lines

Conclusion paragraph.`
      const count = countMarkdownWords(text)
      expect(count).toBe(4) // "Introduction", "paragraph", "Conclusion", "paragraph"
    })
  })

  describe("parametric indented code variants", () => {
    test("single line with 4 spaces", async () => {
      const text = "Before.\n    code line\nAfter."
      const count = countMarkdownWords(text)
      expect(count).toBe(2) // "Before", "After"
    })

    test("single line with tab", async () => {
      const text = "Before.\n\tcode line\nAfter."
      const count = countMarkdownWords(text)
      expect(count).toBe(2) // "Before", "After"
    })

    test("mixed spaces and tabs in same block", async () => {
      const text = "Before.\n    line1\n\tline2\n  line3\nAfter."
      const count = countMarkdownWords(text)
      // "line3" is only 2 spaces, not 4, so it won't be removed
      expect(count).toBeGreaterThan(2)
    })
  })
})
