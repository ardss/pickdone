import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('about page distinguishes available LAN sync from cross-network work in both languages', async () => {
  const zh = (await import('../../../renderer/js/i18n/locales/zh-CN-E.js')).default.statsE.SettingsModal
  const en = (await import('../../../renderer/js/i18n/locales/en-US-E.js')).default.statsE.SettingsModal
  assert.equal(zh.syncSurveyLabel, '多设备同步')
  assert.equal(en.syncSurveyLabel, 'Multi-device sync')
  assert.match(zh.syncSurveyTip, /局域网.*同步已可使用/)
  assert.match(zh.syncSurveyTip, /跨网络同步.*仍在完善/)
  assert.match(en.syncSurveyTip, /Local-network device sync is available/)
  assert.match(en.syncSurveyTip, /cross-network sync.*still being improved/)
  assert.equal(zh.syncManageBtn, '管理已配对设备')
  assert.ok(en.syncManageBtn)
  assert.match(zh.aboutPrivacy, /已配对的设备/)
  assert.match(en.aboutPrivacy, /paired devices/)
  assert.doesNotMatch(zh.aboutPrivacy, /不上传任何内容/)
})

test('about page opens the working Sync settings tab, not a historical planning survey', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  assert.match(src, /<settings-sync-tab v-if="tab==='sync' \|\| searching"/)
  assert.match(src, /@click="openSyncSettings">\{\{ \$t\('statsE\.SettingsModal\.syncManageBtn'\) \}\}/)
  assert.match(src, /openSyncSettings \(\) \{ this\.clearSearch\(\); this\.tab = 'sync' \}/)
  assert.doesNotMatch(src, /openSyncSurvey \(\)/)
})
