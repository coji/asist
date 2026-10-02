import { formatBytes } from '@shared/files'
import { Frame } from './Frame'
import type { Viewer, ViewerProps } from './types'
import { useT } from '@/i18n'

/**
 * A placard in place of a file's content. It gives the reason with the path and the size, and leaves opening the
 * file to the card's Finder action.
 */
function Placard({ item, mode, size, reason }: ViewerProps & { reason: string }): React.JSX.Element {
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-stub">
        <span>{reason}</span>
        <small>
          {item.path}
          {item.sizeBytes > 0 && ` · ${formatBytes(item.sizeBytes)}`}
        </small>
      </div>
    </Frame>
  )
}

/** For a kind whose content cannot be drawn yet, such as an executable, and for an item that could not be read. */
export const StubViewer: Viewer = (props) => {
  const t = useT()
  return <Placard {...props} reason={props.item.error ?? t('files.viewer.stub', { kind: t(`files.kind.${props.item.kind}`) })} />
}

/** For a file larger than its viewer reads whole (cardView), which is never fetched. */
export const TooLargeViewer: Viewer = (props) => {
  const t = useT()
  return <Placard {...props} reason={t('files.viewer.tooLarge')} />
}
