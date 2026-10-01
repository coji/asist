import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './aizuchi-review.css'

/**
 * The review of the aizuchi clips the app ships (/aizuchi in the demo). The demo's development server reads
 * and writes the clips through scripts/aizuchi-clips/review-api.mjs: a verdict goes into the manifest at once,
 * an accepted clip is never rendered again, and a rejected one can be rendered again from here with build.mjs.
 */

type Status = 'unreviewed' | 'accepted' | 'rejected'

interface Candidate {
  file: string
  heard: string
  voicedMs: number
  /** False where the recognizer heard only part of the text, such as "なるほど" for "なるほどなるほど". */
  exact: boolean
}

interface Clip {
  engine: string
  voice: string
  text: string
  file: string
  status: Status
  note: string | null
  candidates: Candidate[]
  /** The candidate the clip is now, or null when it is none of them, as for a clip rendered before candidates were kept. */
  current: number | null
}

interface Render {
  engine: string
  voice: string
  texts: string[]
  done: number
  running: boolean
  exitCode: number | null
}

type Filter = 'open' | Status | 'all'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'open', label: '未確認とだめ' },
  { id: 'unreviewed', label: '未確認' },
  { id: 'rejected', label: 'だめ' },
  { id: 'accepted', label: '合格' },
  { id: 'all', label: 'すべて' }
]

const ENGINE_NAMES: Record<string, string> = { irodori: 'Irodori-TTS', qwen3tts: 'Qwen3-TTS' }
/** The pause between two clips while everything is played, so that one does not run into the next. */
const GAP_MS = 350

const keyOf = (clip: Pick<Clip, 'engine' | 'voice' | 'file'>): string => `${clip.engine}/${clip.voice}/${clip.file}`
const voiceOf = (clip: Pick<Clip, 'engine' | 'voice'>): string => `${clip.engine}/${clip.voice}`
const open = (clip: Clip): boolean => clip.status !== 'accepted'
const matches = (clip: Clip, filter: Filter): boolean =>
  filter === 'all' || (filter === 'open' ? open(clip) : clip.status === filter)

/**
 * The options of a clip: a number is one of the candidates build.mjs kept, and null the clip as it is, offered
 * only when it is none of them.
 */
const optionsOf = (clip: Clip): Array<number | null> => [...(clip.current === null ? [null] : []), ...clip.candidates.map((_, n) => n)]
/** What is chosen until the reviewer picks another: the clip as it is. */
const chosenOf = (chosen: Record<string, number | null>, clip: Clip): number | null => (keyOf(clip) in chosen ? chosen[keyOf(clip)] : clip.current)

function audioUrl(clip: Clip, option: number | null): string {
  if (option === null) return `/__aizuchi/audio/${clip.engine}/${clip.voice}/${clip.file}`
  return `/__aizuchi/audio/${clip.engine}/${clip.voice}/${clip.file.replace(/\.wav$/, '')}/${clip.candidates[option].file}`
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/__aizuchi/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `${response.status}`)
  return data
}

