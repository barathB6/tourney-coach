// The coach system prompt already tells the model to write plain text, but this
// strips any stray Markdown so an organizer never sees literal asterisks, hashes,
// or "- " bullets read out in the reply. Safe to run on partial (streaming) text.
export function toPlainText(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim()) // code fences
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')   // **bold** -> bold
    .replace(/^\s*[-*]\s+/gm, '• ')         // "- "/"* " bullets -> •
    .replace(/\*/g, '')                     // any leftover asterisks
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')     // # headings
    .replace(/\n{3,}/g, '\n\n')             // collapse big gaps
    .replace(/\n+(?=• )/g, '\n\n');         // blank line before each bullet so lists read airy, not cramped
}
