import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { NEWS_TOP_TOPIC } from '@shared/panel-catalog'
import { REGIONS, regionCurrency } from '@shared/conversation-locale'
import { readErrorText } from '@shared/i18n/error-text'

const mocks = vi.hoisted(() => ({
  conversationLocale: 'ja-JP',
  region: 'JP',
  roots: [] as string[],
  searchCalendar: vi.fn(async (_query: { start: string; end: string }) => ({ events: [] }))
}))
vi.mock('../src/main/services/settings', () => ({
  getSettings: () => ({ uiLocale: 'ja-JP', conversationLocale: mocks.conversationLocale, region: mocks.region })
}))
vi.mock('../src/main/services/calendar', () => ({ searchCalendar: mocks.searchCalendar }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
vi.mock('../src/main/services/agent', () => ({ allowedFileRoots: () => mocks.roots }))

type Fetch = ReturnType<typeof vi.fn>

function respond(body: unknown, urls: string[]): Fetch {
  const fetch = vi.fn(async (url: string) => {
    urls.push(String(url))
    return typeof body === 'string' ? new Response(body) : Response.json(body)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function fetchPanel(type: string, props: Record<string, unknown>) {
  const { fetchPanel: run } = await import('../src/main/services/panel-fetchers')
  return run(type, props)
}

beforeEach(() => {
  vi.resetModules()
  mocks.conversationLocale = 'ja-JP'
  mocks.region = 'JP'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the requests a card makes for the conversation language and the region', () => {
  it('asks Open-Meteo for place names in the conversation language', async () => {
    const urls: string[] = []
    respond({ results: [{ name: 'Berlin', latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin', country: 'Deutschland' }] }, urls)
    mocks.conversationLocale = 'de-DE'
    await fetchPanel('clock', { city: 'Berlin' })
    expect(urls[0]).toContain('language=de')
  })

  it('looks a Japanese city up under its English name, with or without the suffix of a prefecture or a city', async () => {
    const kyoto = { name: '京都市', latitude: 35, longitude: 135.7, timezone: 'Asia/Tokyo', country: '日本' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(new URL(url).searchParams.get('name') === 'Kyoto' ? { results: [kyoto] } : {})))
    for (const city of ['京都', '京都府', '京都市']) {
      const { props } = await fetchPanel('clock', { city })
      expect(props, city).toMatchObject({ city: '京都市', timezone: 'Asia/Tokyo' })
    }
  })

  it('takes a suffixed name the geocoding knows for that place, before the table gives the name without the suffix another city', async () => {
    // "沖縄市" is a city of its own, while the table reads "沖縄" as Naha.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json({
          results: [
            new URL(url).searchParams.get('name') === '沖縄市'
              ? { name: '沖縄市', latitude: 26.33, longitude: 127.8, timezone: 'Asia/Tokyo', country: '日本' }
              : { name: '那覇市', latitude: 26.21, longitude: 127.68, timezone: 'Asia/Tokyo', country: '日本' }
          ]
        })
      )
    )
    const { props } = await fetchPanel('clock', { city: '沖縄市' })
    expect(props.city).toBe('沖縄市')
  })

  it('looks a city the table lacks up under its whole name first, since its last character may belong to the name', async () => {
    const urls: string[] = []
    respond({ results: [{ name: '成都市', latitude: 30.66, longitude: 104.06, timezone: 'Asia/Shanghai', country: '中国' }] }, urls)
    const { props } = await fetchPanel('clock', { city: '成都' })
    expect(urls.map((url) => new URL(url).searchParams.get('name'))).toEqual(['成都'])
    expect(props.timezone).toBe('Asia/Shanghai')
  })

  it('still finds a city the table lacks whose name the geocoding knows only without its suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          new URL(url).searchParams.get('name') === '横須賀'
            ? { results: [{ name: '横須賀市', latitude: 35.28, longitude: 139.67, timezone: 'Asia/Tokyo', country: '日本' }] }
            : {}
        )
      )
    )
    const { props } = await fetchPanel('clock', { city: '横須賀市' })
    expect(props).toMatchObject({ city: '横須賀市', timezone: 'Asia/Tokyo' })
  })

  it('looks up a city whose name is also a member of every object under that name', async () => {
    const urls: string[] = []
    respond({ results: [{ name: 'X', latitude: 0, longitude: 0, timezone: 'UTC' }] }, urls)
    for (const city of ['constructor', 'toString']) await fetchPanel('clock', { city })
    expect(urls.map((url) => new URL(url).searchParams.get('name'))).toEqual(['constructor', 'toString'])
  })

  it('keeps the Japanese request of the clock card unchanged', async () => {
    const urls: string[] = []
    respond({ results: [{ name: '大阪市', latitude: 34.69, longitude: 135.5, timezone: 'Asia/Tokyo', country: '日本' }] }, urls)
    await fetchPanel('clock', { city: '大阪' })
    expect(urls).toEqual(['https://geocoding-api.open-meteo.com/v1/search?name=Osaka&count=1&language=ja'])
  })

  it('takes the Google News edition from the language and the region', async () => {
    const urls: string[] = []
    const item = '<item><title>Titel</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, urls)
    mocks.conversationLocale = 'de-DE'
    mocks.region = 'AT'
    await fetchPanel('news', { topic: 'KI' })
    expect(urls[0]).toBe('https://news.google.com/rss/search?q=KI&hl=de&gl=AT&ceid=AT:de')
  })

  it('keeps the Japanese news request unchanged, including the one for the top stories', async () => {
    const urls: string[] = []
    const item = '<item><title>見出し</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, urls)
    await fetchPanel('news', { topic: NEWS_TOP_TOPIC })
    await fetchPanel('news', { topic: 'AI' })
    expect(urls).toEqual([
      'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja',
      'https://news.google.com/rss/search?q=AI&hl=ja&gl=JP&ceid=JP:ja'
    ])
  })

  it('quotes an exchange rate against the currency of the region', async () => {
    const urls: string[] = []
    respond({ result: 'success', rates: { JPY: 150, BRL: 5.2 }, time_last_update_utc: 'now' }, urls)
    expect((await fetchPanel('fx', { base: 'USD' })).props).toMatchObject({ quote: 'JPY', rate: 150 })
    mocks.region = 'BR'
    expect((await fetchPanel('fx', { base: 'USD' })).props).toMatchObject({ quote: 'BRL', rate: 5.2 })
  })

  it('quotes a rate asked for without its quote in every region the settings offer, never against the base itself', async () => {
    const currencies = [...new Set(REGIONS.map((code) => regionCurrency(code)!)), 'USD', 'EUR']
    respond({ result: 'success', rates: Object.fromEntries(currencies.map((code) => [code, 1.5])), time_last_update_utc: 'now' }, [])
    const unquoted: string[] = []
    for (const code of REGIONS) {
      mocks.region = code
      for (const base of ['USD', regionCurrency(code)]) {
        const { props } = await fetchPanel('fx', { base })
        if (typeof props.quote !== 'string' || props.quote === base) unquoted.push(`${code} ${base}/${String(props.quote)}`)
      }
    }
    expect(unquoted).toEqual([])
  })

  it('says it does not know the currency of a region outside the list rather than quoting the rate against the yen', async () => {
    const urls: string[] = []
    respond({ result: 'success', rates: { JPY: 150 }, time_last_update_utc: 'now' }, urls)
    mocks.region = 'XK'
    await expect(fetchPanel('fx', { base: 'USD' })).rejects.toThrow('[asist:panels.errors.currencyUnknown {"region":"XK"}]')
    // A currency the user named is still quoted, whatever the region is.
    expect((await fetchPanel('fx', { base: 'USD', quote: 'JPY' })).props).toMatchObject({ quote: 'JPY' })
  })
})

