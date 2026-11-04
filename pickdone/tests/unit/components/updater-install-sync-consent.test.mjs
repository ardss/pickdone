import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8')

test('updates must never install as a side effect of ordinary quit', () => {
  const updater=read('src/main/updater.js')
  const main=read('src/main/index.js')
  assert.match(updater, /autoUpdater\.autoInstallOnAppQuit = false/)
  assert.match(updater, /function quitAndInstall \(\) \{/)
  assert.doesNotMatch(main, /updater\.getStatus\(\)\.status === 'ready' && updater\.quitAndInstall\(\)/)
  assert.match(main, /Ordinary quit does not authorize installing/)
})
test('global update prompt offers actionable review of new version in Settings', () => {
  const main=read('renderer/js/main.js')
  const helper=read('renderer/js/utils/updaterNotice.js')
  assert.match(main, /createUpdateChoiceToast\(/)
  assert.match(main, /store\.commit\('ui\/openSettingsAt', 'about'\)/)
  assert.match(helper, /h\('button'/)
  assert.match(helper, /onClick: openSettings/)
  assert.match(main, /showUpdateChoice\('info'/)
  assert.match(main, /showUpdateChoice\('success'/)
})
test('sync peer status provides actual versions from authenticated handshake', () => {
  const transport=read('src/main/lan-sync/transport.js')
  const engine=read('src/main/lan-sync/index.js')
  const tab=read('renderer/js/components/settings/SettingsSyncTab.vue')
  const modal=read('renderer/js/components/SettingsModal.vue')
  assert.match(transport, /appVersion:.*ownAppVersion\(\)/)
  assert.match(engine, /peerAppVersions\.set\(peer\.deviceId, peer\.appVersion\)/)
  assert.match(engine, /appVersion: peerAppVersions\.get\(p\.deviceId\)/)
  assert.match(tab, /p\.appVersion !== selfInfo\.appVersion/)
  assert.match(tab, /\$emit\('open-updates'\)/)
  assert.match(modal, /@open-updates="tab='about'"/)
})
test('an unpublished test build is reported as a missing update feed instead of a generic loop', () => {
  const modal=read('renderer/js/components/SettingsModal.vue')
  const updater=read('src/main/updater.js')
  const locales=['zh-CN-N.js','en-US-N.js'].map(x=>read('renderer/js/i18n/locales/'+x))
  assert.match(updater, /FEED_MISSING/)
  assert.match(modal, /lastCheckError\.kind === 'FEED_MISSING'/)
  assert.match(modal, /update\.feedMissing/)
  for(const locale of locales){assert.match(locale,/feedMissing:/);assert.match(locale,/viewUpdate:/)}
})
