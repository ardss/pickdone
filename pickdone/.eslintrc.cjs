/** ESLint 配置 —— SFC+Vite+TS 工程形态(2026-09-05 迁移):
 *  - .vue 由 vue-eslint-parser + @typescript-eslint/parser 接管(override),模板规则来自 plugin:vue/vue3-essential
 *  - node 环境文件(src/main、cli、tests)单独放开 require/process/console
 */
module.exports = {
  root: true,
  env: { es2022: true, browser: true },
  plugins: ['vue'],
  parser: 'vue-eslint-parser',
  parserOptions: { parser: '@typescript-eslint/parser', ecmaVersion: 2022, sourceType: 'module', extraFileExtensions: ['.vue'] },
  extends: ['eslint:recommended', 'plugin:vue/vue3-essential'],
  rules: {
    // 项目约定
    'no-console': 'off',
    'eqeqeq': ['error', 'smart'],
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    'no-var': 'error',
    'object-shorthand': ['error', 'always'],
    // 防御性 try{}catch{} 是既定惯例（IPC/窗口操作大量使用），允许空 catch 但禁止空普通块
    'no-empty': ['error', { allowEmptyCatch: true }],
    // 历史事故对应：模板引用不存在的方法（no-undef 查 JS 层）；排查过的误报按文件关
    'no-undef': 'error',
    // 严格档：死代码一律 error（曾藏住「引用已删除的 action」类事故）
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-throw-literal': 'error',
    'no-return-assign': ['error', 'always'],
    'no-loop-func': 'error',
    'no-proto': 'error',
    'no-iterator': 'error',
    'no-template-curly-in-string': 'warn',
    'no-implicit-coercion': ['error', { allow: ['!!', '+'] }]
  },
  overrides: [
    {
      // 弹窗显隐由父层 v-if 驱动,transition 实际不参与进入/离场动画
      files: ['renderer/js/components/FeedbackModal.vue'],
      rules: { 'vue/require-toggle-inside-transition': 'off' }
    },
    {
      // Node 侧代码
      files: ['src/main/**/*.js', 'src/preload/**/*.js', 'cli/**/*.js', 'tests/**/*.mjs', '*.cjs', '.eslintrc.cjs'],
      env: { node: true, browser: false, es2022: true },
      parserOptions: { ecmaVersion: 2022 },
      globals: {
        // Electron 主进程全局
        Notification: 'readonly',
        // Node 22 全局 WebSocket（CDP 冒烟脚本）
        WebSocket: 'readonly'
      }
    },
    {
      // CDP/WS 协议需要 onmessage=... 闭包内捕获 pending Map；while(true) 是 watch 循环——协议本身有意的模式
      files: ['cli/**/*.js', 'tests/**/*.mjs'],
      rules: { 'no-loop-func': 'off', 'no-constant-condition': 'off', 'no-return-assign': 'off' }
    },
    {
      // CLI/主进程里确有 CJS 写法的文件按需在此放宽
      files: ['cli/lib.js'],
      parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
      env: { node: true }
    }
  ],
  ignorePatterns: ['node_modules/', 'vendor/', 'assets/vendor-lib/', 'browser-dev/', 'dist/', 'renderer-dist/']
}
