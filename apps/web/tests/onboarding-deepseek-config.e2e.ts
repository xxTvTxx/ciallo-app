// Keyless browser e2e: the shipped DeepSeek adapter stays mounted while its
// credential is absent, so no provider can serve requests. The CialloAPI
// first-run step opens on its own and closes on "稍后配置"; the DeepSeek key
// added from the Models page lands write-only in an isolated harness home
// without a reload or model call, after which the step no longer opens.
import { randomBytes } from 'node:crypto'
import { assertModelInputLayout } from './model-input-layout.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, CIALLO_START_COPY, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/onboarding-deepseek-config', import.meta.url))
const START_EXPECTED = join(SNAPSHOT_DIR, 'start.expected.md')
const MISSING_EXPECTED = join(SNAPSHOT_DIR, 'missing.expected.md')
const MODELS_EXPECTED = join(SNAPSHOT_DIR, 'models.expected.md')
const DEFAULT_MODELS_EXPECTED = join(SNAPSHOT_DIR, 'default-models.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: first-run setup and DeepSeek credential configuration', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const browserConsole: string[] = []
  const secret = `dsh_onboarding_${randomBytes(12).toString('hex')}_test`

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', message => browserConsole.push(message.text()))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers the CialloAPI step until a provider is usable and stores a DeepSeek key write-only', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-config'))
    const start = page.getByRole('dialog', { name: CIALLO_START_COPY.zh.title, exact: true })
    await start.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)
    expect(await start.getByText(CIALLO_START_COPY.zh.description, { exact: true }).count()).toBe(1)
    expect(await start.getByRole('button').allTextContents()).toEqual(expect.arrayContaining([
      CIALLO_START_COPY.zh.later, CIALLO_START_COPY.zh.submit,
    ]))
    expect(await start.getByRole('button', { name: CIALLO_START_COPY.zh.submit, exact: true }).isDisabled()).toBe(true)
    await compareOrRefreshGolden(START_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)

    // Deferring is not configuration: nothing persists, so a reload offers the step again.
    await start.getByRole('button', { name: CIALLO_START_COPY.zh.later, exact: true }).click()
    await start.waitFor({ state: 'detached', timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    const firstReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, firstReloadWarnings)
    await start.waitFor({ timeout: 15_000 })
    await start.getByRole('button', { name: CIALLO_START_COPY.zh.later, exact: true }).click()
    await start.waitFor({ state: 'detached', timeout: 15_000 })

    // DeepSeek API without its key is offered by the add card rather than listed.
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const addProvider = settings.getByRole('button', { name: '添加模型提供商', exact: true })
    await addProvider.waitFor({ timeout: 10_000 })
    expect(await settings.getByRole('button', { name: '编辑 DeepSeek API (deepseek-official)', exact: true }).count()).toBe(0)
    await addProvider.click()
    await settings.getByLabel('提供商', { exact: true }).selectOption('deepseek-official')
    const keyInput = settings.getByLabel('API 密钥', { exact: true })
    await keyInput.waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(MISSING_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)

    await keyInput.fill(secret)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 DeepSeek API (deepseek-official)。', { exact: true }).waitFor({ timeout: 15_000 })

    const stored = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(stored.includes(`DEEPSEEK_API_KEY: ${secret}`)).toBe(true)
    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)

    // The configured provider is now an ordinary row exposing the write-only placeholder without a reload.
    const deepSeekRow = settings.getByText('DeepSeek API', { exact: true }).first()
    await deepSeekRow.waitFor({ timeout: 10_000 })
    await deepSeekRow.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    const configuredInput = settings.getByLabel('API 密钥', { exact: true })
    await configuredInput.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => configuredInput.getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe(`dsh_onboa${'•'.repeat(31)}test`)

    // A usable provider exists, so the first-run step stays closed after a reload.
    const secondReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, secondReloadWarnings)
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    await openSettings(page, 'zh')
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    await settings.getByText('DeepSeek API', { exact: true }).first().waitFor({ timeout: 10_000 })
    expect(await page.getByRole('dialog', { name: CIALLO_START_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })

    expect((await page.content()).includes(secret)).toBe(false)
    expect((await page.locator('body').ariaSnapshot()).includes(secret)).toBe(false)
    expect(browserConsole.some(line => line.includes(secret))).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('never paints the takeover chrome on a configured reload, even with the settings join held open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-configured-reload'))
    // Regression pin for the reload flash: a provider is usable, yet the
    // first-run step must load private facts before deciding not to show. Dialog chrome lives
    // inside each visible branch, so the deciding window paints and blocks
    // nothing. Holding settings/describe widens that window from loopback
    // RTT scale to a deterministic hundreds of milliseconds, removing all
    // timing dependence from the sampler assertions below.
    //
    // The sampler init script persists across this shared page's later
    // navigations (init scripts re-run per navigation); that stays harmless
    // because no later scenario in this file legitimately shows the
    // takeover, and only this test reads __takeoverSightings.
    await page.addInitScript(() => {
      const sightings: string[] = []
      ;(window as unknown as { __takeoverSightings: string[] }).__takeoverSightings = sightings
      setInterval(() => {
        if (document.querySelector(
          '[role="dialog"][aria-label="开始使用 Ciallo"], '
          + '[role="dialog"][aria-label="开始使用"], '
          + '[role="dialog"][aria-label="添加一个 API Key 开始使用"]',
        ) !== null) {
          sightings.push('chrome')
        }
        if (document.getElementById('root')?.inert === true) sightings.push('inert')
      }, 8)
    })
    // EVERY settings/describe issued before the release is held — not just
    // the first — so the pin cannot silently collapse back to loopback
    // timing if a second boot-time consumer of the join ever appears.
    let released = false
    const heldRoutes: Array<() => void> = []
    const releaseDescribe = (): void => {
      released = true
      for (const resolve of heldRoutes.splice(0)) resolve()
    }
    await page.route('**/api/settings/describe', async (route) => {
      if (!released) await new Promise<void>((resolve) => { heldRoutes.push(resolve) })
      await route.continue()
    })
    const warningsBefore = tripwire.warnings.length
    await page.reload({ waitUntil: 'commit' })
    await page.waitForSelector('[class*="frame"]', { timeout: 15_000 })
    // The app is painted and interactive while the steps are still deciding.
    await page.waitForTimeout(600)
    releaseDescribe()
    await page.waitForTimeout(400)
    await page.unroute('**/api/settings/describe')
    acknowledgeReloadConnectionLoss(tripwire, warningsBefore)
    expect(await page.evaluate(() =>
      (window as unknown as { __takeoverSightings: string[] }).__takeoverSightings)).toEqual([])
    expect(await page.getByRole('dialog', { name: CIALLO_START_COPY.zh.title }).count()).toBe(0)
    expect(await page.getByRole('dialog', { name: '添加一个 API Key 开始使用' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('configures arbitrary DeepSeek models and prompts after the selected model is removed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-onboarding-deepseek-models'))
    // Opened here rather than inherited: the credential test reloads the page
    // after configuring the key, so nothing carries an open dialog across.
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const deepSeek = settings.getByText('DeepSeek API', { exact: true }).first()
    await deepSeek.waitFor({ timeout: 10_000 })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    expect(await settings.getByLabel('模型 ID 1').inputValue()).toBe('deepseek-flash')
    expect(await settings.getByLabel('显示名称 1').inputValue()).toBe('DeepSeek-V4.1-Flash')
    expect(await settings.getByLabel('模型 ID 2').inputValue()).toBe('deepseek-v4-pro')
    expect(await settings.getByRole('button', { name: /删除模型/ }).count()).toBe(2)
    await settings.getByRole('button', { name: '模型选项 1' }).click()
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(true)
    await assertModelInputLayout(page, settings)
    const defaultModels = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DEFAULT_MODELS_EXPECTED, defaultModels, MODE)
    await settings.getByLabel('显示名称 1').fill('Configured Flash')
    await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).uncheck()
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByLabel('模型 ID 1').waitFor({ state: 'detached', timeout: 15_000 })
    // The save notice settles the directory refresh before Edit clears it for the next draft.
    await settings.getByText('已保存 DeepSeek API (deepseek-official)。', { exact: true }).waitFor({ timeout: 15_000 })
    const savedDefaults = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(savedDefaults).toContain('id: deepseek-flash')
    expect(savedDefaults).toContain('inputModalities:')
    expect(savedDefaults).toContain('- text')
    expect(savedDefaults).toContain('systemPromptUpdate: in-history')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Configured Flash', inputModalities: ['text'], systemPromptUpdate: 'in-history',
    })
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-pro')).resolves.toMatchObject({
      name: 'DeepSeek-V4-Pro', inputModalities: ['text'],
    })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    for (let index = 0; index < 2; index++) {
      await settings.getByRole('button', { name: /删除模型/ }).first().click()
    }
    await settings.getByRole('button', { name: '添加模型', exact: true }).click()
    const model = settings.locator('[data-row-key]')
    const customModelId = model.getByLabel('模型 ID 1')
    await customModelId.fill('private-preview')
    await model.getByLabel('显示名称 1').fill('Private Preview')
    expect(await settings.getByRole('button', { name: '模型选项 1' }).getAttribute('aria-expanded')).toBe('true')
    await model.getByLabel('上下文窗口 1').fill('131072')
    await model.getByLabel('最大输出 token 数 1').fill('64K')
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(false)
    await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).check()

    await expect.poll(
      () => settings.getByLabel('API 密钥', { exact: true }).getAttribute('placeholder'),
      { timeout: 10_000 },
    ).toBe(`dsh_onboa${'•'.repeat(31)}test`)
    const modelEditor = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MODELS_EXPECTED, modelEditor, MODE)
    await settings.getByRole('button', { name: '保存', exact: true }).click()
    await customModelId.waitFor({ state: 'detached', timeout: 15_000 })
    await settings.getByText('已保存 DeepSeek API (deepseek-official)。', { exact: true }).waitFor({ timeout: 15_000 })

    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('id: private-preview')
    expect(document).toContain('name: Private Preview')
    expect(document).toContain('contextWindow: 131072')
    expect(document).toContain('maxTokens: 64000')
    expect(document).not.toContain('id: deepseek-flash')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'private-preview')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })
    await deepSeek.locator('xpath=ancestor::li').getByRole('button', { name: '编辑' }).click()
    await settings.getByText('自定义设置').click()
    await settings.getByRole('button', { name: '模型选项 1' }).click()
    expect(await settings.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' }).isChecked()).toBe(true)
    await settings.getByRole('button', { name: '取消', exact: true }).click()

    await page.keyboard.press('Escape')
    // A connected Workspace is what puts a live composer — and its model
    // trigger — on the page; the scaffold boots without one.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'model-fallback-e2e', false)

    const modelTrigger = page.getByRole('button', { name: '请选择模型', exact: true })
    await modelTrigger.waitFor({ timeout: 10_000 })
    await modelTrigger.click()
    expect(await page.getByText('Configured Flash', { exact: true }).count()).toBe(0)
    await page.getByRole('menuitemradio', { name: 'Private Preview' }).waitFor({ timeout: 10_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('shows an empty model list after removing the API key without replacing the saved default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-catalog-empty'))
    await page.keyboard.press('Escape')
    const selection = scaffold.ctx.agentDefaultModel.currentSelection()
    await scaffold.ctx.credentials.unset(credentialRef('DEEPSEEK_API_KEY'))
    const seat = page.getByRole('button', { name: '请选择模型', exact: true })
    await seat.waitFor()
    await seat.click()
    const picker = page.getByRole('group', { name: '模型与推理等级' })
    await picker.getByText('暂无可用模型', { exact: true }).waitFor()
    expect(await picker.getByRole('menuitemradio').count()).toBe(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(selection)
    expect(await picker.getByRole('menu', { name: '模型', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'empty.expected.md'), await picker.ariaSnapshot(), MODE)
    await seat.press('Escape')
    await picker.waitFor({ state: 'hidden' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(
      SNAPSHOT_DIR,
      ['start.expected.md', 'missing.expected.md', 'models.expected.md', 'default-models.expected.md', 'empty.expected.md'],
    )
  })
})
