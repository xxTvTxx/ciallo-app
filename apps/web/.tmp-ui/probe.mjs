
import { chromium } from 'playwright'
const [url] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'zh-CN' })
await page.goto(url, { waitUntil: 'load' }); await page.waitForTimeout(3000)
await page.setViewportSize({ width: 1680, height: 260 })
await page.getByRole('button', { name: /^选择模型/ }).first().click(); await page.waitForTimeout(500)
const scroller = page.getByRole('menu', { name: '模型', exact: true })
console.log('menus', await scroller.count())
const info = async (tag) => console.log(tag, JSON.stringify(await scroller.evaluate(n => ({ top: n.scrollTop, h: n.clientHeight, sh: n.scrollHeight, stuck: [...n.querySelectorAll('[data-stuck]')].length }))))
await info('open')
await scroller.evaluate(n => { n.scrollTop = 10 }); await page.waitForTimeout(300); await info('scrolled')
const search = page.getByRole('searchbox')
console.log('search', await search.count())
if (await search.count()) { await search.fill('opus'); await page.waitForTimeout(500); await info('filtered') }
await browser.close()
