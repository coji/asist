import mitt from 'mitt'
import { shell } from 'electron'
import type { NoteChange } from '@shared/notes'
import { createNoteService, type NoteService } from './notes'
import { dataPath } from './store'

let service: NoteService | null = null
/** Carries the changes of one save or one look at the folder, and ipc relays them to the renderer. */
export const events = mitt<{ changed: NoteChange[] }>()

/** The shared instance, created on first use so that the userData path is resolved only after app ready. */
export function getNoteService(): NoteService {
  return (service ??= createNoteService({
    directory: dataPath('notes'),
    trash: (filePath) => shell.trashItem(filePath),
    onChanged: (changes) => events.emit('changed', changes)
  }))
}
