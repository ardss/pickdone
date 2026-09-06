// Vite 构建层(2026-09-05 工程化定稿):renderer/ 为源码根,产物出 renderer-dist/
// - app:// 协议把 /<path> 映射到仓库根,base='/renderer-dist/' 使产物绝对引用天然命中
// - vendor(Vue/i18n/vuex/router/EP/dayjs 等)仍是 index.html 里的经典脚本挂 window 全局,
//   绝对 app://app URL 对 Vite 是外部资源,原样保留
// - 'vue' 别名到 vue-shim.js:@vitejs/plugin-vue 编译 SFC 产出的 import { x } from 'vue'
//   在运行时落到 window.Vue 的命名桥上
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  root: 'renderer',
  base: '/renderer-dist/',
  plugins: [
    vue(),
    // 模板里的根绝对静态资源(/assets/...)是 app:// 协议的运行时 URL,保持原样不打包
    {
      name: 'runtime-app-assets',
      enforce: 'pre',
      // 模板里的根绝对静态资源(/assets/...)是 app:// 协议的运行时 URL:
      // 编译成虚拟模块 export default '/assets/...',既不落 Rollup external import(会被当模块拉取),
      // 也不复制资源进 dist
      resolveId (id) {
        if (id.startsWith('/assets/')) return '\0app-asset-url:' + id
        return null
      },
      load (id) {
        if (id.startsWith('\0app-asset-url:')) return 'export default ' + JSON.stringify(id.slice('\0app-asset-url:'.length))
        return null
      }
    }
  ],
  resolve: {
    alias: {
      vue: path.resolve(__dirname, 'renderer/js/vue-shim.js'),
      solarlunar: path.resolve(__dirname, 'node_modules/solarlunar/dist/solarlunar.esm.js')
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'renderer-dist'),
    // assetsDir=assets2:2026-09-05 K盘出现坏名目目录 renderer-dist/assets(ACL损坏,重启前删不掉),
    // emptyOutDir 对它 rimraf 整体失败 → 产物子目录换到 assets3 绕开(assets/assets2 两个坏名目并存,正则已通配);清理由 scripts/clean-renderer-dist.mjs 尽力而为
    emptyOutDir: false,
    assetsDir: 'assets3',
    // 明日待办:再评估 code-split 策略;当前单入口+动态 import 分包即可
    sourcemap: false
  }
})
