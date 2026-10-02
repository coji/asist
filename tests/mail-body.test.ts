import { describe, expect, it } from 'vitest'
import { bodyPartsOf, htmlEncoding, htmlToPlain } from '../src/main/services/mail-body'

describe('reading a bodyStructure', () => {
  it('separates the text and html body parts from the attachments, and numbers a single part 1', () => {
    const single = bodyPartsOf({ type: 'text/plain', size: 3 })
    expect(single).toEqual({ parts: { textPart: '1', htmlPart: null }, attachments: [] })
    const mixed = bodyPartsOf({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 10 },
            { part: '1.2', type: 'text/html', size: 20 }
          ]
        },
        { part: '2', type: 'application/pdf', size: 500, disposition: 'attachment', dispositionParameters: { filename: '資料.pdf' } },
        { part: '3', type: 'image/png', size: 40, parameters: { name: 'logo.png' }, disposition: 'inline' },
        { part: '4', type: 'text/plain', size: 8, disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' } }
      ]
    })
    expect(mixed.parts).toEqual({ textPart: '1.1', htmlPart: '1.2' })
    expect(mixed.attachments).toEqual([
      { filename: '資料.pdf', contentType: 'application/pdf', size: 500 },
      { filename: 'logo.png', contentType: 'image/png', size: 40 },
      { filename: 'notes.txt', contentType: 'text/plain', size: 8 }
    ])
    expect(bodyPartsOf(undefined)).toEqual({ parts: { textPart: null, htmlPart: null }, attachments: [] })
  })

  it('turns HTML into plain text, dropping link targets, images and styles', () => {
    expect(htmlToPlain('<style>p{}</style><p>こんにちは <a href="https://x.example">サイト</a></p><img src="a.png"><script>x()</script>')).toBe('こんにちは サイト')
  })
})

describe('the encoding of an HTML part', () => {
  const html = (head: string, body = '') => Buffer.from(`<html><head>${head}</head><body>${body}</body></html>`)

  it('reads the meta tags when imapflow could not convert by the MIME charset, as a browser does with a transport label it does not support', () => {
    // Old Outlook writes charset=_iso-2022-jp$ESC in the MIME header, which imapflow passes on unconverted.
    expect(htmlEncoding(html('<meta http-equiv=Content-Type content="text/html; charset=iso-2022-jp">'), '_iso-2022-jp$esc')).toBe('iso-2022-jp')
    expect(htmlEncoding(html('<meta charset="euc-jp">'), 'unknown-8bit')).toBe('euc-jp')
    // imapflow reports utf-8 for a part it converted, which the meta tags no longer describe.
    expect(htmlEncoding(html('<meta charset="shift_jis">'), 'utf-8')).toBe('utf-8')
  })

  it('reads the meta tags of the head as the prescan does, past comments and past the first 1024 bytes, and not a meta of a message quoted in the body', () => {
    expect(htmlEncoding(html('<!-- <meta charset="utf-8"> --><meta charset="shift_jis">'), undefined)).toBe('shift_jis')
    expect(htmlEncoding(html(`<style>${'p { margin: 0 }\n'.repeat(100)}</style><meta charset="euc-jp">`), undefined)).toBe('euc-jp')
    expect(htmlEncoding(html('', '<blockquote><html><head><meta charset="shift_jis"></head></html></blockquote>'), undefined)).toBe('utf-8')
  })
})
