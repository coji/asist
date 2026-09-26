import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isExternalLink } from '@shared/external-link'
import { Frame } from './Frame'
import type { Viewer } from './types'
import { useT } from '@/i18n'
import { openLink } from '@/open-link'
import { osMessageKey } from '@shared/i18n/os-message'
import { platformCapabilities } from '@/platform'

/**
 * Markdown drawn as a document. GFM (tables, task lists, strikethrough, autolinks) is understood and raw HTML
 * is not passed through. A link to a web page or a mail address opens outside the app, and any other link,
 * such as one relative to the file, keeps its text but is not drawn as a link. An image given by a relative
 * path shows only its alt text, because a reference relative to the file is not resolved. A notebook's
 * markdown cells and the notes use this same MarkdownContent.
 */
export function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  const t = useT()
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) =>
          href && isExternalLink(href) ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault()
                openLink(href)
              }}
            >
              {children}
            </a>
          ) : (
            <>{children}</>
          ),
        img: ({ src, alt }) =>
          typeof src === 'string' && /^(https?:|data:|asist-file:)/.test(src) ? (
            <img src={src} alt={alt ?? ''} />
          ) : (
            <span>[{alt || t('files.viewer.image')}]</span>
          )
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

export const MarkdownViewer: Viewer = ({ item, mode, size }) => {
  const t = useT()
  return (
    <Frame mode={mode} size={size}>
      <div className="fv-doc">
        <MarkdownContent text={item.text ?? ''} />
        {item.truncated && <p className="fv-note">{t(osMessageKey('files.viewer.truncatedMarkdown', platformCapabilities().os))}</p>}
      </div>
    </Frame>
  )
}
