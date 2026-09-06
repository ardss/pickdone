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
