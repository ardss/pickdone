/** Temporary demo data injection (invoked with --seed-tomato; after verification the whole file can be deleted and its index.js reference removed) */
const log = require('electron-log')

module.exports = function attach (win) {
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const script = [
        '(async function(){',
        '  var recs = []',
        '  var day = 86400000, now = Date.now()',
        "  var pool = ['写周报','阅读','健身','评审需求']",
        '  for (var d = 0; d < 7; d++) {',
        '    var dayMs = now - d*day',
        '    var n = [1,2,3,2,4][Math.floor(Math.random()*5)]',
        '    for (var r = 0; r < n; r++) {',
        '      var end = dayMs - 6*3600000 + r*40*60000 + Math.floor(Math.random()*20)*60000',
        "      var p2=function(n){return (n<10?'0':'')+n}; var dd=new Date(end); var dk = dd.getFullYear()+'-'+p2(dd.getMonth()+1)+'-'+p2(dd.getDate())",
        "      recs.push({ tomatoId: 'seed_'+d+'_'+r, endTime: end, dateKey: dk,",
        "        focus: pool[Math.floor(Math.random()*pool.length)], focusTaskId: null,",
        '        focusDuration: 25, rest: 5, restDuration: 5, succeed: true, status: "local" })',
        '    }',
        '  }',
        '  if (!window.todoAPI || !window.todoAPI.dbCall) return "no-dbCall"',
        "  await window.todoAPI.dbCall('tomatoAppendMany', recs)",  // 行表原子 op,幂等(同 id 不双账);LS blob 不再承载记录
        '  return "seeded:" + recs.length',
        '})()'
      ].join('\n')
      win.webContents.executeJavaScript(script)
        .then(r => log.info('[Seed]', r))
        .catch(e => log.error('[Seed]', e))
    }, 1500)
  })
}
