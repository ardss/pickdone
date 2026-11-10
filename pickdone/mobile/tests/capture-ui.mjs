import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import copy from '../src/i18n/zh-CN.js'

const phase = process.argv[2]
if (!['before', 'after'].includes(phase)) throw new Error('Use before or after')
const output = resolve('verification', phase)
mkdirSync(output, { recursive: true })
const executablePath = [process.env.CHROME_PATH, process.env.PROGRAMFILES && process.env.PROGRAMFILES + '/Google/Chrome/Application/chrome.exe'].find(path => path && existsSync(path))
if (!executablePath) throw new Error('Chromium browser not found')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, colorScheme: 'light' })
  const page = await context.newPage()
  await page.goto(process.env.MOBILE_URL || 'http://127.0.0.1:4180/')
  await page.locator('.bottom-nav').waitFor()
  if (phase === 'after') {
    const basics = await page.evaluate(() => ({ brand: getComputedStyle(document.documentElement).getPropertyValue('--pd-brand').trim(), overflow: document.documentElement.scrollWidth > innerWidth, nav: getComputedStyle(document.querySelector('.bottom-nav')).position, logo: document.querySelector('.brand-mark')?.getAttribute('src') }))
    assert.equal(basics.brand, '#0f9d8f')
    assert.equal(basics.overflow, false)
    assert.equal(basics.nav, 'fixed')
    assert.match(basics.logo, /%230f9d8f/)
    assert.equal(await page.locator('.pd-empty').count(), 1)
  }
  await page.screenshot({ path: resolve(output, 'today-empty.png'), fullPage: true })
  await page.locator('.bottom-nav').getByRole('button', { name: copy.projects }).click()
  await page.screenshot({ path: resolve(output, 'projects-empty.png'), fullPage: true })
  await page.getByRole('button', { name: copy.newProject }).click()
  await page.getByPlaceholder(copy.projectPrompt).fill('Mobile QA Project')
  await page.getByRole('button', { name: copy.save }).click()
  await page.locator('.sheet').waitFor({ state: 'hidden' })
  if (phase === 'after') assert.equal(await page.locator('.pd-project').count(), 1)
  await page.screenshot({ path: resolve(output, 'projects-sample.png'), fullPage: true })
  await page.locator('.bottom-nav').getByRole('button', { name: copy.today }).click()
  await page.getByRole('button', { name: copy.addTask }).click()
  await page.getByPlaceholder(copy.taskPrompt).fill('Mobile QA Task')
  await page.getByRole('combobox').selectOption({ label: 'Mobile QA Project' })
  await page.getByRole('button', { name: copy.save }).click()
  await page.locator('.sheet').waitFor({ state: 'hidden' })
  if (phase === 'after') {
    assert.equal(await page.locator('.pd-task').count(), 1)
    const touch = await page.locator('.check').first().boundingBox()
    assert.ok(touch.width >= 44 && touch.height >= 44)
  }
  await page.screenshot({ path: resolve(output, 'today-sample.png'), fullPage: true })
  await page.getByRole('button', { name: copy.record + 'Mobile QA Task' + copy.recordSuffix }).click()
  await page.getByPlaceholder(copy.episodePrompt).fill('QA episode')
  await page.getByRole('button', { name: copy.save }).click()
  await page.locator('.bottom-nav').getByRole('button', { name: copy.historyShort }).click()
  if (phase === 'after') assert.equal(await page.locator('.pd-episode').count(), 1)
  await page.screenshot({ path: resolve(output, 'history-sample.png'), fullPage: true })
  console.log(`SCREENSHOTS_PASS: ${phase} at 375x812, ${output}`)
} finally {
  await browser.close()
}