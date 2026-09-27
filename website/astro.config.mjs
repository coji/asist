import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { LANGUAGES, ROOT_LANGUAGE } from './src/i18n/languages.mjs'

/** The chapters of the documentation, in the order of the sidebar; each one lists the pages of its folder. */
const chapter = (directory, label, en) => ({ label, translations: { en }, items: [{ autogenerate: { directory: `docs/${directory}` } }] })

export default defineConfig({
  site: 'https://asist-agent.com',
  server: { port: 5194 },
  integrations: [
    starlight({
      title: 'ASIST',
      description: 'Mac と Windows で使えるリアルタイムアシスタント',
      logo: { src: './src/assets/asist.png' },
      favicon: '/icons/asist.png',
      routeMiddleware: './src/route-middleware.ts',
      defaultLocale: 'root',
      locales: Object.fromEntries(
        LANGUAGES.filter((language) => language.docs).map((language) => [
          language.code === ROOT_LANGUAGE ? 'root' : language.code,
          { label: language.label, lang: language.code }
        ])
      ),
      components: {
        LanguageSelect: './src/components/DocsLanguageSelect.astro',
        ThemeSelect: './src/components/DocsThemeSelect.astro'
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/nyosegawa/asist' }],
      editLink: { baseUrl: 'https://github.com/nyosegawa/asist/edit/main/website/' },
      customCss: ['./src/styles/docs.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap' }
        },
        {
          tag: 'script',
          content: `if (location.hostname === 'asist-agent.com') {
  window.dataLayer = window.dataLayer || []
  window.gtag = function () { dataLayer.push(arguments) }
  gtag('js', new Date())
  gtag('config', 'G-NC5XEGGKJ8')
  const tag = document.createElement('script')
  tag.async = true
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=G-NC5XEGGKJ8'
  document.head.append(tag)
}`
        }
      ],
      sidebar: [
        { label: 'ドキュメント', translations: { en: 'Documentation' }, link: '/docs/' },
        chapter('start', 'はじめる', 'Getting started'),
        chapter('usage', '使い方', 'Using ASIST'),
        chapter('apps', 'ミニアプリ', 'Mini apps'),
        chapter('settings', '設定', 'Settings'),
        chapter('privacy', 'プライバシーとデータ', 'Privacy and data'),
        { label: '困ったとき', translations: { en: 'Troubleshooting' }, link: '/docs/troubleshooting/' },
        chapter('reference', '参考', 'Reference')
      ]
    })
  ]
})
