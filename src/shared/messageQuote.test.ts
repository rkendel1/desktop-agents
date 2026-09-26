import { describe, expect, it } from 'vitest'
import { formatMessageQuote, modelVisibleText, parseMessageQuote, quotedImageCount } from './messageQuote'

describe('message quotes', () => {
  it('keeps a text quote readable and separate from the reply', () => {
    const text = `${formatMessageQuote('Dobi', 'First line\nSecond line', 0)}My reply`
    expect(text).toBe('> Dobi:\n> First line\n> Second line\n\nMy reply')
    expect(parseMessageQuote(text)).toEqual({
      author: 'Dobi',
      text: 'First line\nSecond line',
      imageCount: 0,
      rest: 'My reply'
    })
    expect(quotedImageCount(text, 0)).toBe(0)
  })

  it('records quoted images on the quote and removes that marker from model text', () => {
    const text = `${formatMessageQuote('Dobi', 'Look', 2)}What is it?`
    expect(parseMessageQuote(text)).toEqual({
      author: 'Dobi',
      text: 'Look',
      imageCount: 2,
      rest: 'What is it?'
    })
    expect(quotedImageCount(text, 2)).toBe(2)
    expect(quotedImageCount(text, 1)).toBe(1)
    expect(modelVisibleText(text)).toBe('> Dobi:\n> Look\n\nWhat is it?')
  })

  it('quotes an image-only message without inventing a filename placeholder', () => {
    const text = formatMessageQuote('Dobi', '', 1)
    expect(parseMessageQuote(text)).toMatchObject({ author: 'Dobi', text: '', imageCount: 1, rest: '' })
    expect(modelVisibleText(text)).not.toContain('douchat-quote-images')
  })
})
