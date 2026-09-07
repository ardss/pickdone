/**
 * 共享 CSS 源收集器(2026-09-07 反模式审查收敛:此前 token 门禁/hover 门禁/structure 测试各自
 * 手写 .vue <style> 提取,行为分叉——行扫描版遇 </style> 同行即错,regex 版不识注释)。
 * 唯一实现:全局 assets/css 两件 + renderer/js 全部 .vue 的 <style> 块(非 scoped 契约由 structure 测试把守)。
 * 用法(CJS): const { cssSources } = require('./lib/css-sources.cjs')
 *   cssSources() -> [{ rel, css }]  // css 为该文件全部样式 CSS 的拼接(全局文件原样)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')

function collectVueFiles (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectVueFiles(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

function cssSources () {
  const out = ['base.css', 'theme-dark.css'].map(f => {
    const p = path.join(ROOT, 'assets', 'css', f)
    return { rel: path.join('assets', 'css', f), css: fs.readFileSync(p, 'utf8') }
  })
  for (const vp of collectVueFiles(path.join(ROOT, 'renderer', 'js'))) {
    const src = fs.readFileSync(vp, 'utf8')
    const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
    if (css.trim()) out.push({ rel: path.relative(ROOT, vp), css })
  }
  return out
}

module.exports = { cssSources, collectVueFiles, ROOT }
