<template>
  <!-- pd20 S3: '继续工作' folded section (work episodes). The host EditPanel.vue owns the gate
       (workEpisode settings switch, default OFF) and the save queue. The handoff text is produced
       by the injected S2 pure function `buildHandoff` (no local re-implementation: single source
       of truth for the handoff format).
       pd20 (2026-11-03): the section is no longer read/copy only — it WRITES through the command
       bus facade (episode.put / source.put / tasksource.put / tombstone removes). All saves go
       through the real persisted door and surface success/failure state lines. -->
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
          <div v-for="ep in episodes" :key="ep.episodeId" class="ep-work-row" role="button" tabindex="0"
               :data-episode-id="ep.episodeId"
               @click="editEpisode(ep)" @keydown.enter.prevent="editEpisode(ep)">
            <span class="ep-work-row-text">{{ parseNote(ep.summary).goal || '' }}</span>
            <button class="mini ep-work-edit" @click.stop="editEpisode(ep)">
              {{ $t('statsJ.EditPanel.workEpisodeEdit') }}</button>
            <button class="mini ep-work-del" @click.stop="removeEpisode(ep)">
              {{ $t('statsJ.EditPanel.workEpisodeDelete') }}</button>
          </div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workEpisodeEmpty') }}</div>
      </div>
      <div class="ep-work-block" data-block="episode-form">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeRecordTitle') }}</div>
        <div class="ep-work-form">
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeGoal') }}</span>
            <input v-model="epForm.goal" class="ep-work-input" type="text"
                   :data-input="editingId ? 'edit-goal' : 'new-goal'" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeOutcome') }}</span>
            <input v-model="epForm.outcome" class="ep-work-input" type="text" data-input="outcome" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeNext') }}</span>
            <input v-model="epForm.nextAction" class="ep-work-input" type="text" data-input="next-action" />
          </label>
          <div class="ep-work-form-actions">
            <button class="mini ep-work-save-episode" :disabled="!epForm.goal || saving" @click="saveEpisode">
              {{ editingId ? $t('statsJ.EditPanel.workEpisodeUpdate') : $t('statsJ.EditPanel.workEpisodeSave') }}</button>
            <button v-if="editingId" class="mini ep-work-cancel-edit" @click="resetEpForm">
              {{ $t('statsJ.EditPanel.workEpisodeCancel') }}</button>
            <span v-if="epSaveState" class="ep-work-save-state" role="status" data-state="episode">{{ epSaveState }}</span>
          </div>
        </div>
      </div>
      <div class="ep-work-block" data-block="resources">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeResources') }}</div>
        <div v-if="sources.length" class="ep-work-list">
          <div v-for="s in sources" :key="s.linkId || s.canonicalUri" class="ep-work-row" :data-source-uri="s.canonicalUri">
            <span class="ep-work-row-text">{{ s.title || s.canonicalUri }}</span>
            <button class="mini ep-work-unbind" :disabled="!s.linkId" @click="unbindSource(s)">
              {{ $t('statsJ.EditPanel.workEpisodeUnbind') }}</button>
            <button class="mini ep-work-src-del" :disabled="!s.sourceRefId" @click="removeSource(s)">
              {{ $t('statsJ.EditPanel.workEpisodeDelete') }}</button>
          </div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workEpisodeEmpty') }}</div>
      </div>
      <div class="ep-work-block" data-block="source-form">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workEpisodeSourceTitle') }}</div>
        <div class="ep-work-form">
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeSourceProvider') }}</span>
            <select v-model="srcForm.providerId" class="ep-work-input ep-work-provider" data-input="provider">
              <option value="manual">manual</option>
              <option value="file">file</option>
              <option value="github">github</option>
            </select>
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeSourceExternal') }}</span>
            <input v-model="srcForm.externalId" class="ep-work-input" type="text" data-input="external-id" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeSourceTitleField') }}</span>
            <input v-model="srcForm.title" class="ep-work-input" type="text" data-input="source-title" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeTrust') }}</span>
            <select v-model="srcForm.trustLevel" class="ep-work-input ep-work-trust" data-input="trust">
              <option value="L0">L0</option>
            </select>
          </label>
          <div class="ep-work-form-actions">
            <button class="mini ep-work-save-source" :disabled="!srcForm.externalId || saving" @click="saveSource">
              {{ $t('statsJ.EditPanel.workEpisodeBind') }}</button>
            <span v-if="srcSaveState" class="ep-work-save-state" role="status" data-state="source">{{ srcSaveState }}</span>
          </div>
        </div>
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
import { commit } from '../../utils/commandBus.js' // pd20: the ONE renderer mutation door (episode/source writes ride the bus)

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
      sources: [] as any, // pd20 fix: linked sourceRefs ({linkId, sourceRefId, level, canonicalUri}) — the buildHandoff `sources` input
      loadFailed: false,
      copyState: '', // pd20 fix: user-visible copy feedback ('' | success | failure message)
      // pd20 write forms: episode record (goal/outcome/nextAction) + source-ref bind
      epForm: { goal: '', outcome: '', nextAction: '' },
      editingId: '', // '' = creating a new episode; otherwise the episodeId being edited
      epSaveState: '',
      srcForm: { providerId: 'manual', externalId: '', title: '', trustLevel: 'L0' },
      srcSaveState: '',
      saving: false
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
      return last ? String(this.parseNote(last.summary).goal || last.status || '') : ''
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
    // Episode note round-trip: the storage column is a single `note` string; the form's three
    // fields serialize into it. Plain notes (CLI/bus-door writes) stay legible: no recognized
    // field lines → the whole note IS the goal.
    parseNote (note) {
      const s = String(note || '')
      const grab = (re) => { const m = s.match(re); return m ? m[1].trim() : '' }
      const goal = grab(/(?:^|\n)goal:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/)
      if (!goal) return { goal: s, outcome: '', nextAction: '' }
      return { goal, outcome: grab(/(?:^|\n)outcome:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/), nextAction: grab(/(?:^|\n)nextAction:[ \t]*([\s\S]*?)(?=\noutcome:|\nnextAction:|$)/) }
    },
    noteFromForm () {
      const { goal, outcome, nextAction } = this.epForm
      if (!outcome && !nextAction) return goal
      return 'goal: ' + goal + '\noutcome: ' + outcome + '\nnextAction: ' + nextAction
    },
    resetEpForm () {
      this.epForm = { goal: '', outcome: '', nextAction: '' }
      this.editingId = ''
    },
    editEpisode (ep) {
      if (!ep) return
      const f = this.parseNote(ep.summary)
      this.epForm = { goal: f.goal, outcome: f.outcome, nextAction: f.nextAction }
      this.editingId = ep.episodeId
      this.epSaveState = ''
    },
    // pd20: real write through the command bus (episode.put → episodePut). The promise's
    // resolution IS the persistence receipt; the state line renders success or the failure.
    async saveEpisode () {
      if (!this.epForm.goal || this.saving || !this.taskId) return
      this.saving = true
      this.epSaveState = ''
      const payload = { taskId: String(this.taskId), startedAt: Date.now(), note: this.noteFromForm() }
      if (this.editingId) {
        const old = this.episodes.find(e => e.episodeId === this.editingId)
        payload.id = this.editingId
        if (old) payload.startedAt = old.startedAt
      }
      try {
        await commit('episode', 'put', payload)
        this.epSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        this.resetEpForm()
        await this.load(this.taskId)
      } catch (e) {
        this.epSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    async removeEpisode (ep) {
      if (!ep || this.saving) return
      this.saving = true
      this.epSaveState = ''
      try {
        await commit('episode', 'removeIds', [ep.episodeId])
        if (this.editingId === ep.episodeId) this.resetEpForm()
        this.epSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        await this.load(this.taskId)
      } catch (e) {
        this.epSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    // pd20: bind a source ref — source.put mints (or reuses, by the storage pair-unique
    // pre-check) the ref, tasksource.put links it to this task. Both commits are awaited:
    // the state line is the persisted receipt, not an optimistic guess.
    async saveSource () {
      if (!this.srcForm.externalId || this.saving || !this.taskId) return
      this.saving = true
      this.srcSaveState = ''
      try {
        const refId = await commit('source', 'put', {
          providerId: this.srcForm.providerId,
          externalId: this.srcForm.externalId,
          title: this.srcForm.title,
          trustLevel: this.srcForm.trustLevel
        })
        await commit('tasksource', 'put', { taskId: String(this.taskId), sourceRefId: refId })
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        this.srcForm.externalId = ''
        this.srcForm.title = ''
        await this.load(this.taskId)
      } catch (e) {
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    // pd20: undo a binding — tombstone the task_source_links row (the ref itself survives).
    async unbindSource (src) {
      if (!src || !src.linkId || this.saving) return
      this.saving = true
      this.srcSaveState = ''
      try {
        await commit('tasksource', 'remove', [src.linkId])
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        await this.load(this.taskId)
      } catch (e) {
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    // pd20: delete the source ref itself (tombstone) — the link row disappears from every
    // read (the query joins on sr.deleted = 0), matching the journey's cleanup semantics.
    async removeSource (src) {
      if (!src || !src.sourceRefId || this.saving) return
      this.saving = true
      this.srcSaveState = ''
      try {
        await commit('source', 'removeByIds', [src.sourceRefId])
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        await this.load(this.taskId)
      } catch (e) {
        this.srcSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    // Map the dbCall view-model episodes to buildHandoff's episode shape ({startedAt, role, goal,
    // outcome, nextAction}) — the storage vm's `summary` is parsed by the same round-trip the
    // edit form uses, so form-written episodes hand off all three fields.
    handoffEpisodes () {
      return (this.episodes || []).map(ep => {
        const f = this.parseNote(ep && ep.summary)
        return {
          startedAt: ep && ep.startedAt ? new Date(ep.startedAt).toISOString() : '',
          role: 'human',
          goal: f.goal,
          outcome: f.outcome,
          nextAction: f.nextAction
        }
      })
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
