/** Electron userData path isolation from official DeepSeek Harness installations. */

import { join } from 'node:path'

/** Minimal Electron application paths API needed for userData isolation. */
export interface DesktopUserDataApplication {
  getPath(name: 'appData' | 'userData'): string
  setPath?(name: 'userData' | 'sessionData', path: string): void
}

/** Package-derived directory segment shared with official DeepSeek Harness if left unchanged. */
const SHARED_PACKAGE_USER_DATA = join('@deepseek-ai', 'dsh-desktop')

/** Isolated directory name under Electron `appData` for Ciallo Desktop. */
export const CIALLO_USER_DATA_DIR_NAME = 'Ciallo'

/**
 * Redirect Electron's package-scoped default `userData` (`<appData>/@deepseek-ai/dsh-desktop`)
 * to `<appData>/Ciallo` so Ciallo never shares single-instance locks, logs, or Chromium state
 * with an installed DeepSeek Harness desktop app, while preserving explicit `--user-data-dir`
 * overrides and test harnesses.
 * @param electronApp - Electron application object.
 * @param argv - Command-line arguments inspected for `--user-data-dir`.
 */
export function isolateDesktopUserData(
  electronApp: DesktopUserDataApplication,
  argv: readonly string[] = process.argv,
): void {
  if (typeof electronApp.setPath !== 'function') return
  if (argv.some(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))) return
  const appData = electronApp.getPath('appData')
  if (typeof appData !== 'string' || appData.length === 0) return
  if (electronApp.getPath('userData') !== join(appData, SHARED_PACKAGE_USER_DATA)) return
  const isolated = join(appData, CIALLO_USER_DATA_DIR_NAME)
  electronApp.setPath('userData', isolated)
  electronApp.setPath('sessionData', isolated)
}
