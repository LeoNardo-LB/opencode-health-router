/**
 * Inline JSONC (JSON with Comments) parser.
 *
 * Replaces jsonc-parser dependency with zero-dependency inline code.
 * Complies with common JSONC spec (jsonc.org draft):
 * - Single-line comments (//) padded with spaces
 * - Block comments (slash-asterisk ... asterisk-slash) padded with spaces
 * - Trailing commas removed
 * - Delegates to JSON.parse
 *
 * Space padding prevents adjacent tokens from merging.
 */
export function parseJSONC(text: string): unknown {
  // Strip BOM (Byte Order Mark) if present
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1)
  }

  let result = ""
  let i = 0
  const len = text.length
  let inString = false
  let stringChar = ""

  while (i < len) {
    const ch = text[i]
    const next = i + 1 < len ? text[i + 1] : ""

    if (inString) {
      result += ch
      if (ch === "\\") {
        // Escape sequence, skip next character
        if (next) {
          result += next
          i += 2
          continue
        }
      } else if (ch === stringChar) {
        inString = false
      }
      i++
      continue
    }

    // Only double quotes start strings in standard JSONC (no single quotes)
    if (ch === '"') {
      inString = true
      stringChar = ch
      result += ch
      i++
      continue
    }

    // Single-line comment: replace with spaces (preserve position)
    if (ch === "/" && next === "/") {
      result += " "
      i += 1  // skip first /
      while (i < len && text[i] !== "\n") {
        result += " "
        i++
      }
      continue
    }

    // Multi-line comment: replace with spaces (preserve position)
    if (ch === "/" && next === "*") {
      result += " "
      i += 1  // skip first /
      while (i < len && !(text[i] === "*" && i + 1 < len && text[i + 1] === "/")) {
        result += text[i] === "\n" ? "\n" : " "
        i++
      }
      // Skip */
      if (i < len) { result += " "; i++ }
      if (i < len) { result += " "; i++ }
      continue
    }

    result += ch
    i++
  }

  // Remove trailing commas before ] or }
  result = result.replace(/,(\s*[\]}])/g, "$1")

  return JSON.parse(result)
}
