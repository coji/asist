import mitt from 'mitt'
import { shell } from 'electron'
import type { NoteChange } from '@shared/notes'
import { createNoteService, type NoteService } from './notes'
import { dataPath } from './store'

let service: NoteService | null = null
/** Carries each change after it has been written, and ipc relays it to the renderer. */
export const events = mitt<{ changed: NoteChange }>()

/** The shared instance, created on first use so that the userData path is resolved only after app ready. */
export function getNoteService(): NoteService {
  return (service ??= createNoteService({
    directory: dataPath('notes'),
    trash: (filePath) => shell.trashItem(filePath),
    onChanged: (change) => events.emit('changed', change)
  }))
}