describe('a card that cannot be filled', () => {
  it('names the service and the status of a failed request in a message the screen words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['clock', { city: 'Berlin' }, 'geocoding-api.open-meteo.com'],
      ['fx', { base: 'USD', quote: 'EUR' }, 'open.er-api.com'],
      ['news', { topic: 'AI' }, 'news.google.com']
    ]
    for (const [type, props, host] of cases) {
      const error = (await fetchPanel(type, props).catch((err: unknown) => err)) as Error
      const text = readErrorText(error.message, 'en-US')
      expect(text, type).not.toBeNull()
      expect(text).toContain(host)
      expect(text).toContain('503')
    }
  })

  it('words a request that got no answer for the screen, and keeps what fetch said in the log', async () => {
    const en = createTranslator('en-US')
    const failed = (code: string, message: string): TypeError =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(failed('ENOTFOUND', 'getaddrinfo ENOTFOUND open.er-api.com'))))
    const offline = (await fetchPanel('fx', { base: 'USD', quote: 'EUR' }).catch((err: unknown) => err)) as Error
    expect(readErrorText(offline.message, 'en-US')).toBe(en('panels.errors.unreachable', { host: 'open.er-api.com' }))
    expect(warn.mock.calls.flat().map(String).join(' ')).toContain('fetch failed')
    expect(((offline.cause as Error).cause as Error).message).toBe('getaddrinfo ENOTFOUND open.er-api.com')

    // The network settings do not fix a certificate, so the card does not say to check them.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(failed('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'))))
    const untrusted = (await fetchPanel('news', { topic: 'AI' }).catch((err: unknown) => err)) as Error
    expect(readErrorText(untrusted.message, 'en-US')).toBe(en('panels.errors.connectFailed', { host: 'news.google.com' }))

    // A time limit reaches the card as it is, which words it itself.
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(timeout)))
    await expect(fetchPanel('fx', { base: 'USD', quote: 'EUR' })).rejects.toBe(timeout)
  })

  it('refuses a clock without a city in a message the screen words', async () => {
    respond({ results: [] }, [])
    await expect(fetchPanel('clock', { city: ' ' })).rejects.toSatisfy((err: Error) => readErrorText(err.message, 'en-US') !== null)
  })

  it('names the files it could not show in a message the screen words', async () => {
    const error = (await fetchPanel('files', { paths: ['/elsewhere/report.pdf'] }).catch((err: unknown) => err)) as Error
    expect(readErrorText(error.message, 'en-US')).toContain('report.pdf')
  })

  it('words a place the table of Japan does not resolve for the weather card, naming the place', async () => {
    for (const location of ['東京タワー', '府中市']) {
      const error = (await fetchPanel('weather', { location }).catch((err: unknown) => err)) as Error
      expect(readErrorText(error.message, 'en-US'), location).toContain(location)
    }
  })
})

