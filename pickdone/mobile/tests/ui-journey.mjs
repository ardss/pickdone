import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const candidatePaths = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && process.env.PROGRAMFILES + '/Google/Chrome/Application/chrome.exe',
  process.env['PROGRAMFILES(X86)'] && process.env['PROGRAMFILES(X86)'] + '/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const executablePath = candidatePaths.find(existsSync)
if (!executablePath) throw new Error('Set CHROME_PATH to an installed Chromium browser')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(process.env.MOBILE_URL || 'http://127.0.0.1:4173/')
  await page.getByRole('button', { name: /项目/ }).last().click()
  await page.getByRole('button', { name: /新建项目/ }).click()
  await page.getByPlaceholder('比如：新产品发布').fill('Mobile QA Project')
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByText('Mobile QA Project').waitFor()
  await page.getByRole('button', { name: '今天' }).click()
  await page.getByRole('button', { name: /添加任务/ }).click()
  await page.getByPlaceholder('现在要做什么？').fill('Mobile QA Task')
  await page.getByRole('combobox').selectOption({ label: 'Mobile QA Project' })
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByText('Mobile QA Task').waitFor()
  await page.reload()
  await page.getByText('Mobile QA Task').waitFor()
  await page.getByText('Mobile QA Task').click()
  await page.getByPlaceholder('现在要做什么？').fill('Mobile QA Task Edited')
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByRole('button', { name: /记录 Mobile QA Task Edited 的工作历程/ }).click()
  await page.getByPlaceholder('写下这段工作的成果（可选）').fill('QA episode')
  await page.getByRole('button', { name: '保存' }).click()
  await page.getByRole('button', { name: '完成 Mobile QA Task Edited' }).click()
  await page.getByRole('button', { name: '恢复 Mobile QA Task Edited' }).waitFor()
  await page.reload()
  await page.getByText('Mobile QA Task Edited').waitFor()
  await page.locator('.bottom-nav').getByRole('button', { name: '历程' }).click()
  await page.getByText('QA episode').waitFor()
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open('pickdone-mobile-v1')
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = db.transaction(['todos', 'categories', 'work_episodes'], 'readonly')
    const fetchAll = name => new Promise((resolve, reject) => {
      const operation = transaction.objectStore(name).getAll()
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    return { tasks: await fetchAll('todos'), projects: await fetchAll('categories'), episodes: await fetchAll('work_episodes') }
  })
  assert.equal(stored.tasks.find(task => task.content === 'Mobile QA Task Edited')?.complete, 1)
  assert.equal(stored.projects.find(project => project.name === 'Mobile QA Project')?.id, stored.tasks[0].categoryId)
  assert.equal(stored.episodes.find(episode => episode.note === 'QA episode')?.taskId, stored.tasks[0].id)
  console.log('UI_JOURNEY_PASS: create project/task, reload, edit, add episode, complete, reload and inspect IndexedDB')
} finally {
  await browser.close()
}