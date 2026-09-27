import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection, type CollectionEntry } from 'astro:content'
import { docsMarkdown } from '../docs-markdown'

/** Every documentation page is also served as Markdown, at its address with `.md` in place of the last slash. */
export const getStaticPaths = (async () =>
  (await getCollection('docs')).map((entry) => ({ params: { slug: entry.id }, props: { entry } }))) satisfies GetStaticPaths

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = ({ props: { entry } }) => {
  if (entry.body === undefined) throw new Error(`${entry.id} has no source to serve as Markdown`)
  const markdown = docsMarkdown({ title: entry.data.title, description: entry.data.description, body: entry.body })
  return new Response(markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}
