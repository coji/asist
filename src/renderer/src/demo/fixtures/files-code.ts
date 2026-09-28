import type { FileItem } from '@shared/files'
import DEMO_REPORT_HTML from '../../../demo-public/demo-files/html/report.html?raw'

/**
 * The code, data and notebook samples of the files card. Their contents live here, because text formats
 * need no static hosting. The ipynb is nbformat 4 and holds one cell each of markdown, code, stream
 * output, a small PNG output and an error output. files.ts adds these entries to DEMO_FILES, so this
 * file must not import files.ts: that would be a cycle. The HTML report is the exception: its page is
 * served from demo-public/demo-files/html so that its stylesheet, script and image resolve next to it,
 * and its source is read from that same file.
 */
const DIR = '/Users/demo/asist-jobs/20260919-090000-competitors'
const now = Date.now()

export const DEMO_FETCH_TS = `import { readFile, writeFile } from 'node:fs/promises'

/**
 * 各サービスの料金ページを取りに行き、月額と同時接続数を pricing.csv に書く。
 * 応答が遅いサービスは timeoutMs で打ち切り、retry.count 回まで待って繰り返す。
 */
interface Target {
  name: string
  url: string
}

interface Config {
  targets: Target[]
  timeoutMs: number
  retry: { count: number; backoffMs: number }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(url: string, config: Config): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retry.count; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) })
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`)
      return await response.text()
    } catch (error) {
      lastError = error
      await sleep(config.retry.backoffMs * 2 ** attempt) // 500, 1000, 2000…
    }
  }
  throw lastError
}

export async function main(): Promise<void> {
  const config = JSON.parse(await readFile('config.json', 'utf8')) as Config
  const rows = ['サービス,月額(USD),同時接続']
  for (const target of config.targets) {
    const html = await fetchWithRetry(target.url, config)
    const price = /\\$(\\d+)\\s*\\/\\s*month/i.exec(html)?.[1] ?? ''
    const seats = /(\\d+) concurrent/i.exec(html)?.[1] ?? ''
    rows.push([target.name, price, seats].join(','))
  }
  await writeFile('pricing.csv', rows.join('\\n') + '\\n')
}
`

export const DEMO_SUMMARIZE_PY = `"""pricing.csv を読んで、月額あたりの同時接続数でサービスを並べる。"""
import csv
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Service:
    name: str
    price: int
    seats: int

    @property
    def seats_per_dollar(self) -> float:
        return self.seats / self.price if self.price else 0.0


def load(path: Path) -> list[Service]:
    with path.open(encoding="utf-8") as f:
        rows = csv.DictReader(f)
        return [Service(r["サービス"], int(r["月額(USD)"]), int(r["同時接続"])) for r in rows]


if __name__ == "__main__":
    services = sorted(load(Path("pricing.csv")), key=lambda s: s.seats_per_dollar, reverse=True)
    for s in services:
        print(f"{s.name}: {s.seats_per_dollar:.2f} 接続/USD")  # 大きいほど割安
`

export const DEMO_RESULTS_JSON = JSON.stringify(
  {
    generatedAt: '2026-09-19T09:12:44+09:00',
    source: 'fetch-pricing.ts',
    services: [
      { name: 'A', price: 20, seats: 5, freeTier: true, plans: { monthly: 20, yearly: 192 }, tags: ['mid', 'discount'] },
      { name: 'B', price: 35, seats: 20, freeTier: false, plans: { monthly: 35, yearly: 420 }, tags: ['team'] },
      { name: 'C', price: 12, seats: 2, freeTier: true, plans: { monthly: 12, yearly: 120 }, tags: ['personal'] }
    ],
    summary: { cheapest: 'C', mostSeats: 'B', note: null, checked: 3 }
  },
  null,
  2
)

export const DEMO_SETTINGS_YAML = `# 調査ジョブの設定
job: competitors
timeoutMs: 5000
retry:
  count: 3
  backoffMs: 500
targets:
  - name: A
    url: https://a.example.com/pricing
  - name: B
    url: https://b.example.com/pricing
  - name: C
    url: https://c.example.com/pricing
output:
  csv: pricing.csv
  report: report.md