describe('the files card (show_files)', () => {
  it('refuses a path whose .. climbs out of a symbolic link, and reads the path it checked', async () => {
    // Windows removes "link/.." from a path as text before it looks at the disk, so no .. climbs out of a link there.
    const climbsOut = process.platform !== 'win32'
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-show-files-')))
    const root = path.join(base, 'root')
    mkdirSync(path.join(base, 'outside', 'sub'), { recursive: true })
    mkdirSync(path.join(root, 'docs'), { recursive: true })
    writeFileSync(path.join(base, 'outside', 'secret.txt'), 'outside')
    writeFileSync(path.join(root, 'secret.txt'), 'inside')
    symlinkSync(path.join(base, 'outside', 'sub'), path.join(root, 'link'))
    mocks.roots = [root]
    const { props } = await fetchPanel('files', { paths: [`${root}/link/../secret.txt`, `${root}/docs/../secret.txt`] })
    const items = props.items as Array<{ path: string; text?: string; error?: string }>
    if (climbsOut) {
      expect(items[0]).toMatchObject({ error: createTranslator('ja-JP')('files.errors.outsideRoots') })
      expect(items[0].text).toBeUndefined()
    } else {
      expect(items[0]).toMatchObject({ path: path.join(root, 'secret.txt'), text: 'inside' })
    }
    expect(items[1]).toMatchObject({ path: path.join(root, 'secret.txt'), text: 'inside' })
  })

  // A folder the process may not search answers realpath with EACCES, as macOS answers with EPERM for a folder
  // its privacy settings keep from the app. Root and Windows search any folder.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'shows the readable file beside a path the OS refuses to resolve, and gives that path alone a reason the screen words',
    async () => {
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'asist-show-files-')))
      const locked = path.join(root, 'locked')
      mkdirSync(locked)
      writeFileSync(path.join(root, 'report.md'), '# report')
      writeFileSync(path.join(locked, 'secret.md'), 'secret')
      chmodSync(locked, 0o000)
      mocks.roots = [root]
      try {
        const { props } = await fetchPanel('files', { paths: [path.join(root, 'report.md'), path.join(locked, 'secret.md')] })
        const items = props.items as Array<{ name: string; text?: string; error?: string }>
        expect(items[0]).toMatchObject({ name: 'report.md', text: '# report' })
        expect(items[1]).toMatchObject({ name: 'secret.md', error: createTranslator('ja-JP')('files.errors.denied') })
      } finally {
        chmodSync(locked, 0o755)
      }
    }
  )
})

describe('the news card', () => {
  it('reads an escaped ampersand in a news title as the text the feed wrote, not as a second escape', async () => {
    const item = '<item><title>5 &amp;lt; 6 &amp;amp; Q&amp;A</title><link>https://example.test</link><pubDate>x</pubDate><source>y</source></item>'
    respond(`<rss>${item}</rss>`, [])
    const { props } = await fetchPanel('news', { topic: 'AI' })
    expect((props.items as { title: string }[])[0].title).toBe('5 &lt; 6 &amp; Q&A')
  })

  it('reads the publisher of an item from a source element that carries its url', async () => {
    const item =
      '<item><title>見出し - NHK</title><link>https://news.google.com/rss/articles/x</link>' +
      '<pubDate>Fri, 25 Sep 2026 01:00:00 GMT</pubDate><source url="https://www3.nhk.or.jp">NHK</source></item>'
    respond(`<rss><channel>${item}</channel></rss>`, [])
    const { props } = await fetchPanel('news', { topic: 'AI' })
    expect((props.items as { source: string }[])[0].source).toBe('NHK')
  })
})

describe('the calendar card', () => {
  // In New York, 2026-11-01 has 25 hours, so the week after 2026-10-26 lasts 7 days and one hour.
  let zone: string | undefined
  beforeEach(() => {
    zone = process.env.TZ
    process.env.TZ = 'America/New_York'
  })
  afterEach(() => {
    vi.useRealTimers()
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('searches next week up to its last midnight when this week is asked for at the weekend, across a change of the clocks', async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 24, 12), toFake: ['Date'] })
    await fetchPanel('calendar', { range: 'week' })
    expect(mocks.searchCalendar).toHaveBeenLastCalledWith(
      { start: new Date(2026, 9, 19).toISOString(), end: new Date(2026, 10, 2).toISOString() },
      expect.any(AbortSignal)
    )
  })
})
