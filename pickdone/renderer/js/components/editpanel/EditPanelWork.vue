<template>
  <!-- pd20 S3: '继续工作' folded section (work episodes). Markup + its own read/copy only —
       the host EditPanel.vue owns the gate (workEpisode settings switch, default OFF) and the
       save queue. The handoff text is produced by the injected S2 pure function `buildHandoff`
       (no local re-implementation: single source of truth for the handoff format). -->
  <div class="ep-work-section">
    <div class="ep-row ep-work-head" role="button" tabindex="0"
         :aria-expanded="open ? 'true' : 'false'"
         @click="open = !open" @keydown="onHeadKey">
      <span class="ep-field-label">{{ $t('statsJ.EditPanel.workEpisodeTitle') }}</span>
      <span class="ml-auto"></span>
      <span class="ep-row-arrow" :class="{ on: open }">▾</span>
    </div>
    <div v-if="open" class="ep-work-body">
      <div class="ep-work-block" data-block="current">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeCurrent') }}</div>
        <div class="ep-work-text">{{ currentText || $t('statsJ.EditPanel.workEpisodeEmpty') }}</div>
      </div>
      <div class="ep-work-block" data-block="history">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeHistory') }}</div>
        <div v-if="episodes.length" class="ep-work-list">
          <div v-for="ep in episodes" :key="ep.episodeId" class="ep-work-row">{{ ep.summary || '' }}</div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workEpisodeEmpty') }}</div>
      </div>
      <div class="ep-work-block" data-block="resources">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeResources') }}</div>
        <div v-if="resources.length" class="ep-work-list">
          <div v-for="r in resources" :key="r" class="ep-work-row">{{ r }}</div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workEpisodeEmpty') }}</div>
      </div>
      <div class="ep-work-block" data-block="handoff">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeHandoff') }}</div>
        <div class="ep-work-text">{{ episodes.length ? taskTitle : '' }}</div>
        <button v-if="buildHandoff" class="mini ep-work-copy" @click="copyHandoff">
          {{ $t('statsJ.EditPanel.workEpisodeCopyHandoff') }}</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: 'EpWork',
  props: {
    taskId: { type: Number, default: 0 },
    taskTitle: { type: String, default: '' }
  },
  // S2 seam: the handoff formatter is the pure function injected from above — this component
  // never re-implements the format (no second protocol). When no provider exists yet (S2 not
  // landed), the copy button stays hidden instead of guessing a format.
  inject: {
    buildHandoff: { default: null }
  },
  data () {
    return {
      open: true,
      episodes: [] as any,
      loadFailed: false
    }
  },
  computed: {
    currentText () {
      const last = this.episodes[this.episodes.length - 1]
      return last ? String(last.summary || last.status || '') : ''
    },
    resources () {
      const seen: any = []
      for (const ep of this.episodes) {
        for (const r of (ep && ep.resources) || []) {
          if (r && !seen.includes(r)) seen.push(r)
        }
      }
      return seen
    },
    handoffPayload () {
      return { taskId: this.taskId, taskTitle: this.taskTitle, episodes: this.episodes }
    }
  },
  watch: {
    taskId: { immediate: true, handler (id) { this.load(id) } }
  },
  methods: {
    onHeadKey (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open = !this.open }
    },
    async load (id) {
      if (!id || !(window.todoAPI && window.todoAPI.dbCall)) { this.episodes = []; return }
      try {
        const rows = await window.todoAPI.dbCall('queryEpisodesByTask', id)
        this.episodes = Array.isArray(rows) ? rows : []
        this.loadFailed = false
      } catch (e) {
        this.episodes = []; this.loadFailed = true
      }
    },
    async copyHandoff () {
      if (typeof this.buildHandoff !== 'function') return
      const text = String(this.buildHandoff(this.handoffPayload))
      try { await navigator.clipboard.writeText(text) } catch (e) { /* clipboard unavailable */ }
    }
  }
}
</script>
