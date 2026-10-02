import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { keyForApp } from '@/ui/key-for-app'

interface FieldDraftOptions<T> {
  format: (value: T) => string
  /** The value of the text, or null for a text that is not one, which is dropped when the user leaves the field. */
  parse: (text: string) => T | null
  /** Saves the value and reports a failure itself. It resolves to whether the value was saved. */
  save: (value: T) => Promise<boolean>
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement

interface FieldDraft<T> {
  /** The props of the input or textarea. */
  props: {
    value: string
    onChange: (event: ChangeEvent<FieldElement>) => void
    onBlur: () => void
    onKeyDown: (event: KeyboardEvent<FieldElement>) => void
    'aria-invalid': boolean
  }
  /**
   * What the field holds: the typed value when it is one, or else the saved value. A button beside the field
   * builds on this, because pressing it leaves the field and main may not have answered that save yet.
   */
  value: T
  /** Whether the text in the field is one whose save failed. It stays in the field, and leaving the field saves it again. */
  failed: boolean
  /** Throws away the text in the field, so that it shows the saved value again. */
  discard: () => void
}

/**
 * The text a field shows in place of the saved value.
 *
 * - `typing`: text the user is typing, with the saved text when the typing began. It stays whatever happens
 *   to the saved value, until the field is left.
 * - `saving`: text the field was left with, while its save is under way. A change of the saved value then
 *   cannot be told from that save arriving, so the text stays; `over` follows the saved text, and `seen`
 *   records that the saved text has been what this save sent.
 * - `left`: text whose save failed, or whose save main answered before the change arrived. It gives way once
 *   the saved text moves from `over`, by that change or from anywhere else, such as a button beside the field
 *   or the model, so a failed text, which leaving the field saves again, never writes over a value saved
 *   after it.
 */
type Draft =
  | { kind: 'typing'; text: string; from: string }
  | { kind: 'saving'; text: string; id: number; sent: string; over: string; seen: boolean }
  | { kind: 'left'; text: string; over: string; failed: boolean }

/**
 * A field for a value main keeps, which saves what was typed once the user leaves it, or presses Enter in a
 * single-line field, and otherwise shows the saved value, so that a change made elsewhere appears in it.
 * Saving on every keystroke would store the values on the way to the one meant, such as 9 on the way from 90
 * to 30 days of logs, and a field that shows the saved value drops the keys pressed before main has answered
 * the save of the previous one.
 */
export function useFieldDraft<T>(saved: T, { format, parse, save }: FieldDraftOptions<T>): FieldDraft<T> {
  const shown = format(saved)
  const [draft, setDraft] = useState<Draft | null>(null)
  // The saves of this field main has not answered, and the number of the last one sent.
  const unanswered = useRef(0)
  const lastSave = useRef(0)
  const typed = draft === null || (draft.kind === 'left' && draft.over !== shown) ? null : draft.text
  const parsed = typed === null ? null : parse(typed)
  useEffect(() => {
    setDraft((current) => {
      if (current === null || current.kind === 'typing' || current.over === shown) return current
      if (current.kind === 'saving') return { ...current, over: shown, seen: current.seen || shown === current.sent }
      return null
    })
  }, [shown])
  const leave = (): void => {
    if (draft === null || typed === null || draft.kind === 'saving' || (draft.kind === 'left' && !draft.failed)) return
    if (parsed === null) {
      setDraft(null)
      return
    }
    const text = format(parsed)
    // Text typed back to what was saved needs no save, unless an earlier save of the field is still on its
    // way and is about to change the saved value.
    const unchanged = text === shown || (draft.kind === 'typing' && text === draft.from)
    if (unchanged && unanswered.current === 0) {
      setDraft(null)
      return
    }
    const id = ++lastSave.current
    unanswered.current += 1
    setDraft({ kind: 'saving', text: typed, id, sent: text, over: shown, seen: false })
    void save(parsed).then((ok) => {
      unanswered.current -= 1
      setDraft((current) => {
        if (current?.kind !== 'saving' || current.id !== id) return current
        // Main's answer can arrive before the change main sent ahead of it: with Electron 43.7.7, the answer
        // to ipcRenderer.invoke overtook a webContents.send made in the handler 2 times in 2000 calls made
        // one after another, and 61 times in 500 made at once (2026-10-02). A text not yet seen waits for it.
        if (ok && current.seen) return null
        return { kind: 'left', text: current.text, over: current.over, failed: !ok }
      })
    })
  }
  // The field also goes away while it has focus, as when Escape closes the settings or the model opens another
  // task. Chromium sends a blur then, but React 19 dispatches no events while it commits the removal, so
  // onBlur never runs, and what was typed is saved on unmount by the same rule.
  const leaveOnUnmount = useRef(leave)
  useEffect(() => {
    leaveOnUnmount.current = leave
  })
  useEffect(() => () => leaveOnUnmount.current(), [])
  const failed = typed !== null && draft?.kind === 'left' && draft.failed
  return {
    props: {
      value: typed ?? shown,
      onChange: (event) => {
        const text = event.target.value
        setDraft((current) => ({ kind: 'typing', text, from: current?.kind === 'typing' ? current.from : shown }))
      },
      onBlur: leave,
      onKeyDown: (event) => {
        if (keyForApp(event) === 'Enter' && event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur()
      },
      'aria-invalid': failed
    },
    value: parsed ?? saved,
    failed,
    discard: () => setDraft(null)
  }
}
