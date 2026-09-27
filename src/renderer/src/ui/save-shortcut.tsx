import type { KeyboardEvent } from 'react'
import { shortcutLabel } from '@shared/platform'
import { platformCapabilities } from '@/platform'

/** The key that saves the document open in the editor of notes or of memory: ⌘S on macOS, Ctrl+S on Windows. */
export const isSaveShortcut = (event: KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && event.key === 's'

/** The save key as this OS writes it, shown on the save button. */
export function SaveShortcutKey(): React.JSX.Element {
  return <kbd>{shortcutLabel(platformCapabilities().os, 'CommandOrControl+S')}</kbd>
}
