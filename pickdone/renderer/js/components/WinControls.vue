<template>

  <div class="ui-titlebar">
    <div class="ui-titletext">
      <div class="ui-title-drag" @dblclick="onDblClick"></div>
    </div>
    <div class="ui-titlecontrols">
      <button class="ui-btn minimize" :title="$t('statsD.WinControls.minimize')" :aria-label="$t('statsD.WinControls.minimize')" @click="minimize">
        <svg viewBox="0 0 10.2 10.2"><path d="M0.6,5.1h9" stroke="var(--text-1, #333)" stroke-width="1" fill="none"/></svg>
      </button>
      <button v-if="!maxed" class="ui-btn maximize" :title="$t('statsD.WinControls.maximize')" :aria-label="$t('statsD.WinControls.maximize')" @click="toggleMax">
        <svg viewBox="0 0 10 10"><path d="M0,0v10h10V0H0z M9,9H1V1h8V9z"/></svg>
      </button>
      <button v-else class="ui-btn maximize" :title="$t('statsD.WinControls.restore')" :aria-label="$t('statsD.WinControls.restore')" @click="toggleMax">
        <svg viewBox="0 0 10.2 10.1"><path d="M2.1,0v2H0v8.1h8.2v-2h2V0H2.1z M7.2,9.2H1.1V3h6.1V9.2z M9.2,7.1h-1V2H3.1V1h6.1V7.1z"/></svg>
      </button>
      <button class="ui-btn close" :title="$t('statsD.WinControls.close')" :aria-label="$t('statsD.WinControls.close')" @click="close">
        <svg viewBox="0 0 10 10"><polygon points="10.2,0.7 9.5,0 5.1,4.4 0.7,0 0,0.7 4.4,5.1 0,9.5 0.7,10.2 5.1,5.8 9.5,10.2 10.2,9.5 5.8,5.1"/></svg>
      </button>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Custom-drawn title bar controls (implemented item by item, referencing ui-titlebar / ui-titlecontrols)
 * Position: fixed at the window's top-right, 25px tall; double-click the drag area to maximize; the three button SVG paths come from the project baseline
 * Reference CSS: .ui-btn 38x25 / hover rgba(0,0,0,.1) / close hover #e81123 white icon / svg fill #333
 */
export default {
  name: 'WinControls',
  data () { return { maxed: false } },
  methods: {
    minimize () { window.todoAPI.minimize() },
    async toggleMax () {
      await window.todoAPI.maximize()
      window.todoAPI.isMaximized().then(v => { this.maxed = !!v }).catch(() => {})
    },
    close () { window.todoAPI.closeRequest() },
    onDblClick () { this.toggleMax() }
  },
  mounted () {
    window.todoAPI.isMaximized().then(v => { this.maxed = !!v }).catch(() => {})
    this._onMax = () => window.todoAPI.isMaximized().then(v => { this.maxed = !!v })
    window.addEventListener('resize', this._onMax)
  },
  beforeUnmount () { window.removeEventListener('resize', this._onMax) },

}
</script>
<style>/* ============ 无边框窗口自绘标题栏（设计稿 ui-titlebar/ui-titlecontrols） ============ */
.ui-titlebar {
  position: fixed; top: 0; right: 0; left: 0; z-index: var(--z-titlebar);
  display: flex; height: 25px; cursor: pointer;

}
.ui-titletext { position: relative; flex: 1; color: #fff; font: 12px/20px "Segoe UI", Arial, sans-serif; text-indent: 10px; }
.ui-title-drag { position: absolute; top: 2px; right: 0; bottom: 0; left: 4px; -webkit-app-region: drag; }
.ui-titlecontrols { display: flex; flex-shrink: 0; -webkit-app-region: no-drag; }
.ui-btn {
  width: 38px; height: 25px; margin: 0; padding: 0; background: transparent;
  border: 0; outline: 0; display: flex; align-items: center; justify-content: center;
}
/* 用户反馈原 10px 过小，放大到 13px（viewBox 等比缩放，笔画同步加粗） */
.ui-btn svg { width: 13px; height: 13px; }
/* 跟随主题变量：深色模式下标题栏常悬浮在深色表面上，固定 #333 会不可见 */
.ui-btn svg path, .ui-btn svg polygon, .ui-btn svg rect { fill: var(--text-1, #333); }
/* 最小化为直线描边（fill 画不出零面积直线的轮廓），跟随主题色 */
.ui-btn svg path[stroke] { fill: none; stroke: var(--text-1, #333); }
.ui-btn:hover { background: rgba(0,0,0,.1); }
/* 窗口镶边按钮不参与键盘焦点指示：启动时初始焦点常落在最小化钮上，全局 focus-visible 圈会在标题栏凭空亮一个框 */
.ui-btn:focus-visible { outline: none; }
.ui-btn.close:hover { background: #e81123; }
.ui-btn.close:hover svg path, .ui-btn.close:hover svg polygon, .ui-btn.close:hover svg rect { fill: #fff; }
</style>
