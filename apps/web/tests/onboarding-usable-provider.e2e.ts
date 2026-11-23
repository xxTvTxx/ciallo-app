// Keyless browser e2e: a user who configures some OTHER provider is not
// offered the CialloAPI first-run step again. The shipped DeepSeek adapter
// stays mounted without a credential throughout, so the only thing that ends
// onboarding here is the provider the user configures through the real wire.
// Zero model calls: configuration is pure settings/credentials/llm-domain traffic.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, CIALLO_START_COPY, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: another usable provider ends first-run onboarding', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('stops offering the CialloAPI step once another provider can serve requests', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-other-provider'))
    const start = page.getByRole('dialog', { name: CIALLO_START_COPY.zh.title, exact: true })
    await start.waitFor({ timeout: 15_000 })
    await start.getByRole('button', { name: CIALLO_START_COPY.zh.later, exact: true }).click()
    await start.waitFor({ state: 'detached', timeout: 15_000 })

    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    // Deferring the step leaves Settings closed, so enter the Models section explicitly.
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const add = settings.getByRole('button', { name: '添加模型提供商' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    await settings.getByLabel('提供商', { exact: true }).selectOption('minimax-cn')
    await settings.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('sk-e2e-minimax')
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 minimax-cn。', { exact: true }).waitFor({ timeout: 15_000 })

    // Only minimax-cn is reachable; DeepSeek still holds no credential.
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(credentials).not.toContain('DEEPSEEK_API_KEY')

    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // The Models join has settled once the configured row renders, so the step's absence is conclusive.
    await openSettings(page, 'zh')
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByRole('button', { name: '编辑 minimax-cn', exact: true }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('dialog', { name: CIALLO_START_COPY.zh.title }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)

    expect((await page.content()).includes('sk-e2e-minimax')).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
