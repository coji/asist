import type { FileItem } from '@shared/files'

/**
 * The Office samples (Word, Excel, PowerPoint). Real but tiny files live in demo-public/demo-files/office
 * and are referenced by URL; their OOXML was assembled by hand. sales-2025.xlsx claims a size over the
 * workbook's limit, so the viewer shows it as too large and never reads the tiny file its URL names.
 */
const DIR = '/Users/demo/asist-jobs/20260919-090000-competitors'
const now = Date.now()

export const DEMO_DOCX_PATH = `${DIR}/report.docx`
export const DEMO_XLSX_PATH = `${DIR}/pricing.xlsx`
export const DEMO_PPTX_PATH = `${DIR}/slides.pptx`
export const DEMO_LARGE_XLSX_PATH = `${DIR}/sales-2025.xlsx`

export const DEMO_OFFICE_ITEMS: FileItem[] = [
  { path: DEMO_DOCX_PATH, name: 'report.docx', kind: 'docx', sizeBytes: 3037, modifiedAt: now - 4 * 3600_000, url: '/demo-files/office/report.docx' },
  { path: DEMO_XLSX_PATH, name: 'pricing.xlsx', kind: 'xlsx', sizeBytes: 10005, modifiedAt: now - 4 * 3600_000, url: '/demo-files/office/pricing.xlsx' },
  { path: DEMO_PPTX_PATH, name: 'slides.pptx', kind: 'pptx', sizeBytes: 13732, modifiedAt: now - 3 * 3600_000, url: '/demo-files/office/slides.pptx' },
  { path: DEMO_LARGE_XLSX_PATH, name: 'sales-2025.xlsx', kind: 'xlsx', sizeBytes: 168_421_376, modifiedAt: now - 2 * 3600_000, url: '/demo-files/office/pricing.xlsx' }
]