notify: true
`

/** A 96x48 bar chart with three bars, standing in for the output of matplotlib. */
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAAAb0lEQVR42u3QMRHAIBAAQRxFEn5ooisVMyjACfQUVF/l9+YUbFm6VhAAAgQIECBAgAAJECBAgFID1fGFDAgQIECAAAECBOiot5gBAQIECBAgQOmAnneGDAgQIECAAAECBAgQIECAAAECBAgQoJ8CbWjFsKOwIu0oAAAAAElFTkSuQmCC'

export const DEMO_NOTEBOOK = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python', version: '3.12.4' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# 料金の分析\n', '\n', '`pricing.csv` を読み、**月額あたりの同時接続数**で比べる。\n'] },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: ['import pandas as pd\n', '\n', 'df = pd.read_csv("pricing.csv")\n', 'df["seats_per_usd"] = df["同時接続"] / df["月額(USD)"]\n', 'print(df.to_string(index=False))'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['サービス  月額(USD)  同時接続  seats_per_usd\n', '   A        20       5       0.250000\n', '   B        35      20       0.571429\n', '   C        12       2       0.166667\n'] }]
    },
    {
      cell_type: 'code',
      execution_count: 2,
      metadata: {},
      source: ['ax = df.plot.bar(x="サービス", y="seats_per_usd", legend=False)\n', 'ax.set_ylabel("接続 / USD")'],
      outputs: [
        { output_type: 'execute_result', execution_count: 2, metadata: {}, data: { 'text/plain': ["Text(0, 0.5, '接続 / USD')"] } },
        { output_type: 'display_data', metadata: {}, data: { 'image/png': DEMO_PNG_BASE64, 'text/plain': ['<Figure size 640x480 with 1 Axes>'] } }
      ]
    },
    { cell_type: 'markdown', metadata: {}, source: ['## 無料枠のあるものだけ\n'] },
    {
      cell_type: 'code',
      execution_count: 3,
      metadata: {},
      source: ['df[df["無料枠"] == "あり"]'],
      outputs: [
        {
          output_type: 'error',
          ename: 'KeyError',
          evalue: "'無料枠'",
          traceback: [
            '\u001b[0;31m---------------------------------------------------------------------------\u001b[0m',
            '\u001b[0;31mKeyError\u001b[0m                                  Traceback (most recent call last)',
            'Cell \u001b[0;32mIn[3], line 1\u001b[0m\n\u001b[0;32m----> 1\u001b[0m df[df[\u001b[38;5;124m"\u001b[39m\u001b[38;5;124m無料枠\u001b[39m\u001b[38;5;124m"\u001b[39m] \u001b[38;5;241m==\u001b[39m \u001b[38;5;124m"\u001b[39m\u001b[38;5;124mあり\u001b[39m\u001b[38;5;124m"\u001b[39m]',
            "\u001b[0;31mKeyError\u001b[0m: '無料枠'"
          ]
        }
      ]
    }
  ]
}

export const DEMO_NOTEBOOK_JSON = JSON.stringify(DEMO_NOTEBOOK, null, 1)

const item = (relative: string, kind: FileItem['kind'], text: string, hoursAgo: number): FileItem => ({
  path: `${DIR}/${relative}`,
  name: relative.slice(relative.lastIndexOf('/') + 1),
  kind,
  sizeBytes: new TextEncoder().encode(text).length,
  modifiedAt: now - hoursAgo * 3600_000,
  text
})

export const DEMO_CODE_ITEMS: FileItem[] = [
  item('scripts/fetch-pricing.ts', 'code', DEMO_FETCH_TS, 9),
  item('scripts/summarize.py', 'code', DEMO_SUMMARIZE_PY, 8),
  item('data/results.json', 'data', DEMO_RESULTS_JSON, 6),
  item('config/settings.yaml', 'data', DEMO_SETTINGS_YAML, 10),
  item('analysis.ipynb', 'notebook', DEMO_NOTEBOOK_JSON, 5),
  { ...item('report/index.html', 'code', DEMO_REPORT_HTML, 4), url: '/demo-files/html/report.html' }
]

export const DEMO_CODE_PATH = `${DIR}/scripts/fetch-pricing.ts`
export const DEMO_JSON_PATH = `${DIR}/data/results.json`
export const DEMO_NOTEBOOK_PATH = `${DIR}/analysis.ipynb`
export const DEMO_HTML_PATH = `${DIR}/report/index.html`
