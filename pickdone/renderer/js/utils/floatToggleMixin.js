/** Desktop-float switch mixin — the SETTING records intent, the WINDOW is the truth.
 *
 *  The switch used to render `st.enableTomatoFloating`, so a float closed from the tray (or by its
 *  own ✕) still read "on", and the next click hid an already-hidden window — the first reopen click
 *  was swallowed. It now mirrors `tomato-float-shown` (the main process's real visibility) and
 *  re-reads on every path that can change it: mount, entering the tomato tab, the float page's own
 *  localStorage ping (the same token TomatoBar listens to), and after each toggle. No polling
 *  interval — those triggers cover it without adding a twentieth setInterval to the renderer.
 *
 *  Host contract: must provide `set(patch)` (this project's settings writer).
 */
export const FLOAT_VIS_PING_KEY = 'tomatoFloatVisPing'

export default {
  data () {
    return { floatShown: null } // null = not read yet; the template falls back to the setting
  },
  mounted () {
    this.refreshFloatShown()
    this._onFloatVisPing = e => {
      if (!e || e.key !== FLOAT_VIS_PING_KEY || e.newValue == null) return
      this.refreshFloatShown()
    }
    window.addEventListener('storage', this._onFloatVisPing)
  },
  beforeUnmount () {
    if (this._onFloatVisPing) window.removeEventListener('storage', this._onFloatVisPing)
  },
  methods: {
    async refreshFloatShown () {
      const api = window.todoAPI
      if (!api || typeof api.tomatoFloatShown !== 'function') return // browser debug shell: setting only
      try { this.floatShown = !!(await api.tomatoFloatShown()) } catch (e) { console.warn('[float-toggle] visibility read failed:', e) }
    },
    async setTomatoFloat (v) {
      this.set({ enableTomatoFloating: v })
      const api = window.todoAPI
      if (!api) { this.floatShown = !!v; return }
      try {
        await (v ? api.showTomatoFloat() : api.hideTomatoFloat())
      } catch (e) {
        console.error('[float-toggle] show/hide failed:', e)
      }
      await this.refreshFloatShown() // never assume the write took: re-read what is actually on screen
    }
  }
}
