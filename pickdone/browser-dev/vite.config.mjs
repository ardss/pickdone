import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import sirv from 'sirv'
import { readFile } from 'node:fs/promises'
import { join, dirname, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(HERE, '..')

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml'
}

/**
 * Electron 渲染层在浏览器中运行的适配层：
 * - renderer/js 不拦截 → 走 Vite 模块图（import 分析 + HMR），app://app/ 前缀由 transform 钩子去除
 * - /assets、/node_modules 位于 root 之外且含 vendor UMD / 写死的 app://app/ 引用：
 *   文本资源做内容重写，其余二进制交给 sirv（标准静态服务：MIME/遍历防护）
 */
function todoBrowserDev() {
  const sirvOpts = { dev: true, etag: false }
  const ASSETS_DIR = join(APP_ROOT, 'assets')

  // 仅作用于 /assets 的文本资源重写（必须先于 Vite 内部中间件，
  // 否则 <link> 的 CSS 会被 Vite 包装成 JS 模块）
  const assetsText = async (req, res, next) => {
    const url = (req.url || '').split('?')[0]
    if (!/^\/assets\/.+\.(css|js|mjs|html)$/.test(url)) return next()
    const file = join(ASSETS_DIR, decodeURIComponent(url.slice('/assets/'.length)))
    if (!file.startsWith(ASSETS_DIR + sep)) return next() // 防路径穿越
    try {
      let text = (await readFile(file)).toString('utf8')
      if (text.includes('app://app/')) text = text.split('app://app/').join('/')
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || MIME['.js'], 'Cache-Control': 'no-store' })
      res.end(text)
    } catch {
      res.statusCode = 404
      res.end('not found: ' + url)
    }
  }

  return {
    name: 'todo-browser-dev',
    transform(code, id) {
      if (id.replace(/\\/g, '/').includes('/renderer/') && code.includes('app://app/')) {
        return code.split('app://app/').join('/')
      }
      return null
    },
    configureServer(server) {
      // 调试首页：browser-dev/index.html 经 transformIndexHtml 注入 Vite HMR 客户端；
      // float-layout-lab.html = 浮窗布局实验室（纯静态，无需 HMR 注入）
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (url !== '/' && url !== '/index.html' && !url.startsWith('/float-')) return next()
        const name = url === '/' || url === '/index.html' ? 'index.html' : url.slice(1)
        const known = ['index.html', 'float-layout-lab.html', 'float-tide-lab.html', 'float-border-lab.html', 'float-knob-lab.html', 'float-final-lab.html']
        if (!known.includes(name)) return next()
        const html = await readFile(join(HERE, name), 'utf8')
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
        res.end(name === 'index.html' ? await server.transformIndexHtml(url, html) : html)
      })
      // 前置：拦截 /assets 与 /node_modules，其余（renderer/**）放行给 Vite
      server.middlewares.use(assetsText)
      server.middlewares.use('/assets', sirv(ASSETS_DIR, sirvOpts))
      server.middlewares.use('/node_modules', sirv(join(APP_ROOT, 'node_modules'), sirvOpts))
    }
  }
}

export default defineConfig({
  root: APP_ROOT,
  resolve: {
    alias: [
      // 与主工程同构:'vue' 别名到 window.Vue 命名桥,避免 Vite 解析到 node_modules/vue(full ESM)造成双 Vue 实例
      { find: /^vue$/, replacement: join(APP_ROOT, 'renderer/js/vue-shim.js') },
      // 历史遗留：renderer 内曾按 URL 语义写 '../../assets/...'（正确为 '../../../assets/...'，
      // 2026-08-28 已改），alias 保留兼容以防旧引用回归
      {
        find: '../../assets/vendor-lib/js-calendar-converter.mjs',
        replacement: join(APP_ROOT, 'assets/vendor-lib/js-calendar-converter.mjs')
      }
    ]
  },
  optimizeDeps: {
    // 只扫描调试首页；忽略 Electron 的 renderer/index.html（app:// 协议路径会导致扫描失败）
    entries: ['browser-dev/index.html']
  },
  server: {
    port: 5175,
    host: true,
    // HMR 必须关:renderer 走 vendor runtime-only Vue(无 __VUE_HMR_RUNTIME__),SFC 的 hot 边界代码
    // 一旦被触发(编辑文件后)就整页 ReferenceError 白屏(2026-09-06 两次实锤);hmr:false 时 Vite 改走整页刷新
    hmr: false,
    fs: { allow: [APP_ROOT] }
  },
  plugins: [
    todoBrowserDev(),
    // SFC 迁移(2026-09-05)后 renderer/js 含 .vue 与 import 'vue'(vue-shim 桥)——与主工程 vite.config 保持同构
    // transformAssetUrls:false —— /assets 由 sirv 前置直服,plugin-vue 把 <img src> 编译成 ?import 模块请求会
    // 拿到 image/svg+xml 触发 Strict MIME 白屏(2026-09-05);关掉后 src 保持纯 URL,与生产 app:// 语义一致
    vue({ template: { transformAssetUrls: false } })
  ],
})
