import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CIALLO_USER_DATA_DIR_NAME, isolateDesktopUserData } from '../src/user-data.ts'

describe('isolateDesktopUserData', () => {
  it('redirects the default package-scoped userData path to Ciallo', () => {
    const appData = join('C:', 'Users', 'alice', 'AppData', 'Roaming')
    let userData = join(appData, '@deepseek-ai', 'dsh-desktop')
    const setPath = vi.fn((name: 'userData' | 'sessionData', next: string) => {
      if (name === 'userData') userData = next
    })

    isolateDesktopUserData({
      getPath: name => name === 'appData' ? appData : userData,
      setPath,
    }, ['Ciallo.exe'])

    const expected = join(appData, CIALLO_USER_DATA_DIR_NAME)
    expect(setPath).toHaveBeenCalledWith('userData', expected)
    expect(setPath).toHaveBeenCalledWith('sessionData', expected)
  })

  it('preserves explicit --user-data-dir arguments and custom test userData paths', () => {
    const appData = join('C:', 'Users', 'alice', 'AppData', 'Roaming')
    const setPath = vi.fn()

    isolateDesktopUserData({
      getPath: name => name === 'appData' ? appData : join(appData, '@deepseek-ai', 'dsh-desktop'),
      setPath,
    }, ['Ciallo.exe', '--user-data-dir=C:\\tmp\\custom'])
    isolateDesktopUserData({
      getPath: name => name === 'appData' ? appData : join('C:', 'tmp', 'harness'),
      setPath,
    }, ['Ciallo.exe'])

    expect(setPath).not.toHaveBeenCalled()
  })
})
