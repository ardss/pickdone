import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
export default defineConfig({
  plugins: [vue()],
  build: { lib: { entry: resolve('index.js'), name: 'PickDoneUi', formats: ['es'], fileName: 'index' }, rollupOptions: { external: ['vue'] } }
})