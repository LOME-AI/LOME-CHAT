/**
 * A fenced block in an assistant message becomes an openable document — a card
 * that opens in the document panel — only when it declares a language AND
 * carries at least this many lines; below the threshold it stays an inline code
 * block. Mermaid is exempt from the line rule and always becomes a document.
 *
 * Shared, not copied: the web parser decides extraction by this number and the
 * seeded dev fixtures assert they clear it. A second copy would let the two
 * disagree — raising the threshold would silently demote every seeded document
 * while the fixture assertion still passed against the stale value.
 */
export const MIN_LINES_FOR_DOCUMENT = 15;
