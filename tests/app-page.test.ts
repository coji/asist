import { describe, expect, it } from 'vitest'
import { isAppPage } from '@shared/app-page'

describe('isAppPage', () => {
  const packaged = 'file:///Applications/ASIST.app/Contents/Resources/app.asar/out/renderer/index.html'

  it('accepts the packaged page, with or without a fragment', () => {
    expect(isAppPage(packaged, packaged)).toBe(true)
    expect(isAppPage(`${packaged}#/settings`, packaged)).toBe(true)
  })

  it('refuses another local file, such as an HTML file dropped on the window', () => {
    expect(isAppPage('file:///Users/me/Downloads/page.html', packaged)).toBe(false)
  })

  it('accepts the packaged page on Windows whichever case its drive letter is written in, and no other file on the drive', () => {
    const windows = 'file:///c:/Program%20Files/ASIST/resources/app.asar/out/renderer/index.html'
    expect(isAppPage('file:///C:/Program%20Files/ASIST/resources/app.asar/out/renderer/index.html#/settings', windows)).toBe(true)
    expect(isAppPage('file:///C:/Users/me/Downloads/index.html', windows)).toBe(false)
  })

  it('refuses a web page the window was sent to', () => {
    expect(isAppPage('https://attacker.example/index.html', packaged)).toBe(false)
  })

  it('accepts any path of the development server but no other origin', () => {
    const dev = 'http://localhost:5173/'
    expect(isAppPage('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isAppPage('http://localhost:5174/', dev)).toBe(false)
    expect(isAppPage(packaged, dev)).toBe(false)
  })

  it('refuses a value that is not a URL', () => {
    expect(isAppPage('', packaged)).toBe(false)
  })
})
