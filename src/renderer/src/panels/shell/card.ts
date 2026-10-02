import type { PanelSpec } from '@shared/ipc'

/**
 * The card contract. The types shared between the shell (Dock / PanelCard / PanelContent / FocusOverlay) and
 * a card, and the rule that picks a size, live only here.
 *
 * The size follows the dock's inner height: the shell measures it and hands it to the card. A card must fit
 * the height of the size it is given, and must not read the window height or vh itself.
 * - s: the floor every card has. It fits the height the dock keeps at the minimum window height of 640.
 * - m / l: used when the dock's inside is at least CARD_SIZE_MIN_HEIGHT.
 * - focus: the centered enlarged view. It scrolls within 82vh, so it has no upper bound.
 */
export type CardSize = 's' | 'm' | 'l'
export type CardSurfaceSize = CardSize | 'focus'

/**
 * The dock's inner height (px) needed before m and l are used. Measured in the demo on 2026-09-15, the weather
 * card is naturally l 689px / m 604px / s 471px, and these values still hold it when a partly failed fetch adds
 * its extra line of about 19px. The 720 for l also fits the 728px the dock keeps when a 1440x900 screen is
 * maximized.
 */
export const CARD_SIZE_MIN_HEIGHT: Record<Exclude<CardSize, 's'>, number> = { m: 625, l: 720 }

/**
 * The height (px) an s card must fit into. A minimum window of 640px leaves about 540px once the 78px top bar
 * and the dock's 18px padding are taken off, and this value keeps a little room below that.
 */
export const CARD_S_MAX_HEIGHT = 520

export function cardSizeFor(dockInnerHeight: number): CardSize {
  if (dockInnerHeight >= CARD_SIZE_MIN_HEIGHT.l) return 'l'
  if (dockInnerHeight >= CARD_SIZE_MIN_HEIGHT.m) return 'm'
  return 's'
}

export interface CardContext {
  spec: PanelSpec
  size: CardSurfaceSize
}

/**
 * - Body: draws only inside the box and the size the shell gives it.
 * - className: the class put on the card frame. It is the place to set --card-hue, from which the theme draws
 *   the frame, and --card-focus-width.
 * - meta: extra text at the right of the header, such as an issue time. It is drawn only once the data is there.
 * - backdrop: a full-surface background reaching under the header. It is drawn only once the data is there.
 * - scroll: a card whose content has no fixed length scrolls the overflow inside itself. A card without it is
 *   reported as a defect when its content does not fit.
 * Body, meta and backdrop are components rather than functions the shell calls, so that whatever a card does
 * runs inside the error boundary that holds the card.
 */
export interface CardDefinition {
  Body: React.FC<CardContext>
  kicker: string
  className?: string
  meta?: React.FC<CardContext>
  backdrop?: React.FC<CardContext>
  scroll?: boolean
}

/** Whether the body, meta and backdrop may be drawn. In the skeleton, loading and error states the props are incomplete. */
export const hasCardData = (spec: PanelSpec): boolean => spec.state === 'ready' || spec.state === 'stale'
