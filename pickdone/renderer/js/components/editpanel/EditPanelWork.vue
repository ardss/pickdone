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
            <em class="ep-work-row-role" :data-role="ep.role || 'human'">{{ ep.role || 'human' }}</em>
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
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workEpisodeRole') }}</span>
            <select v-model="epForm.role" class="ep-work-input ep-work-role" data-input="role">
              <option value="human">human</option>
              <option value="agent">agent</option>
              <option value="qa">qa</option>
            </select>
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
      <!-- pd20 S1 closure (migration v14): the Finding block — observed facts with an honest
           confidence/verification display ('unknown' = never fabricated). Writes ride the same
           bus door (finding.put / finding.removeIds). -->
      <div class="ep-work-block" data-block="findings">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workFindingTitle') }}</div>
        <div v-if="findings.length" class="ep-work-list">
          <div v-for="f in findings" :key="f.findingId" class="ep-work-row" :data-finding-id="f.findingId">
            <span class="ep-work-row-text">{{ f.statement }}</span>
            <em class="ep-work-row-role" :data-level="f.verificationLevel">{{ f.verificationLevel }}/{{ f.confidence }}</em>
            <em class="ep-work-row-role" :data-status="f.status">{{ f.status }}</em>
            <button class="mini ep-work-finding-del" @click="removeFinding(f)">
              {{ $t('statsJ.EditPanel.workEpisodeDelete') }}</button>
          </div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workFindingEmpty') }}</div>
        <div class="ep-work-form" data-block="finding-form">
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workFindingStatement') }}</span>
            <input v-model="fndForm.statement" class="ep-work-input" type="text" data-input="finding-statement" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workFindingConfidence') }}</span>
            <select v-model="fndForm.confidence" class="ep-work-input ep-work-confidence" data-input="finding-confidence">
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workFindingLevel') }}</span>
            <select v-model="fndForm.verificationLevel" class="ep-work-input ep-work-level" data-input="finding-level">
              <option value="observed">observed</option>
              <option value="inferred">inferred</option>
              <option value="speculation">speculation</option>
            </select>
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workFindingBy') }}</span>
            <input v-model="fndForm.createdBy" class="ep-work-input" type="text" data-input="finding-by" />
          </label>
          <div class="ep-work-form-actions">
            <button class="mini ep-work-save-finding" :disabled="!fndForm.statement || saving" @click="saveFinding">
              {{ $t('statsJ.EditPanel.workFindingSave') }}</button>
            <span v-if="fndSaveState" class="ep-work-save-state" role="status" data-state="finding">{{ fndSaveState }}</span>
          </div>
        </div>
      </div>
      <!-- pd20 S1 closure: the Decision block — choice + alternatives/tradeoffs + decider +
           rationale + the revocable supersedes relation (supersededBy is read-derived). -->
      <div class="ep-work-block" data-block="decisions">
        <div class="ep-work-label">{{ $t('statsJ.EditPanel.workDecisionTitle') }}</div>
        <div v-if="decisions.length" class="ep-work-list">
          <div v-for="d in decisions" :key="d.decisionId" class="ep-work-row" :data-decision-id="d.decisionId">
            <span class="ep-work-row-text">{{ d.choice }}</span>
            <em class="ep-work-row-role" :data-decider="d.decider">{{ d.decider }}</em>
            <em v-if="d.supersededBy && d.supersededBy.length" class="ep-work-row-role" data-superseded="true">superseded</em>
            <button class="mini ep-work-decision-del" @click="removeDecision(d)">
              {{ $t('statsJ.EditPanel.workEpisodeDelete') }}</button>
          </div>
        </div>
        <div v-else class="ep-work-text">{{ $t('statsJ.EditPanel.workDecisionEmpty') }}</div>
        <div class="ep-work-form" data-block="decision-form">
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionChoice') }}</span>
            <input v-model="decForm.choice" class="ep-work-input" type="text" data-input="decision-choice" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionAlternatives') }}</span>
            <input v-model="decForm.alternatives" class="ep-work-input" type="text" data-input="decision-alternatives" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionTradeoffs') }}</span>
            <input v-model="decForm.tradeoffs" class="ep-work-input" type="text" data-input="decision-tradeoffs" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionDecider') }}</span>
            <input v-model="decForm.decider" class="ep-work-input" type="text" data-input="decision-decider" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionRationale') }}</span>
            <input v-model="decForm.rationale" class="ep-work-input" type="text" data-input="decision-rationale" />
          </label>
          <label class="ep-work-field">
            <span class="ep-work-field-name">{{ $t('statsJ.EditPanel.workDecisionSupersedes') }}</span>
            <input v-model="decForm.supersedes" class="ep-work-input" type="text" data-input="decision-supersedes" />
          </label>
          <div class="ep-work-form-actions">
            <button class="mini ep-work-save-decision" :disabled="!decForm.choice || saving" @click="saveDecision">
              {{ $t('statsJ.EditPanel.workDecisionSave') }}</button>
            <span v-if="decSaveState" class="ep-work-save-state" role="status" data-state="decision">{{ decSaveState }}</span>
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
        <button v-if="hasHandoff" class="mini ep-work-copy-json" data-action="copy-handoff-json" @click="copyHandoffJson">
          {{ $t('statsJ.EditPanel.workEpisodeCopyHandoffJson') }}</button>
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
      // pd20 S1 closure (migration v14): findings/decisions view models + their write forms.
      findings: [] as any,
      decisions: [] as any,
      fndForm: { statement: '', confidence: 'high', verificationLevel: 'observed', createdBy: '' },
      fndSaveState: '',
      decForm: { choice: '', alternatives: '', tradeoffs: '', decider: '', rationale: '', supersedes: '' },
      decSaveState: '',
      loadFailed: false,
      copyState: '', // pd20 fix: user-visible copy feedback ('' | success | failure message)
      // pd20 write forms: episode record (goal/outcome/nextAction) + source-ref bind.
      // pd20 (2026-11-08): role rides the form — the A→B→QA attribution is user-writable.
      epForm: { goal: '', outcome: '', nextAction: '', role: 'human' },
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
      if (!id || !(window.todoAPI && window.todoAPI.dbCall)) { this.episodes = []; this.sources = []; this.findings = []; this.decisions = []; return }
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
      // pd20 S1 closure: findings/decisions ride the same read-only whitelist doors; a read
      // failure must not break the section (the handoff just carries fewer facts).
      try {
        const fnds = await window.todoAPI.dbCall('queryFindingsByTask', id)
        this.findings = Array.isArray(fnds) ? fnds : []
      } catch (e) {
        this.findings = []
      }
      try {
        const decs = await window.todoAPI.dbCall('queryDecisionsByTask', id)
        this.decisions = Array.isArray(decs) ? decs : []
      } catch (e) {
        this.decisions = []
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
      this.epForm = { goal: '', outcome: '', nextAction: '', role: 'human' }
      this.editingId = ''
    },
    editEpisode (ep) {
      if (!ep) return
      const f = this.parseNote(ep.summary)
      this.epForm = { goal: f.goal, outcome: f.outcome, nextAction: f.nextAction, role: ep.role || 'human' }
      this.editingId = ep.episodeId
      this.epSaveState = ''
    },
    // pd20: real write through the command bus (episode.put → episodePut). The promise's
    // resolution IS the persistence receipt; the state line renders success or the failure.
    async saveEpisode () {
      if (!this.epForm.goal || this.saving || !this.taskId) return
      this.saving = true
      this.epSaveState = ''
      const payload: any = { taskId: String(this.taskId), startedAt: Date.now(), note: this.noteFromForm(), role: this.epForm.role }
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
    // P1 fix (j-pd20-episode T3/T4, 2026-11-10): the row actions below used to bail on the
    // shared `saving` flag. A click landing inside the PREVIOUS commit's quiescence window
    // (save → state 'Saved' → the 4-read load() that follows) was SILENTLY dropped — no
    // feedback, row stays, the state line still shows the stale 'Saved'. Live ops trace
    // (window.__ops, removeSource.dropped saving:true 3ms after saveSource.enter) proved the
    // episode journey's red "still in the read-back after the row Delete" is exactly this
    // drop, not a storage failure. A user's click is a command, not a suggestion: wait out
    // the in-flight commit (≤5s) and run the action serialized behind it. removeByIds is
    // tombstone-idempotent (WHERE id = ? AND deleted=0), so even a double click that both
    // survive the wait stays correct.
    async waitOpsQuiescent () {
      for (let i = 0; i < 200 && this.saving; i++) await new Promise(resolve => setTimeout(resolve, 25))
    },
    async removeEpisode (ep) {
      if (!ep) return
      await this.waitOpsQuiescent()
      if (this.saving) return // the in-flight commit never settled — do not stack a second op
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
      if (!src || !src.linkId) return
      await this.waitOpsQuiescent()
      if (this.saving) return // the in-flight commit never settled — do not stack a second op
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
    // pd20 S1 closure: finding/decision writes ride the SAME bus door (finding.put /
    // decision.put manifest rows). The list forms keep the storage honesty rules visible:
    // a speculation level is recorded as such and the storage layer will never let it
    // persist as confirmed. The alternatives/tradeoffs/supersedes inputs are split the same
    // way the CLI splits them (| for lists, verbatim id for supersedes).
    async saveFinding () {
      if (!this.fndForm.statement || this.saving || !this.taskId) return
      this.saving = true
      this.fndSaveState = ''
      try {
        await commit('finding', 'put', {
          taskId: String(this.taskId),
          statement: this.fndForm.statement,
          confidence: this.fndForm.confidence,
          verificationLevel: this.fndForm.verificationLevel,
          createdBy: this.fndForm.createdBy || 'human',
          ts: Date.now()
        })
        this.fndSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        this.fndForm = { statement: '', confidence: 'high', verificationLevel: 'observed', createdBy: '' }
        await this.load(this.taskId)
      } catch (e) {
        this.fndSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    async removeFinding (f) {
      if (!f || !f.findingId || this.saving) return
      this.saving = true
      this.fndSaveState = ''
      try {
        await commit('finding', 'removeIds', [f.findingId])
        this.fndSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        await this.load(this.taskId)
      } catch (e) {
        this.fndSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    async saveDecision () {
      if (!this.decForm.choice || this.saving || !this.taskId) return
      this.saving = true
      this.decSaveState = ''
      const splitList = v => String(v || '').split('|').map(x => x.trim()).filter(Boolean)
      try {
        await commit('decision', 'put', {
          taskId: String(this.taskId),
          choice: this.decForm.choice,
          alternatives: splitList(this.decForm.alternatives),
          tradeoffs: splitList(this.decForm.tradeoffs),
          decider: this.decForm.decider || 'human',
          rationale: this.decForm.rationale || null,
          supersedes: this.decForm.supersedes || null,
          ts: Date.now()
        })
        this.decSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        this.decForm = { choice: '', alternatives: '', tradeoffs: '', decider: '', rationale: '', supersedes: '' }
        await this.load(this.taskId)
      } catch (e) {
        this.decSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    async removeDecision (d) {
      if (!d || !d.decisionId || this.saving) return
      this.saving = true
      this.decSaveState = ''
      try {
        await commit('decision', 'removeIds', [d.decisionId])
        this.decSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveOk')
        await this.load(this.taskId)
      } catch (e) {
        this.decSaveState = this.$t('statsJ.EditPanel.workEpisodeSaveFail') + (e && e.message ? ' (' + e.message + ')' : '')
      } finally {
        this.saving = false
      }
    },
    async removeSource (src) {
      if (!src || !src.sourceRefId) return
      await this.waitOpsQuiescent()
      if (this.saving) return // the in-flight commit never settled — do not stack a second op
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
          // pd20 (2026-11-08): the view model's real role (legacy NULL already fell back to
          // 'human' in queryEpisodesByTask) — the handoff shows the A→B→QA attribution.
          role: (ep && ep.role) || 'human',
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
        const result = this.buildHandoff(this.handoffEpisodes(), this.sources || [], { id: this.taskId, title: this.taskTitle }, this.findings || [], this.decisions || [])
        const text = (result && typeof result.text === 'string') ? result.text : ''
        if (!text) throw new Error('empty handoff text')
        await navigator.clipboard.writeText(text)
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyOk')
      } catch (e) {
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyFail')
      }
    },
    // pd20 (2026-11-05) P0-2: the handoff JSON — the structured contract an external agent can
    // consume directly (task id + episodes + sources) — previously had NO export path (result.json
    // was built and dropped). Same clipboard door + feedback line as the markdown copy; the
    // canonicalUri set is exactly what buildHandoff emits (file-provider absolute paths stay out
    // of anything the user did not link deliberately, and the JSON never carries secrets — the
    // capture dedupe keys and machine meta never enter buildHandoff's inputs).
    async copyHandoffJson () {
      if (typeof this.buildHandoff !== 'function') { this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyFail'); return }
      try {
        const result = this.buildHandoff(this.handoffEpisodes(), this.sources || [], { id: this.taskId, title: this.taskTitle }, this.findings || [], this.decisions || [])
        const text = result && result.json ? JSON.stringify(result.json, null, 2) : ''
        if (!text || text === '{}') throw new Error('empty handoff json')
        await navigator.clipboard.writeText(text)
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyOk')
      } catch (e) {
        this.copyState = this.$t('statsJ.EditPanel.workEpisodeCopyFail')
      }
    }
  }
}
</script>