export function AizuchiReview(): React.JSX.Element {
  const [clips, setClips] = useState<Clip[]>([])
  const [renders, setRenders] = useState<Render[]>([])
  const [filter, setFilter] = useState<Filter>('open')
  const [voice, setVoice] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Record<string, number | null>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  /** Clips decided while the page is open stay in the list, folded, whatever the filter, until the filter changes. */
  const [decided, setDecided] = useState<Set<string>>(new Set())
  const [playing, setPlaying] = useState<{ key: string; option: number | null } | null>(null)
  const [playingAll, setPlayingAll] = useState(false)
  const [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement>(new Audio())
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    const data = await call<{ clips: Clip[]; renders: Render[] }>('clips')
    setClips(data.clips)
    setRenders(data.renders)
  }, [])
  useEffect(() => {
    load().catch((caught: unknown) => setError(String(caught)))
  }, [load])
  // While build.mjs renders, the list is read again every few seconds so that new candidates show up.
  const rendering = renders.some((render) => render.running)
  useEffect(() => {
    if (!rendering) return
    const id = window.setInterval(() => { load().catch((caught: unknown) => setError(String(caught))) }, 3000)
    return () => window.clearInterval(id)
  }, [rendering, load])

  const voices = useMemo(() => {
    const byVoice = new Map<string, { engine: string; voice: string; total: number; open: number; rejected: number }>()
    for (const clip of clips) {
      const entry = byVoice.get(voiceOf(clip)) ?? { engine: clip.engine, voice: clip.voice, total: 0, open: 0, rejected: 0 }
      entry.total++
      if (open(clip)) entry.open++
      if (clip.status === 'rejected') entry.rejected++
      byVoice.set(voiceOf(clip), entry)
    }
    return [...byVoice.values()]
  }, [clips])
  const rows = useMemo(
    () => clips.filter((clip) => (voice === null || voiceOf(clip) === voice) && (matches(clip, filter) || decided.has(keyOf(clip)))),
    [clips, voice, filter, decided]
  )
  const accepted = clips.filter((clip) => clip.status === 'accepted').length
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  /** The next row after `key` that still waits for a verdict. */
  const nextOpen = useCallback((key: string | null): Clip | null => {
    const list = rowsRef.current
    const from = key === null ? -1 : list.findIndex((clip) => keyOf(clip) === key)
    return list.slice(from + 1).find((clip) => open(clip) && !decided.has(keyOf(clip))) ?? null
  }, [decided])

  const stop = useCallback((): void => {
    window.clearTimeout(timer.current)
    audio.current.pause()
    setPlaying(null)
    setPlayingAll(false)
  }, [])

  const play = useCallback((clip: Clip, option: number | null, thenAll: boolean): void => {
    window.clearTimeout(timer.current)
    const element = audio.current
    element.src = audioUrl(clip, option)
    // The end of the clip played before can arrive after the source changed; it would end this one early and
    // skip a clip, or stop playing everything at the last one.
    element.onended = () => {
      if (!element.ended || !element.src.endsWith(audioUrl(clip, option))) return
      setPlaying(null)
      if (!thenAll) return
      timer.current = window.setTimeout(() => {
        const next = nextOpen(keyOf(clip))
        if (!next) { setPlayingAll(false); return }
        setFocus(keyOf(next))
        play(next, chosenOf(chosenRef.current, next), true)
      }, GAP_MS)
    }
    setPlaying({ key: keyOf(clip), option })
    void element.play()
    document.getElementById(`clip-${keyOf(clip)}`)?.scrollIntoView({ block: 'nearest' })
  }, [nextOpen])
  const chosenRef = useRef(chosen)
  chosenRef.current = chosen

  const playAll = (from: Clip | null): void => {
    const start = from && open(from) && !decided.has(keyOf(from)) ? from : nextOpen(from ? keyOf(from) : null)
    if (!start) return
    setPlayingAll(true)
    setFocus(keyOf(start))
    play(start, chosenOf(chosen, start), true)
  }

  const decide = (clip: Clip, verdict: 'accept' | 'reject' | 'undo'): void => {
    const key = keyOf(clip)
    const option = chosenOf(chosen, clip)
    const status: Status = verdict === 'accept' ? 'accepted' : verdict === 'reject' ? 'rejected' : 'unreviewed'
    const previous = clips
    setClips((list) => list.map((one) => (keyOf(one) === key ? { ...one, status, note: verdict === 'reject' ? notes[key] || null : null } : one)))
    setDecided((set) => new Set(set).add(key))
    setError('')
    // A verdict moves on at once, and keeps playing everything if that was on; the request goes in the background.
    if (verdict !== 'undo' && focus === key) {
      const next = nextOpen(key)
      if (next) {
        setFocus(keyOf(next))
        if (playingAll) play(next, chosenOf(chosen, next), true)
      } else if (playingAll) stop()
    }
    call('verdict', { engine: clip.engine, voice: clip.voice, file: clip.file, verdict, candidate: verdict === 'accept' ? option : undefined, note: notes[key] })
      .catch((caught: unknown) => {
        setClips(previous)
        setError(`${clip.voice} の「${clip.text}」を保存できませんでした: ${caught instanceof Error ? caught.message : String(caught)}`)
      })
  }

  const renderAgain = (engine: string, name: string): void => {
    call<{ renders: Render[] }>('render', { engine, voice: name })
      .then((data) => setRenders(data.renders))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }

  const focused = rows.find((clip) => keyOf(clip) === focus) ?? null
  const choose = (clip: Clip, option: number | null): void => {
    setChosen((map) => ({ ...map, [keyOf(clip)]: option }))
    setFocus(keyOf(clip))
    play(clip, option, false)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).tagName === 'INPUT') return
      const index = rows.findIndex((clip) => keyOf(clip) === focus)
      const key = event.key.toLowerCase()
      const move = (to: number): void => {
        const target = rows[Math.max(0, Math.min(rows.length - 1, to))]
        if (!target) return
        setFocus(keyOf(target))
        document.getElementById(`clip-${keyOf(target)}`)?.scrollIntoView({ block: 'nearest' })
        if (playingAll) play(target, chosenOf(chosen, target), true)
      }
      const handled = (): void => event.preventDefault()
      if (key === 'j' || key === 'arrowdown') { handled(); move(index + 1) }
      else if (key === 'k' || key === 'arrowup') { handled(); move(index - 1) }
      else if (!focused) return
      else if (key === ' ') { handled(); if (playing) stop(); else play(focused, chosenOf(chosen, focused), false) }
      else if (key === '0' && focused.current === null) { handled(); choose(focused, null) }
      else if (/^[1-5]$/.test(key) && focused.candidates[Number(key) - 1]) { handled(); choose(focused, Number(key) - 1) }
      else if ((key === 'a' || key === 'enter') && !event.repeat) { handled(); if (open(focused)) decide(focused, 'accept') }
      else if (key === 'x' && !event.repeat) { handled(); if (focused.status !== 'rejected') decide(focused, 'reject') }
      else if (key === 'u' && !event.repeat) { handled(); if (focused.status !== 'unreviewed') decide(focused, 'undo') }
      else if (key === 'p') { handled(); if (playingAll) stop(); else playAll(event.shiftKey ? null : focused) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const changeFilter = (next: Filter): void => {
    setFilter(next)
    setDecided(new Set())
  }
  const changeVoice = (next: string | null): void => {
    setVoice(next)
    setDecided(new Set())
  }

  return (
    <div className="azr">
      <aside className="azr-side">
        <a className="azr-home" href="/">← demo</a>
        <h1>相槌の確認</h1>
        <div className="azr-progress" title={`合格 ${accepted} / ${clips.length}`}>
          <div style={{ width: `${clips.length ? (accepted / clips.length) * 100 : 0}%` }} />
        </div>
        <p className="azr-muted">合格 {accepted} / {clips.length}</p>
        <button className={voice === null ? 'on' : ''} onClick={() => changeVoice(null)}>
          すべての声 <span>{clips.filter(open).length}</span>
        </button>
        {Object.keys(ENGINE_NAMES).map((engine) => (
          <section key={engine}>
            <h2>{ENGINE_NAMES[engine]}</h2>
            {voices.filter((entry) => entry.engine === engine).map((entry) => {
              const job = renders.find((one) => one.engine === engine && one.voice === entry.voice)
              return (
                <div key={entry.voice} className="azr-voice">
                  <button className={voice === voiceOf(entry) ? 'on' : ''} onClick={() => changeVoice(voiceOf(entry))}>
                    {entry.voice} <span>{entry.open ? `残り ${entry.open}` : '済み'}</span>
                  </button>
                  {job?.running ? (
                    <p className="azr-muted">作り直し中 {job.done} / {job.texts.length}</p>
                  ) : entry.rejected > 0 ? (
                    <button className="azr-render" onClick={() => renderAgain(engine, entry.voice)}>だめな {entry.rejected} 件を作り直す</button>
                  ) : job && job.exitCode !== 0 ? (
                    <p className="azr-error">作り直しが失敗しました({job.exitCode})</p>
                  ) : null}
                </div>
              )
            })}
          </section>
        ))}
      </aside>
      <main className="azr-main">
        <header>
          <div className="azr-filters" role="group" aria-label="表示する相槌">
            {FILTERS.map((entry) => (
              <button key={entry.id} aria-pressed={filter === entry.id} onClick={() => changeFilter(entry.id)}>{entry.label}</button>
            ))}
          </div>
          <div className="azr-play">
            {playingAll ? (
              <button className="azr-primary" onClick={stop}>止める</button>
            ) : (
              <>
                <button className="azr-primary" onClick={() => playAll(null)}>最初から再生</button>
                <button onClick={() => playAll(focused)} disabled={!focused}>ここから再生</button>
              </>
            )}
          </div>
          <p className="azr-keys">
            <kbd>J</kbd><kbd>K</kbd> 移動 <kbd>Space</kbd> 再生 <kbd>0</kbd>〜<kbd>5</kbd> 候補 <kbd>A</kbd> 合格 <kbd>X</kbd> だめ <kbd>U</kbd> 取り消し <kbd>P</kbd> ここから再生 <kbd>⇧P</kbd> 最初から
          </p>
          {error && <p className="azr-error">{error}</p>}
        </header>
        {rows.map((clip, index) => {
          const key = keyOf(clip)
          const option = chosenOf(chosen, clip)
          const shown = option === null ? null : clip.candidates[option]
          const folded = decided.has(key) && clip.status !== 'unreviewed'
          const firstOfVoice = index === 0 || voiceOf(rows[index - 1]) !== voiceOf(clip)
          return (
            <div key={key}>
              {voice === null && firstOfVoice && <h2 className="azr-group">{ENGINE_NAMES[clip.engine]} {clip.voice}</h2>}
              <div
                id={`clip-${key}`}
                className={`azr-row is-${clip.status}${focus === key ? ' is-focus' : ''}${folded ? ' is-folded' : ''}`}
                onClick={() => setFocus(key)}
              >
                <div className="azr-text">
                  <strong>{clip.text}</strong>
                  {!folded && (
                    <small className={shown && !shown.exact ? 'azr-warn' : 'azr-muted'}>
                      {shown ? `聞き取り: ${shown.heard}${shown.exact ? '' : '(一部だけ一致)'}` : '前の作り方のクリップ(候補なし)'}
                      {clip.note && ` / だめ: ${clip.note}`}
                    </small>
                  )}
                </div>
                {!folded && (
                  <div className="azr-options">
                    {optionsOf(clip).map((value) => {
                      const candidate = value === null ? null : clip.candidates[value]
                      const isPlaying = playing?.key === key && playing.option === value
                      return (
                        <button
                          key={value ?? 'now'}
                          className={`${option === value ? 'is-chosen' : ''}${isPlaying ? ' is-playing' : ''}${candidate && !candidate.exact ? ' is-partial' : ''}`}
                          onClick={(event) => { event.stopPropagation(); choose(clip, value) }}
                          title={candidate ? `聞き取り: ${candidate.heard}` : '今のクリップ'}
                        >
                          {value === null ? '今' : value + 1} ▶{candidate ? ` ${(candidate.voicedMs / 1000).toFixed(2)}` : ''}{value === clip.current && clip.candidates.length > 0 ? ' 今' : ''}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="azr-actions">
                  {clip.status === 'accepted' && <span className="azr-chip is-ok">合格</span>}
                  {clip.status === 'rejected' && <span className="azr-chip is-ng">だめ</span>}
                  {clip.status === 'unreviewed' && <span className="azr-chip">未確認</span>}
                  {open(clip) && !folded && (
                    <>
                      <button className="azr-ok" onClick={(event) => { event.stopPropagation(); setFocus(key); decide(clip, 'accept') }}>合格</button>
                      {clip.status !== 'rejected' && (
                        <>
                          <input
                            placeholder="だめな理由"
                            value={notes[key] ?? ''}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setNotes((map) => ({ ...map, [key]: event.target.value }))}
                            onKeyDown={(event) => { if (event.key === 'Enter') { setFocus(key); decide(clip, 'reject') } }}
                          />
                          <button className="azr-ng" onClick={(event) => { event.stopPropagation(); setFocus(key); decide(clip, 'reject') }}>だめ</button>
                        </>
                      )}
                    </>
                  )}
                  {clip.status !== 'unreviewed' && (
                    <button onClick={(event) => { event.stopPropagation(); decide(clip, 'undo') }}>取り消す</button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && <p className="azr-empty">{clips.length === 0 ? '読み込み中' : '当てはまる相槌はありません'}</p>}
      </main>
    </div>
  )
}
