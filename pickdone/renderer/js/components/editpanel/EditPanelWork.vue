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
        <button v-if="hasHandoff" class="mini ep-work-copy" @click="copyHandoff">
          {{ $t('statsJ.EditPanel.workEpisodeCopyHandoff') }}</button>
        <span v-if="copyState" class="ep-work-copy-state" role="status">{{ copyState }}</span>
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
      sources: [] as any, // pd20 fix: linked sourceRefs ({level, canonicalUri}) — the buildHandoff `sources` input
      loadFailed: false,
      copyState: '' // pd20 fix: user-visible copy feedback ('' | success | failure message)
    }
  },
  computed: {
    // vue-tsc cannot see Options-API `inject` on the template surface, so the button's
    // visibility gate goes through this computed (same runtime verdict as before: the
    // copy button shows only when a buildHandoff provider was actually injected).
    // Plain JS on purpose: this SFC's unit harness strips only `as any`-style casts,
    // not `: type` annotations.
    hasHandoff () {
      return typeof this.buildHandoff === 'function'
    },
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
  },
  watch: {
    taskId: { immediate: true, handler (id) { this.load(id) } }
  },
  methods: {
    onHeadKey (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open = !this.open }
    },
    async load (id) {
      if (!id || !(window.todoAPI && window.todoAPI.dbCall)) { this.episodes = []; this.sources = []; return }
      try {
        const rows = await window.todoAPI.dbCall('queryEpisodesByTask', id)
        this.episodes = Array.isArray(rows) ? rows : []
        this.loadFailed = false
      } catch (e) {
        this.episodes = []; this.loadFailed = true
      }
      try {
        const srcs = await window.todoAPI.dbCall('querySourcesByTask', id)
        this.sources = Array.isArray(srcs) ? srcs : []
      } catch (e) {
        this.sources = [] // provenance read failure must not break the section (handoff just carries fewer sources)
      }
    },
    // Map the dbCall view-model episodes to buildHandoff's episode shape ({startedAt, role, goal,
    // outcome, nextAction}) — the storage vm's `summary` is the episode goal; startedAt is epoch ms.
    handoffEpisodes () {
      return (this.episodes || []).map(ep => ({
        startedAt: ep && ep.startedAt ? new Date(ep.startedAt).toISOString() : '',
        role: 'human',
        goal: (ep && ep.summary) || '',
        outcome: '',
        nextAction: ''
      }))
    },
    async copyHandoff () {
      if (typeof this.buildHandoff !== 'function') { this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyFail'); return }
      try {
        // pd20 fix: the real signature is buildHandoff(episodes, sources, task) → {text, json}.
        // The clipboard gets result.text (the markdown), NOT the object — the old code did
        // String(result) and pasted "[object Object]".
        const result = this.buildHandoff(this.handoffEpisodes(), this.sources || [], { id: this.taskId, title: this.taskTitle })
        const text = (result && typeof result.text === 'string') ? result.text : ''
        if (!text) throw new Error('empty handoff text')
        await navigator.clipboard.writeText(text)
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyOk')
      } catch (e) {
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyFail')
      }
    }
  }
}
</script>
