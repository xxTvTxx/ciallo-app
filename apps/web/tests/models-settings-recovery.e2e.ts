/** Provider creation and catalog recovery through the assembled Models settings page. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/models-settings-recovery/stored-error.expected.md', import.meta.url))
const FAILURE = 'llm-pi-ai: provider "openrouter" model "111" needs an api; '
  + 'the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'
const CUSTOM_FAILURE = 'llm-pi-ai: provider "acme-gateway" model "custom-model" needs an api; '
  + 'the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'

describe('web e2e: model provider settings', () => {
  let home: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-models-recovery-'))
    await mkdir(join(home, 'profiles', 'scaffold'), { recursive: true })
    await writeFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), [
      '- id: llm-pi-ai', '  config:', '    providers:', '      openrouter:', '        models:',
      '          - id: "111"', '      zai: {}', '      acme-gateway:',
      '        baseURL: https://gateway.example/v1', '        models:', '          - id: "custom-model"', '',
    ].join('\n'))
    scaffold = await launchWebScaffold({ harnessHome: home })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText(FAILURE, { exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (home !== undefined) await rm(home, { recursive: true, force: true })
      }
    }
  })

  it('shows the failed provider beside healthy providers and keeps the add action usable', async () => {
    onTestFailed(() => saveFailureShot(page, 'models-settings-recovery'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    expect(await dialog.getByRole('button', { name: '编辑 openrouter', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '编辑 zai', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '编辑 acme-gateway', exact: true }).count()).toBe(1)
    expect(await dialog.getByText(CUSTOM_FAILURE, { exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())

    await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
    // Both modes stay offered beside a failed route: the card opens on the
    // third-party mode with the custom-API segment enabled.
    expect(await dialog.getByRole('tab', { name: '自定义模型 API' }).isEnabled()).toBe(true)
    await dialog.getByLabel('提供商', { exact: true }).selectOption('minimax-cn')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 minimax-cn。', { exact: true }).waitFor()
    expect(await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain('minimax-cn: {}')
    expect(await dialog.getByText(FAILURE, { exact: true }).count()).toBe(1)
  })

  it('rejects an invalid edit without persisting and accepts removal of the obsolete model', async () => {
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '编辑 openrouter', exact: true }).click()
    await dialog.getByText('自定义设置', { exact: true }).click()
    await dialog.getByLabel('API 地址', { exact: true }).fill('https://gateway.example/v1')
    const before = await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => dialog.getByText(FAILURE, { exact: true }).count()).toBe(2)
    expect(await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toBe(before)
    await dialog.getByRole('button', { name: '删除模型 1', exact: true }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 openrouter。', { exact: true }).waitFor()
    expect(await dialog.getByText(FAILURE, { exact: true }).count()).toBe(0)
    const repaired = await readFile(join(home, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(repaired).not.toContain('111')
    expect(repaired).toContain('baseURL: https://gateway.example/v1')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('adds a CialloAPI group from a pasted key at a changed gateway address', async () => {
    onTestFailed(() => saveFailureShot(page, 'models-settings-cialloapi'))
    const dialog = page.getByRole('dialog', { name: '设置' })
    const patch = join(home, 'profiles', 'scaffold', 'cordis.patch.yml')
    const before = await readFile(patch, 'utf8')
    const server = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/tenant/v1/models') {
        response.writeHead(404).end()
      } else if (request.headers.authorization !== 'Bearer fixture-key') {
        response.writeHead(401).end()
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          object: 'list', data: [{ id: 'example-model' }, { id: 'other-model' }],
        }))
      }
    })
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Expected a TCP test address')
      const baseURL = `http://127.0.0.1:${String(address.port)}/tenant`
      const card = dialog.getByRole('region', { name: 'CialloAPI', exact: true })
      // The third-party picker no longer offers CialloAPI; its card is always on the page.
      await dialog.getByRole('button', { name: '添加模型提供商', exact: true }).click()
      const picker = dialog.getByRole('tabpanel', { name: '第三方模型提供商' })
      expect(await picker.getByRole('option', { name: 'CialloAPI' }).count()).toBe(0)
      await picker.getByRole('button', { name: '取消', exact: true }).click()
      expect(await card.getByText('https://cialloapi.com', { exact: true }).count()).toBe(1)
      await card.getByRole('button', { name: '修改地址', exact: true }).click()
      await card.getByLabel('API 地址', { exact: true }).fill(baseURL)
      await card.getByRole('button', { name: '保存', exact: true }).click()
      await card.getByText(baseURL, { exact: true }).waitFor()
      await card.getByRole('button', { name: '添加分组（粘贴另一个分组的 API Key）', exact: true }).click()
      await card.getByLabel('API 密钥', { exact: true }).fill('fixture-key')
      await card.getByText('已识别：混合 分组', { exact: true }).waitFor()
      await card.getByRole('checkbox', { name: 'other-model' }).uncheck()
      expect(await card.getByLabel('上下文窗口 example-model', { exact: true }).isVisible()).toBe(true)
      expect(await readFile(patch, 'utf8')).toBe(before)

      await card.getByRole('button', { name: '保存', exact: true }).click()
      await dialog.getByText('已保存 CialloAPI · 混合 (cialloapi)。', { exact: true }).waitFor()
      const saved = await readFile(patch, 'utf8')
      expect(saved).toContain('cialloapi:')
      expect(saved).toContain('displayName: CialloAPI · 混合')
      expect(saved).toContain('api: openai-responses')
      expect(saved).toContain(`baseURL: ${baseURL}/v1`)
      expect(saved).toContain('id: example-model')
      expect(saved).toContain('apiKeyEnv: CIALLOAPI_API_KEY')
      expect(saved).not.toContain('other-model')
      expect(saved).not.toContain('fixture-key')
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})

it('starts a clean profile from one CialloAPI key and edits each Claude model default', async () => {
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  let browser: Browser | undefined
  const modelIds = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
  const realFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (href !== 'https://cialloapi.com/v1/models' && href !== 'https://cialloapi.com/v1/models?client_version=0.158.0') {
      return await realFetch(input, init)
    }
    if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-key') return new Response(null, { status: 401 })
    if (href.includes('?')) return Response.json({
      models: modelIds.map((slug, index) => ({
        slug, context_window: 1_000_000,
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })),
        default_reasoning_level: index === 1 ? 'high' : 'medium',
      })),
    })
    return Response.json({ data: modelIds.map(id => ({ id })) })
  })
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'cialloapi-clean-profile'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const start = page.getByRole('dialog', { name: '开始使用 Ciallo', exact: true })
    await start.getByLabel('API 密钥', { exact: true }).fill('fixture-key')
    await start.getByText('已识别 Claude 分组 · 3 个模型 · 默认 claude-opus-5-5', { exact: true }).waitFor()
    await start.getByRole('button', { name: '开始使用', exact: true }).click()
    await start.waitFor({ state: 'detached' })
    const patch = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    const started = await readFile(patch, 'utf8')
    expect(started).toContain('api: anthropic-messages')
    expect(started).toContain('sessionAffinity: true')
    // The unavailable DeepSeek default moved to the new group's preferred model.
    expect(started).toMatch(/id: agent-default-model\n(?:\s+name: .*\n)?\s+config:\n\s+provider: cialloapi\n\s+model: claude-opus-5-5/)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('button', { name: '模型', exact: true }).click()
    const card = settings.getByRole('region', { name: 'CialloAPI', exact: true })
    await card.getByText('缓存 5 分钟 · 会话粘性 开', { exact: true }).waitFor()
    await card.getByRole('button', { name: '编辑 CialloAPI · Claude', exact: true }).click()
    for (const model of modelIds) {
      expect(await card.getByLabel(`上下文窗口 ${model}`, { exact: true }).inputValue()).toBe('1M')
      expect(await card.getByLabel(`默认推理档位 ${model}`, { exact: true }).isEnabled()).toBe(true)
    }
    expect(await card.getByLabel('默认推理档位 claude-opus-5-5', { exact: true }).inputValue()).toBe('medium')
    expect(await card.getByLabel('默认推理档位 claude-sonnet-5-5', { exact: true }).inputValue()).toBe('high')
    expect(await card.getByLabel('默认推理档位 claude-haiku-5-5', { exact: true }).inputValue()).toBe('medium')
    await card.getByLabel('默认推理档位 claude-sonnet-5-5', { exact: true }).selectOption('low')
    await card.getByLabel('默认推理档位 claude-haiku-5-5', { exact: true }).selectOption('xhigh')
    await card.getByRole('tab', { name: '1 小时', exact: true }).click()
    await card.getByRole('button', { name: '保存', exact: true }).click()
    await settings.getByText('已保存 CialloAPI · Claude (cialloapi)。', { exact: true }).waitFor()
    const saved = await readFile(patch, 'utf8')
    expect(saved).toContain('cacheRetention: long')
    const savedDefaults = [...saved.matchAll(/defaultReasoningEffort: (\w+)/g)].map(match => match[1])
    expect(savedDefaults).toEqual(['medium', 'low', 'xhigh'])
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'cialloapi-preview')
    const trigger = page.getByRole('button', { name: /^(选择模型|请选择模型)/ }).first()
    const checkedEffort = page.locator('[data-model-chip="effort"][aria-checked="true"]')
    const checkedCache = page.locator('[data-model-chip="cache"][aria-checked="true"]')
    const defaults = { 'claude-sonnet-5-5': 'Low', 'claude-haiku-5-5': 'Xhigh' }
    // The route's one-hour cache default marks the trigger.
    await expect.poll(async () => await trigger.getAttribute('aria-label'))
      .toMatch(/claude-opus-5-5，推理等级 Medium，缓存时长 1 小时$/)
    // Opening expands the current model with the Session's effort and cache duration.
    await trigger.click()
    await expect.poll(async () => await checkedEffort.allInnerTexts()).toEqual(['Medium'])
    expect(await checkedCache.allInnerTexts()).toEqual(['1 小时'])
    // Another model expands with its own default effort, without selecting it.
    for (const [model, effort] of Object.entries(defaults)) {
      await page.getByRole('menuitemradio', { name: model, exact: true }).click()
      await expect.poll(async () => await checkedEffort.allInnerTexts()).toEqual([effort])
    }
    await page.keyboard.press('Escape')
    await expect.poll(async () => await trigger.getAttribute('aria-label'))
      .toMatch(/claude-opus-5-5，推理等级 Medium，缓存时长 1 小时$/)
    // A session-only effort change selects the model but leaves every model default in the profile.
    await trigger.click()
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).waitFor({ state: 'detached' })
    await expect.poll(async () => await trigger.getAttribute('aria-label')).toMatch(/claude-opus-5-5，推理等级 High，缓存时长 1 小时$/)
    await trigger.click()
    await expect.poll(async () => await checkedEffort.allInnerTexts()).toEqual(['High'])
    // A Session cache choice keeps the menu open and drops the one-hour mark.
    await page.getByRole('menuitemradio', { name: '5 分钟', exact: true }).click()
    await expect.poll(async () => await checkedCache.allInnerTexts()).toEqual(['5 分钟'])
    await expect.poll(async () => await trigger.getAttribute('aria-label')).toMatch(/claude-opus-5-5，推理等级 High$/)
    await page.getByRole('menuitemradio', { name: '1 小时', exact: true }).click()
    await expect.poll(async () => await checkedCache.allInnerTexts()).toEqual(['1 小时'])
    await page.getByRole('menuitemradio', { name: 'claude-haiku-5-5', exact: true }).click()
    await expect.poll(async () => await checkedEffort.allInnerTexts()).toEqual(['Xhigh'])
    await page.keyboard.press('Escape')
    const after = await readFile(patch, 'utf8')
    expect([...after.matchAll(/defaultReasoningEffort: (\w+)/g)].map(match => match[1])).toEqual(savedDefaults)
  } finally {
    fetch.mockRestore()
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
