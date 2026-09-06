// 官网在线演示构建:与 vite.config.mjs 同构,仅两处差异——
// base './'(demo 挂官网子路径,资源必须相对引用)+ outDir 直出官网 demo/ 目录
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [
    vue(),
    // 模板里的根绝对静态资源(/assets/...)是 app:// 协议的运行时 URL,保持原样不打包
    // (构建后由 scripts/build-web-demo.mjs 统一改写为相对路径)
    {
      name: 'runtime-app-assets',
      enforce: 'pre',
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
    outDir: path.resolve(__dirname, '../../pickdone-site/demo'),
    emptyOutDir: true,
    sourcemap: false
  }
})
