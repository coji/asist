import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * The key a keydown means for the app, or null for a key the IME takes. Chromium on macOS sends the Enter
 * that confirms a conversion and the Escape that cancels one as keydowns of those keys with isComposing set,
 * so a handler that read `key` alone would also act on them.
 */
export function keyForApp(event: KeyboardEvent | ReactKeyboardEvent): string | null {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing ? null : native.key
}
