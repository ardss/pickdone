import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:60])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)

# 1. att-missing-guard: only open-file stays; the two removed channels asserted absent
patch('tests/unit/main/att-missing-guard.test.mjs', [(
"""    // absent file: structured missing result on all three channels
    for (const [ch, args] of [['open-file', [url.replace('present', 'absent')]], ['download-file-and-open', [url.replace('present', 'absent')]], ['save-upload-file-to-download', [url.replace('present', 'absent'), 'a.png']]]) {
      const r = await h[ch]({}, ...args)
      assert.ok(r && r.missing === true, ch + ' must report missing')
      assert.equal(r.name, 'absent.png')
    }""",
"""    // absent file: structured missing result (r3 2026-09-28: download-file-and-open /
    // save-upload-file-to-download are DELETED dead channels — only open-file remains)
    const r = await h['open-file']({}, url.replace('present', 'absent'))
    assert.ok(r && r.missing === true, 'open-file must report missing')
    assert.equal(r.name, 'absent.png')
    assert.equal('download-file-and-open' in h, false, 'dead channel must stay deleted')
    assert.equal('save-upload-file-to-download' in h, false, 'dead channel must stay deleted')""")])

# 2. f2: drop download-file-and-open from the loop + trailing assert
patch('tests/unit/main/f2-round-fixes-20260915.test.mjs', [(
"""test('F4: open-file / download-file-and-open / delete-file 对非字符串 url 返回 false 而非抛 TypeError', async () => {
  const { h, e, restore } = loadAttachmentHandlers()
  try {
    for (const bad of [undefined, null, 42, {}]) {
      assert.equal(await h['open-file']({}, bad), false, 'open-file url=' + String(bad))
      assert.equal(h['download-file-and-open']({}, bad), false, 'download-file-and-open url=' + String(bad))
      assert.equal(h['delete-file'](e, bad), false, 'delete-file url=' + String(bad))
    }
    // 合法外链不受影响
    assert.equal(await h['download-file-and-open']({}, 'https://example.com/a.png'), true)
  } finally { restore() }
})""",
"""test('F4: open-file / delete-file 对非字符串 url 返回 false 而非抛 TypeError (r3: download-file-and-open 已删除)', async () => {
  const { h, e, restore } = loadAttachmentHandlers()
  try {
    for (const bad of [undefined, null, 42, {}]) {
      assert.equal(await h['open-file']({}, bad), false, 'open-file url=' + String(bad))
      assert.equal(h['delete-file'](e, bad), false, 'delete-file url=' + String(bad))
    }
    // r3 2026-09-28: 死通道 download-file-and-open 三端删除,handler 不再注册
    assert.equal('download-file-and-open' in h, false, 'dead channel must stay deleted')
  } finally { restore() }
})""")])

# 3. f6: locked test + unknown-scheme test
patch('tests/unit/main/f6-round6-fixes.test.mjs', [(
"""test('attachment handlers: open-file / download-file-and-open / save-upload-file-to-download all refuse while locked', () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => true, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.rejects(() => h['open-file']({}, 'local://a.png'), /locked/)
  assert.throws(() => h['download-file-and-open']({}, 'local://a.png'), /locked/)
  assert.throws(() => h['save-upload-file-to-download']({}, 'local://a.png', 'a.png'), /locked/)
})
test('download-file-and-open: returns false for unknown schemes instead of a blanket true', async () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => false, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.equal(h['download-file-and-open']({}, 'javascript:alert(1)'), false)
  assert.equal(await h['open-file']({}, 'weird://x'), false)
})""",
"""test('attachment handlers: open-file refuses while locked (r3: download/save-to-download dead channels deleted)', () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => true, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.rejects(() => h['open-file']({}, 'local://a.png'), /locked/)
  assert.equal('download-file-and-open' in h, false, 'dead channel must stay deleted')
  assert.equal('save-upload-file-to-download' in h, false, 'dead channel must stay deleted')
})
test('open-file: returns false for unknown schemes instead of a blanket true', async () => {
  const mod = loadAttachmentHandlers()
  const h = mod({ isLocked: () => false, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {} })
  assert.equal(await h['open-file']({}, 'weird://x'), false)
})""")])
print('part1 ok')
