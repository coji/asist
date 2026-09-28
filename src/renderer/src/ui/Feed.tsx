import { memo, useEffect, useRef, useState } from 'react'
import { sendTypedMessage, typedTextFits } from '@/conversation'
import { displayError } from '@/display-error'
import { useT } from '@/i18n'
import { speechPlayer } from '@/voice/SpeechPlayer'
import { useFeedStore, useTurnStore, type FeedLine } from '@/state/stores'

/** The conversation feed in the center, with the partial recognition, the karaoke subtitles and the text input. */

type Karaoke = { turnId: number; text: string; ratio: number } | null

/** Polls the sentence being spoken and how far it has got, every 80 ms while playback runs. */
function useKaraoke(): Karaoke {
  const [karaoke, setKaraoke] = useState<Karaoke>(null)
  useEffect(() => {
    const timer = setInterval(() => {
      const next = speechPlayer.karaoke()
      setKaraoke((prev) => (prev === null && next === null ? prev : next))
    }, 80)
    return () => clearInterval(timer)
  }, [])
  return karaoke
}

/** Applies the karaoke highlight to an assistant line, lighting up the characters that have been spoken. */
function karaokeText(text: string, karaoke: Karaoke): React.ReactNode {
  if (!karaoke) return text
  const idx = text.lastIndexOf(karaoke.text)
  if (idx < 0) return text
  const upto = idx + Math.max(1, Math.ceil(karaoke.text.length * karaoke.ratio))
  return (
    <>
      <span className="opacity-55">{text.slice(0, idx)}</span>
      <span
        className="text-holo-peach"
        style={{ textShadow: '0 0 16px color-mix(in srgb, var(--color-holo-peach) calc(50% * var(--ui-glow-strength)), transparent)' }}
      >
        {text.slice(idx, upto)}
      </span>
      <span className="opacity-75">{text.slice(upto)}</span>
    </>
  )
}

/** How much of an error a system line shows; the toast that came with it shows the whole. */
const ERROR_LINE_MAX = 120

/** The text of a system line, drawn from the dictionary each time so that it follows the language of the interface. */
function SystemLine({ line }: { line: FeedLine }): React.JSX.Element {
  const t = useT()
  const text = line.message
    ? line.message.key === 'conversation.error'
      ? t(line.message.key, { message: displayError(line.message.values.message).slice(0, ERROR_LINE_MAX) })
      : t(line.message.key)
    : line.text
  return (
    <div className="self-center rounded-full border border-holo-line/70 px-3.5 py-1 font-mono text-[9.5px] tracking-[0.14em] text-holo-dim">
      {text}
    </div>
  )
}

const Line = memo(function Line({
  line,
  dim,
  karaoke
}: {
  line: FeedLine
  dim: number
  karaoke: Karaoke
}): React.JSX.Element {
  if (line.role === 'sys') return <SystemLine line={line} />
  const isUser = line.role === 'user'
  return (
    <div
      className="flex max-w-full flex-col items-center gap-1.5 text-center transition-opacity duration-500"
      style={{ opacity: dim }}
    >
      <div className="flex items-center gap-2 font-mono text-[9px] tracking-[0.3em]">
        <b className={isUser ? 'font-medium text-holo-cyan' : 'font-medium text-holo-peach'}>
          {isUser ? '▲ YOU' : '● ASIST'}
        </b>
        {line.chip && <span className="text-holo-mint">{line.chip}</span>}
        {line.streaming && (
          <span className="holo-pulse text-holo-peach" aria-hidden>
            ▮
          </span>
        )}
      </div>
      <p
        className={
          isUser
            ? 'text-xl leading-relaxed font-medium text-(--ui-text)'
            : 'text-base leading-relaxed text-holo-text'
        }
        style={isUser ? undefined : { textShadow: '0 0 22px color-mix(in srgb, var(--color-holo-peach) calc(18% * var(--ui-glow-strength)), transparent)' }}
      >
        {isUser || !karaoke || line.turnId !== karaoke.turnId
          ? line.text
          : karaokeText(line.text, karaoke)}
      </p>
    </div>
  )
})

export function Feed(): React.JSX.Element {
  const t = useT()
  const lines = useFeedStore((s) => s.lines)
  const partial = useTurnStore((s) => s.partial)
  const micState = useTurnStore((s) => s.micState)
  const karaoke = useKaraoke()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  // Text the conversation refuses stays in the box for the user to shorten.
  const send = (): void => {
    if (!typedTextFits(input)) return
    void sendTypedMessage(input)
    setInput('')
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines, partial])

  return (
    <div className="flex min-h-0 w-full max-w-[640px] flex-1 flex-col">
      <div
        ref={scrollRef}
        className="feed flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto px-3 py-5 [scrollbar-width:none]"
      >
        {lines.map((line, i) => {
          const fromEnd = lines.length - 1 - i
          const dim = fromEnd >= 4 ? 0.12 : fromEnd >= 2 ? 0.32 : 1
          return (
            <Line
              key={line.id}
              line={line}
              dim={dim}
              karaoke={line.role === 'ai' && line.turnId === karaoke?.turnId ? karaoke : null}
            />
          )
        })}
        {partial && (
          <div className="flex flex-col items-center gap-1.5 text-center">
            <div className="font-mono text-[9px] tracking-[0.3em] text-holo-cyan/70">
              ▲ YOU <span className="holo-pulse">{t('conversation.recognizing')}</span>
            </div>
            <p className="text-xl leading-relaxed font-medium text-(--ui-text)/60">{partial}</p>
          </div>
        )}
      </div>

      <form
        className="flex gap-2 px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // The Enter that confirms a conversion in the Japanese IME must not send the message.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={micState === 'on' ? t('conversation.inputWhileListening') : t('conversation.input')}
          className="flex-1 rounded-full border border-holo-line bg-(--ui-field) px-4 py-2 text-sm text-holo-text backdrop-blur placeholder:text-holo-dim focus:border-holo-cyan/50 focus:outline-none"
        />
      </form>
    </div>
  )
}
