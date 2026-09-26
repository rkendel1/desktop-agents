/** Quote image lines are display metadata. The image bytes travel with the message. */
const QUOTE_PATTERN = /^> ([^\r\n]+):\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)\r?\n?/
const IMAGE_MARKER = /^\[\[douchat-quote-images:([1-4])\]\]$/

export interface ParsedMessageQuote {
  author: string
  text: string
  imageCount: number
  rest: string
}

export function formatMessageQuote(author: string, text: string, imageCount: number): string {
  const lines = text ? text.split(/\r?\n/) : []
  if (imageCount > 0) lines.push(`[[douchat-quote-images:${imageCount}]]`)
  if (!lines.length) lines.push('')
  return `> ${author}:\n${lines.map((line) => `> ${line}`).join('\n')}\n\n`
}

export function parseMessageQuote(text: string): ParsedMessageQuote | null {
  const quote = QUOTE_PATTERN.exec(text)
  if (!quote) return null
  const rawLines = quote[2].replace(/\n$/, '').split(/\r?\n/).map((line) => line.replace(/^> ?/, ''))
  const marker = IMAGE_MARKER.exec(rawLines.at(-1)?.trim() ?? '')
  const lines = marker ? rawLines.slice(0, -1) : rawLines
  return {
    author: quote[1],
    text: lines.join('\n').trim(),
    imageCount: marker ? Number(marker[1]) : 0,
    rest: text.slice(quote[0].length)
  }
}

/** How many leading attachments belong to the quote rather than this reply. */
export function quotedImageCount(text: string, available: number): number {
  const count = parseMessageQuote(text)?.imageCount ?? 0
  if (!Number.isInteger(available) || available <= 0) return 0
  return Math.min(count, available)
}

/** Hide the quote-image marker from model prompts while keeping the quoted words. */
export function modelVisibleText(text: string): string {
  return text.replace(/^> \[\[douchat-quote-images:[1-4]\]\]\r?\n/gm, '')
}
