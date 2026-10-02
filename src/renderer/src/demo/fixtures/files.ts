import type { FileItem } from '@shared/files'
import { DEMO_PDF_ITEMS } from './files-pdf'
import { DEMO_CODE_ITEMS } from './files-code'
import { DEMO_MEDIA_ITEMS } from './files-media'
import { DEMO_OFFICE_ITEMS } from './files-office'

/**
 * The samples of the files card. Text formats keep their contents here, while images and the like point
 * by URL at the static files served from demo-public/demo-files. The same viewer as in the real app
 * interprets them, so the mock only needs a path-to-item table.
 */
const DIR = '/Users/demo/asist-jobs/20260919-090000-competitors'
const now = Date.now()

export const DEMO_REPORT_MD = `# 競合サービスの比較

主要 3 社の料金と機能を、公開情報と体験版で確かめました。**差が大きいのは同時接続数の上限**で、価格差はそれほどありません。

## 料金と機能

| サービス | 月額 | 同時接続 | 無料枠 | 備考 |
| --- | ---: | ---: | :---: | --- |
| A | $20 | 5 | あり | 年払いで 2 割引 |
| B | $35 | 20 | なし | チーム向け機能が多い |
| C | $12 | 2 | あり | 個人向け |

## 所見

1. 個人で使うなら **C** で足ります。
2. 5 人以上のチームは **B** 一択です。同時接続の上限が効きます。
3. A は中間で、年払いの割引を入れると C と差が縮まります。

### 確かめ方

体験版で同じ操作を流して、応答時間を測りました。

\`\`\`bash
for s in a b c; do
  curl -s -w '%{time_total}\\n' -o /dev/null "https://$s.example.com/api/ping"
done
\`\`\`

- [x] 料金の確認
- [x] 同時接続の上限の確認
- [ ] サポートの応答時間(問い合わせ中)

> 注意: 価格は 2026-09-19 時点。B は来月に改定の告知があります。

詳しくは [公式の料金表](https://example.com/pricing) を参照してください。
`

export const DEMO_PRICING_CSV = `サービス,月額(USD),同時接続,無料枠,更新日
A,20,5,あり,2026-09-01
B,35,20,なし,2026-09-15
C,12,2,あり,2026-08-20
D,28,10,あり,2026-09-10
E,45,50,なし,2026-07-30
`

export const DEMO_CONFIG_JSON = `{
  "name": "competitors",
  "targets": ["A", "B", "C"],
  "timeoutMs": 5000,
  "retry": { "count": 3, "backoffMs": 500 }
}
`

export const DEMO_FILES: Record<string, FileItem> = {
  [`${DIR}/report.md`]: { path: `${DIR}/report.md`, name: 'report.md', kind: 'markdown', sizeBytes: 1830, modifiedAt: now - 6 * 3600_000, text: DEMO_REPORT_MD },
  [`${DIR}/pricing.csv`]: { path: `${DIR}/pricing.csv`, name: 'pricing.csv', kind: 'table', sizeBytes: 214, modifiedAt: now - 6 * 3600_000, text: DEMO_PRICING_CSV },
  [`${DIR}/config.json`]: { path: `${DIR}/config.json`, name: 'config.json', kind: 'data', sizeBytes: 120, modifiedAt: now - 7 * 3600_000, text: DEMO_CONFIG_JSON },
  [`${DIR}/notes/interview.md`]: {
    path: `${DIR}/notes/interview.md`,
    name: 'interview.md',
    kind: 'markdown',
    sizeBytes: 320,
    modifiedAt: now - 5 * 3600_000,
    text: '# ヒアリングのメモ\n\n- B の営業: 来月の改定は 10% 程度\n- C のサポート: 返信まで 2 営業日\n'
  },
  [`${DIR}/charts/chart-revenue.png`]: { path: `${DIR}/charts/chart-revenue.png`, name: 'chart-revenue.png', kind: 'image', sizeBytes: 32432, modifiedAt: now - 6 * 3600_000, url: '/demo-files/chart-revenue.png' },
  [`${DIR}/charts/chart-users.png`]: { path: `${DIR}/charts/chart-users.png`, name: 'chart-users.png', kind: 'image', sizeBytes: 20864, modifiedAt: now - 6 * 3600_000, url: '/demo-files/chart-users.png' },
  [`${DIR}/charts/screenshot.png`]: { path: `${DIR}/charts/screenshot.png`, name: 'screenshot.png', kind: 'image', sizeBytes: 4522, modifiedAt: now - 5 * 3600_000, url: '/demo-files/screenshot.png' },
  [`${DIR}/build.bin`]: { path: `${DIR}/build.bin`, name: 'build.bin', kind: 'binary', sizeBytes: 1_200_000, modifiedAt: now - 8 * 3600_000 }
}

