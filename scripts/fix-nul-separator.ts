/**
 * Replace a raw NUL byte accidentally written into a source file with its explicit escape.
 *
 * A stray NUL makes a text file "binary" to git, grep, and every diff tool, which hides the file
 * from review entirely. The separator itself is fine — the codebase already uses \x00 to join
 * composite keys — it just has to be written as an escape rather than an embedded byte.
 *
 * Usage: bun scripts/fix-nul-separator.ts <file>
 */

const path = process.argv[2]
if (!path) {
  console.error("usage: bun scripts/fix-nul-separator.ts <file>")
  process.exit(1)
}

const original = new TextDecoder().decode(await Bun.file(path).bytes())
const NUL = String.fromCharCode(0)
if (!original.includes(NUL)) {
  console.error(`no raw NUL byte in ${path}`)
  process.exit(1)
}

const fixed = original.split(NUL).join("\\x00")
if (fixed.includes(NUL)) {
  console.error("replacement left a NUL behind")
  process.exit(1)
}
await Bun.write(path, fixed)
console.log(`replaced ${original.split(NUL).length - 1} raw NUL byte(s) in ${path}`)
