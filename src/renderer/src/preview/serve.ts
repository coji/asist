/**
 * The preview page's side of the channel to the viewers (panels/viewers/preview-client.ts). A viewer opens its
 * file as a document of a kind and asks the document for what it draws; each kind is a file under methods/, so
 * that the work of one viewer lives in its own file and is loaded only when that viewer first asks for it.
 */

/** A document open in the preview page: what a viewer can ask of it by name, and how to let go of what it holds. */
export interface PreviewDocument {
  methods: Record<string, (args: never) => unknown>
  close?(): void
}

/** What a file under methods/ exports by default: opens the file at a URL as a document of its kind, named by the file. */
export type OpenPreviewDocument = (url: string) => Promise<PreviewDocument>

export type PreviewKinds = Record<string, () => Promise<{ default: OpenPreviewDocument }>>

/**
 * A message from the viewers' side: a call to a method of a document, or the end of a document no viewer holds
 * any more. The viewers' side names each document by a key of its own, the version of the file included.
 */
export type PreviewRequest =
  | { type: 'call'; id: number; key: string; kind: string; url: string; method: string; args: unknown }
  | { type: 'close'; key: string }

/**
 * The page's first message on its port, sent as soon as the port reaches it. A frame that loaded anything else,
 * such as an error, never sends it, and nothing else tells the viewers' side that the frame did not load the page.
 */
export const CONNECTED = 'connected'

export type PreviewReply = typeof CONNECTED | { id: number; value: unknown } | { id: number; error: string }

/**
 * The buffers and bitmaps in a result, which go to the viewer without a copy. A method gives up what it
 * returns: a buffer it also keeps is empty on its side afterwards.
 */
function transferables(result: unknown): Transferable[] {
  const found = new Set<Transferable>()
  const seen = new Set<object>()
  const stack = [result]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (value instanceof ArrayBuffer || value instanceof ImageBitmap) found.add(value)
    else if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) found.add(value.buffer)
    } else {
      // One push at a time: spreading the items into one call throws RangeError past about 150,000 of them,
      // which a sheet's shared strings or a waveform's peaks reach.
      for (const item of Object.values(value)) stack.push(item)
    }
  }
  return [...found]
}

async function openDocument(kinds: PreviewKinds, kind: string, url: string): Promise<PreviewDocument> {
  // Vite writes the keys of import.meta.glob as module specifiers, which end in /<name>.ts on every OS.
  const load = Object.entries(kinds).find(([specifier]) => specifier.endsWith(`/${kind}.ts`))?.[1]
  if (!load) throw new Error(`the preview page has no kind ${kind}`)
  const { default: open } = await load()
  return open(url)
}

/** Answers the viewers' requests on the port, keeping one document open for each key the viewers hold. */
export function servePreview(port: MessagePort, kinds: PreviewKinds): void {
  const documents = new Map<string, Promise<PreviewDocument>>()

  function opened(request: Extract<PreviewRequest, { type: 'call' }>): Promise<PreviewDocument> {
    const known = documents.get(request.key)
    if (known) return known
    const opening = openDocument(kinds, request.kind, request.url)
    documents.set(request.key, opening)
    // A document that failed to open is not kept, so that the next request, such as the focus view's, tries again.
    opening.catch(() => {
      if (documents.get(request.key) === opening) documents.delete(request.key)
    })
    return opening
  }

  async function answer(request: Extract<PreviewRequest, { type: 'call' }>): Promise<void> {
    try {
      const { methods } = await opened(request)
      if (!Object.hasOwn(methods, request.method)) throw new Error(`the ${request.kind} preview has no method ${request.method}`)
      const value = await methods[request.method](request.args as never)
      port.postMessage({ id: request.id, value } satisfies PreviewReply, transferables(value))
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies PreviewReply)
    }
  }

  port.addEventListener('message', ({ data }: MessageEvent<PreviewRequest>) => {
    if (data.type === 'call') {
      void answer(data)
      return
    }
    const closing = documents.get(data.key)
    documents.delete(data.key)
    // A document that failed to open has nothing to let go of.
    void closing?.then(
      (document) => document.close?.(),
      () => undefined
    )
  })
  port.start()
  port.postMessage(CONNECTED satisfies PreviewReply)
}
