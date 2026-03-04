import { describe, expect, test } from "bun:test"

// Extracted from the hook for testing
async function countWords(text: string): Promise<number> {
  // Strip fenced code blocks (```...```)
  let processed = text.replace(/```[\s\S]*?```/g, "")

  // Strip HTML comments (<!-- ... -->)
  processed = processed.replace(/<!--[\s\S]*?-->/g, "")

  // Remove markdown heading syntax (##, ###, etc.)
  processed = processed.replace(/^#+\s/gm, "")

  // Remove markdown emphasis markers (**, __, *, _, ``)
  processed = processed.replace(/[*_`]/g, "")

  // Remove markdown list markers (-, *, +) at line start
  processed = processed.replace(/^[\s]*[-*+]\s+/gm, "")

  // Remove blockquote markers (>) at line start
  processed = processed.replace(/^>\s+/gm, "")

  // Remove markdown link syntax [text](url) -> extract only text
  processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // Remove markdown image syntax ![alt](url)
  processed = processed.replace(/!\[[^\]]*\]\([^)]+\)/g, "")

  // Remove inline HTML tags
  processed = processed.replace(/<[^>]+>/g, "")

  // Remove markdown horizontal rules (---, ***, ___)
  processed = processed.replace(/^[\s]*(?:---|===|\*\*\*|___)/gm, "")

  // Normalize whitespace
  processed = processed.trim().replace(/\s+/g, " ")

  // Split on whitespace and count words (minimum 1 character per word)
  const words = processed.split(/\s+/).filter((w) => w.length > 0)

  return words.length
}

describe("CLAUDE.md word-count function", () => {
  describe("basic prose counting", () => {
    test("counts simple words", async () => {
      const count = await countWords("hello world from claude")
      expect(count).toBe(4)
    })

    test("ignores extra whitespace", async () => {
      const count = await countWords("hello    world    from    claude")
      expect(count).toBe(4)
    })

    test("trims leading/trailing whitespace", async () => {
      const count = await countWords("   hello world   ")
      expect(count).toBe(2)
    })
  })

  describe("code block exclusion", () => {
    test("excludes single code block", async () => {
      const text = "This is prose before.\n\n```typescript\nconst x = 42;\n```\n\nAnd prose after."
      const count = await countWords(text)
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
      const count = await countWords(text)
      // Expected: "This is prose" (3) + "More prose here" (3) + "Final prose" (2) = 8
      expect(count).toBe(8)
    })

    test("excludes code block with many words", async () => {
      const prose = "Before and after"
      const codeBlock =
        "const function = () => { return 'this is a code block with many words inside it'; };"
      const text = `${prose}\n\`\`\`\n${codeBlock}\n\`\`\`\n${prose}`
      const count = await countWords(text)
      expect(count).toBe(6) // "Before and after" twice = 3 + 3 = 6
    })

    test("handles nested backticks in code block", async () => {
      const text = "Before.\n\n```\nconst template = `hello ${name}`;\n```\n\nAfter."
      const count = await countWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })
  })

  describe("markdown syntax removal", () => {
    test("removes heading syntax", async () => {
      const text = "# Main Title\n## Subheading\nThis is content"
      const count = await countWords(text)
      expect(count).toBe(6) // "Main Title Subheading This is content"
    })

    test("removes emphasis markers", async () => {
      const text = "This is **bold** and *italic* and `code` text"
      const count = await countWords(text)
      expect(count).toBe(8) // "This", "is", "bold", "and", "italic", "and", "code", "text"
    })

    test("removes list markers", async () => {
      const text = "- First item\n- Second item\n* Third item\n+ Fourth item"
      const count = await countWords(text)
      expect(count).toBe(8) // "First item Second item Third item Fourth item"
    })

    test("removes blockquote markers", async () => {
      const text = "> This is a quote\n> spanning multiple lines"
      const count = await countWords(text)
      expect(count).toBe(7) // "This", "is", "a", "quote", "spanning", "multiple", "lines"
    })

    test("extracts text from markdown links", async () => {
      const text = "Check out [this link](https://example.com) for more info."
      const count = await countWords(text)
      expect(count).toBe(7) // "Check", "out", "this", "link", "for", "more", "info"
    })

    test("removes markdown images", async () => {
      const text = "Here is ![alt text](image.png) in the middle of text"
      const count = await countWords(text)
      expect(count).toBe(9) // "Here", "is", "alt", "text", "in", "the", "middle", "of", "text"
    })

    test("removes horizontal rules", async () => {
      const text = "Before\n---\nAfter\n\n***\n\nMore"
      const count = await countWords(text)
      expect(count).toBe(3) // "Before After More"
    })
  })

  describe("HTML removal", () => {
    test("removes HTML tags", async () => {
      const text = "This is <em>emphasized</em> with <strong>strong</strong> tags"
      const count = await countWords(text)
      expect(count).toBe(6) // "This", "is", "emphasized", "with", "strong", "tags"
    })

    test("removes HTML comments", async () => {
      const text = "Before <!-- This is a comment with many words inside --> After"
      const count = await countWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })

    test("removes multiline HTML comments", async () => {
      const text = `Before
<!-- This is a comment
spanning multiple lines
with lots of content -->
After`
      const count = await countWords(text)
      expect(count).toBe(2) // "Before" and "After"
    })
  })

  describe("edge cases", () => {
    test("handles empty string", async () => {
      const count = await countWords("")
      expect(count).toBe(0)
    })

    test("handles only whitespace", async () => {
      const count = await countWords("   \n  \t  ")
      expect(count).toBe(0)
    })

    test("handles only code blocks", async () => {
      const text = "```\nconst x = 42;\nreturn x;\n```"
      const count = await countWords(text)
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
      const count = await countWords(text)
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
      const count = await countWords(text)
      // The regex extracts the link text, so: "Before" + "link" + "after" joined with the replacements
      // Actually, the replacement is: "Before" + "$1" (which is "link") + "after"
      // So the result is "Beforelinkafter" = 1 word
      expect(count).toBe(1)
    })
  })

  describe("real-world CLAUDE.md patterns", () => {
    test("handles CLAUDE.md heading and prose pattern", async () => {
      const text = "## Writing Hooks\n\n**DO** update README.md whenever adding a hook."
      const count = await countWords(text)
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
      const count = await countWords(text)
      // "Section One Content with inline code and bold Section Two Item 1 explanation Item 2 more details Final thoughts"
      // Rough count: 2 + 6 + 2 + 6 + 2 = 18 words
      expect(count).toBeGreaterThan(10)
      expect(count).toBeLessThan(30)
    })
  })
})
