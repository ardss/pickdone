/** afterPack: 把 package.json 以真实文件落到 <appOutDir>/resources/ 根
 *  背景:打包后的 CLI(resources/cli)以系统 node 运行,读不到 asar 内的 package.json,
 *  需要 resources/package.json 真实文件定位版本/依赖。不能用 extraResources 实现——
 *  `from: package.json` 会让 electron-builder 把根 package.json 从 app.asar 里挤掉(2026-09-03 实锤,
 *  打包直接报 "package.json in app.asar does not exist")。 */
const path = require('path')
const fs = require('fs')

module.exports = async function afterPack (context) {
  const src = path.join(__dirname, '..', 'package.json')
  const dest = path.join(context.appOutDir, 'resources', 'package.json')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}