DEMO_FILES[DIR] = {
  path: DIR,
  name: '20260919-090000-competitors',
  kind: 'directory',
  sizeBytes: 0,
  modifiedAt: now - 5 * 3600_000,
  entries: [
    { name: 'charts', path: `${DIR}/charts`, kind: 'directory', sizeBytes: 0 },
    { name: 'notes', path: `${DIR}/notes`, kind: 'directory', sizeBytes: 0 },
    { name: 'build.bin', path: `${DIR}/build.bin`, kind: 'binary', sizeBytes: 1_200_000 },
    { name: 'config.json', path: `${DIR}/config.json`, kind: 'data', sizeBytes: 120 },
    { name: 'pricing.csv', path: `${DIR}/pricing.csv`, kind: 'table', sizeBytes: 214 },
    { name: 'report.md', path: `${DIR}/report.md`, kind: 'markdown', sizeBytes: 1830 }
  ],
  entryCount: 6
}
DEMO_FILES[`${DIR}/charts`] = {
  path: `${DIR}/charts`,
  name: 'charts',
  kind: 'directory',
  sizeBytes: 0,
  entries: ['chart-revenue.png', 'chart-users.png', 'screenshot.png'].map((name) => ({ name, path: `${DIR}/charts/${name}`, kind: 'image' as const, sizeBytes: DEMO_FILES[`${DIR}/charts/${name}`].sizeBytes })),
  entryCount: 3
}

const DOWNLOADS = '/Users/demo/Downloads'
/** A folder holding more entries than main lists, which sends the first 200 and the number the folder holds. */
DEMO_FILES[DOWNLOADS] = {
  path: DOWNLOADS,
  name: 'Downloads',
  kind: 'directory',
  sizeBytes: 0,
  modifiedAt: now - 20 * 60_000,
  entries: Array.from({ length: 200 }, (_, i) => {
    const name = `IMG_${4021 + i}.jpeg`
    return { name, path: `${DOWNLOADS}/${name}`, kind: 'image' as const, sizeBytes: 1_800_000 + i * 3517 }
  }),
  entryCount: 5214
}

Object.assign(DEMO_FILES, Object.fromEntries(DEMO_PDF_ITEMS.map((item) => [item.path, item])))
Object.assign(DEMO_FILES, Object.fromEntries(DEMO_MEDIA_ITEMS.map((item) => [item.path, item])))
Object.assign(DEMO_FILES, Object.fromEntries(DEMO_OFFICE_ITEMS.map((item) => [item.path, item])))

export const DEMO_FILES_DIR = DIR
export const DEMO_DOWNLOADS_DIR = DOWNLOADS

Object.assign(DEMO_FILES, Object.fromEntries(DEMO_CODE_ITEMS.map((item) => [item.path, item])))
export const DEMO_IMAGE_PATHS = ['chart-revenue.png', 'chart-users.png', 'screenshot.png'].map((name) => `${DIR}/charts/${name}`)
export const DEMO_MIXED_PATHS = [`${DIR}/report.md`, `${DIR}/pricing.csv`, `${DIR}/charts/chart-revenue.png`, `${DIR}/config.json`, `${DIR}/missing.txt`, `${DIR}/build.bin`]

/** A path that is not in the table becomes an item carrying the error "ファイルがありません" ("no such file"). */
export function demoFileItems(paths: string[]): FileItem[] {
  return paths.map(
    (path) => DEMO_FILES[path] ?? { path, name: path.split('/').pop() ?? path, kind: 'binary', sizeBytes: 0, error: 'ファイルがありません' }
  )
}
