import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/i18n'
import { errorKey } from '@shared/i18n/error-key'
import { errorText, readErrorText } from '@shared/i18n/error-text'
import { MAX_TASK_NOTES_LENGTH, MAX_TASK_TITLE_LENGTH, parseOrThrow, taskInputSchema } from '@shared/tasks'
import { useSettingsStore } from '../src/renderer/src/state/stores'
import { displayError } from '../src/renderer/src/display-error'

const t = createTranslator('ja-JP')

describe('displayError', () => {
  it('drops the wrapper Electron puts around an error thrown in the main process, whatever the error class', () => {
    // The wrapper names an IPC channel, which means nothing to the user.
    expect(displayError(new Error("Error invoking remote method 'settings-save': Error: 保存日数は 1 以上にしてください"))).toBe('保存日数は 1 以上にしてください')
    expect(displayError(new Error("Error invoking remote method 'mail-probe': TypeError: fetch failed"))).toBe('fetch failed')
  })

  it('keeps a message that only mentions the wrapper text later on, and turns a thrown non-error into text', () => {
    expect(displayError(new Error("開けませんでした: Error invoking remote method 'x': Error: y"))).toBe("開けませんでした: Error invoking remote method 'x': Error: y")
    expect(displayError('接続が切れました')).toBe('接続が切れました')
    expect(displayError({ code: 1 })).toBe('[object Object]')
  })

  it('writes an error that carries a message key in the language of the interface, while the message itself stays English for the log', () => {
    const message = errorText('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' })
    expect(message.startsWith("Couldn't start Qwen3-TTS.")).toBe(true)
    // The settings have not loaded, so the interface is in the source language.
    expect(displayError(new Error(`Error invoking remote method 'tts-prepare': Error: ${message}`))).toBe(t('settingsModels.preparation.startFailed', { model: 'Qwen3-TTS' }))
    useSettingsStore.setState({ settings: { uiLocale: 'en-US' } as never })
    expect(displayError(new Error(message))).toBe("Couldn't start Qwen3-TTS.")
    useSettingsStore.setState({ settings: null })
  })

  it('finds the key when other code has wrapped the message, and leaves an unknown key as plain text', () => {
    const wrapped = `settings: ${errorText('settingsModels.preparation.stopped')} (while saving)`
    expect(displayError(new Error(wrapped))).toContain(t('settingsModels.preparation.stopped'))
    expect(readErrorText('Something failed [asist:no.such.key]', 'ja-JP')).toBeNull()
    expect(displayError(new Error('Something failed [asist:no.such.key]'))).toBe('Something failed [asist:no.such.key]')
  })

  it('writes an error that wraps another one with both sentences in the language of the interface, and keeps the English sentence of the log free of the inner marker', () => {
    const inner = errorText('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH })
    const outer = errorText('tasks.errors.storeItemBroken', { index: 2, message: inner })
    expect(displayError(new Error(`Error invoking remote method 'tasks-list': Error: ${outer}`))).toBe(
      t('tasks.errors.storeItemBroken', { index: 2, message: t('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH }) })
    )
    const en = createTranslator('en-US')
    const logged = en('tasks.errors.storeItemBroken', { index: 2, message: en('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH }) })
    expect(outer.startsWith(`${logged} [asist:tasks.errors.storeItemBroken `)).toBe(true)

    // The settings service wraps the error it caught with String(error), which puts "Error: " in front.
    const file = 'odd }] "name".json'
    const read = errorText('settings.errors.readFailed', { file, message: String(new Error(inner)) })
    expect(displayError(new Error(read))).toBe(t('settings.errors.readFailed', { file, message: t('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH }) }))
  })

  it('writes an error thrown with its key alone, as the preview iframe throws one without the dictionary, and an error that wraps it', () => {
    const inner = errorKey('files.errors.zipEntryMissing', { path: 'word/document.xml' })
    expect(displayError(new Error(inner))).toBe(t('files.errors.zipEntryMissing', { path: 'word/document.xml' }))
    const outer = errorText('files.viewer.docxFailed', { message: inner })
    expect(displayError(new Error(outer))).toBe(t('files.viewer.docxFailed', { message: t('files.errors.zipEntryMissing', { path: 'word/document.xml' }) }))
    // The English sentence of the log leaves the inner marker out, as it does for an inner errorText.
    const en = createTranslator('en-US')
    expect(outer.startsWith(`${en('files.viewer.docxFailed', { message: '' })} [asist:files.viewer.docxFailed `)).toBe(true)
  })

  it('writes the first of several errors that one message joins, each with values of its own', () => {
    let thrown: unknown
    try {
      parseOrThrow(taskInputSchema, { title: 'a'.repeat(MAX_TASK_TITLE_LENGTH + 1), notes: 'b'.repeat(MAX_TASK_NOTES_LENGTH + 1) })
    } catch (error) {
      thrown = error
    }
    expect(displayError(thrown)).toBe(t('tasks.errors.titleTooLong', { limit: MAX_TASK_TITLE_LENGTH }))
  })
})
