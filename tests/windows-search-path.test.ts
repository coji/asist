import { describe, expect, it } from 'vitest'
import { windowsPathFolders } from '../src/main/services/windows-search-path'

describe('the folders of a Windows PATH', () => {
  it('keeps absolute folders in order and drops empty and relative entries', () => {
    expect(windowsPathFolders('C:\\a;;.\\bin;tools;C:\\b\\;\\\\server\\share\\bin;')).toEqual(['C:\\a', 'C:\\b\\', '\\\\server\\share\\bin'])
  })

  it('drops the quotes around a folder', () => {
    expect(windowsPathFolders('"C:\\Program Files\\Git\\cmd";C:\\b')).toEqual(['C:\\Program Files\\Git\\cmd', 'C:\\b'])
  })

  it('does not split a quoted folder at the ; inside it', () => {
    expect(windowsPathFolders('C:\\a;"C:\\odd;name\\bin";C:\\b')).toEqual(['C:\\a', 'C:\\odd;name\\bin', 'C:\\b'])
  })

  it('leaves out a quoted folder that is relative', () => {
    expect(windowsPathFolders('"rel;ative";C:\\a')).toEqual(['C:\\a'])
  })

  it('takes a quote only where an entry begins, so a stray one at the end of an entry leaves the next entries apart', () => {
    expect(windowsPathFolders('C:\\Program Files\\Git\\cmd";C:\\Windows\\System32;C:\\Users\\me\\.local\\bin')).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\Windows\\System32',
      'C:\\Users\\me\\.local\\bin'
    ])
    expect(windowsPathFolders('C:\\a"b;C:\\c')).toEqual(['C:\\a"b', 'C:\\c'])
  })

  it('reads single quotes as double ones, and runs an unclosed quote at the start of an entry to the end', () => {
    expect(windowsPathFolders("'C:\\x;y';C:\\z")).toEqual(['C:\\x;y', 'C:\\z'])
    expect(windowsPathFolders('C:\\a;"C:\\b;C:\\c')).toEqual(['C:\\a', 'C:\\b;C:\\c'])
  })
})
