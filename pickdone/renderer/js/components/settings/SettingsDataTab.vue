<template>
  <!-- Data management tab (extracted from SettingsModal.vue, W5 wave 1; zero behavior change) -->
  <div class="tab-panel">
    <div class="form">
      <div class="form-label">{{ $t('statsE.SettingsModal.autoBackupSection') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoBackupLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.autoBackupEnabled !== false" @change="v=>set({autoBackupEnabled:v})"/></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backupIntervalLabel') }}</span>
        <div class="form-item__control">
          <el-radio-group size="small" :model-value="String(st.autoBackupIntervalMin || 30)" @change="v=>set({autoBackupIntervalMin:+v})" :aria-label="$t('statsE.SettingsModal.backupIntervalLabel')">
            <el-radio-button v-for="o in ['10','30','60','180','360']" :key="o" :value="o">{{ (Number(o)>=60 ? (Number(o)/60)+$t('statsE.SettingsModal.hoursUnit') : $t('statsH.SettingsModal.minutesUnit', { n: o })) }}</el-radio-button>
          </el-radio-group>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.recentCopiesLabel') }}</span>
        <div class="form-item__control">
          <el-select size="small" :model-value="String(st.autoBackupKeep || 10)" @change="v=>set({autoBackupKeep:+v})" class="ctl-sm">
            <el-option v-for="o in ['5','10','20','30']" :key="o" :label="o+$t('statsE.SettingsModal.copiesUnit')" :value="o"/>
          </el-select>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoPurgeBinLabel') }}</span>
        <div class="form-item__control">
          <el-radio-group size="small" :model-value="String(st.recycleBinAutoDeleteDays)" @change="v=>set({recycleBinAutoDeleteDays:+v})" :aria-label="$t('statsE.SettingsModal.autoPurgeBinLabel')">
            <el-radio-button v-for="o in [7,15,30,60,90,0]" :key="o" :value="String(o)">{{ o===0 ? $t('statsH.SettingsModal.never') : $t('statsH.SettingsModal.dayUnit', { n: o }) }}</el-radio-button>
          </el-radio-group>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backupLocationLabel') }}</span>
        <div class="form-item__control">
          <span class="tip">{{ backupDirDisplay }}</span>
          <button class="mini" @click="pickBackupDir">{{ $t('statsE.SettingsModal.changeBtn') }}</button>
          <button v-if="st.backupDir" class="mini" @click="resetBackupDir">{{ $t('statsE.SettingsModal.resetDefaultBtn') }}</button>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backUpNowLabel') }}</span>
        <div class="form-item__control">
          <button class="mini" @click="runAutoBackupNow">{{ $t('statsE.SettingsModal.autoBackUpNowBtn') }}</button>
          <span class="tip">{{ autoBackupStatusLine + eventBackupFailSuffix }} · {{ $t('statsH.SettingsModal.backupRetentionTip') }}</span>
        </div></div>
    </div>
    <div class="form">
      <div class="form-label">{{ $t('statsE.SettingsModal.dataManagementSection') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.exportExcelLabel') }}</span>
        <div class="form-item__control"><button class="primary mini-lg" :disabled="exporting" @click="exportXlsx">{{ $t('statsE.SettingsModal.exportXlsxBtn') }}</button>
          <!-- B2 (2026-09-25): the tip now promises only "viewing / archive". The old "to migrate
               data back use CSV import" pointed at an impossible round-trip: CSV import reads
               TickTick/dida365/Todoist vendor exports only, NOT this app's own xlsx (and an
               own-format CSV/CLI export capability does not exist yet — tracked as a legacy item). -->
          <span class="tip">{{ $t('statsE.SettingsModal.exportXlsxTip') }}</span></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.importCsvLabel') }}</span>
        <div class="form-item__control"><button class="mini-lg" :disabled="importing" @click="importFromCsv">{{ $t('statsE.SettingsModal.importCsvBtn') }}</button></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.snapshotWriteLabel') }}</span>
        <div class="form-item__control">
          <button class="mini-lg" :disabled="backingUp" @click="writeBackupNow">{{ $t('statsE.SettingsModal.snapshotBackUpNowBtn') }}</button>
          <span class="tip">{{ $t('statsE.SettingsModal.snapshotStructureHint') }}</span>
        </div></div>
    </div>
    <div class="form">
      <div class="form-label">{{ $t('statsE.SettingsModal.dangerZone') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.restoreSnapshotLabel') }}</span>
        <div class="form-item__control"><button class="danger-btn" @click="restoreFromBackup">{{ $t('statsE.SettingsModal.restoreEllipsis') }}</button></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoRestoreLabel') }}</span>
        <div class="form-item__control" style="display:flex;gap:8px">
          <el-select size="small" v-model="autoBackupPick" filterable style="max-width:260px" @focus="loadAutoBackupList" @visible-change="v => v && loadAutoBackupList()">
            <el-option v-for="f in autoBackupFiles" :key="f" :label="f" :value="f" />
          </el-select>
          <button class="mini" @click="restoreFromAutoBackup">{{ $t('statsE.SettingsModal.autoRestoreBtn') }}</button>
        </div></div>
      <div class="form-item danger-row"><span class="form-item__label">{{ $t('statsE.SettingsModal.clearDemoDataLabel') }}</span>
        <div class="form-item__control"><button class="danger-btn" @click="purgeSeed">{{ $t('statsE.SettingsModal.clearBtn') }}</button></div></div>
      <div class="form-item danger-row"><span class="form-item__label">{{ $t('statsE.SettingsModal.emptyBinLabel') }}</span>
        <div class="form-item__control"><button class="danger-btn" @click="purgeRecycle">{{ $t('statsE.SettingsModal.emptyBinBtn') }}</button></div></div>
    </div>
  </div>
</template>

<script lang="ts">
/** Data-management tab of the settings center: auto-backup config, export/import,
 *  snapshot write + both restore paths, demo-data purge and recycle-bin purge.
 *  Extracted verbatim from SettingsModal.vue (W5 wave 1) — talks to the settings store
 *  directly (no props). The patch goes through settings/update exactly like the parent's
 *  set(): none of this tab's keys are dual-store tomato keys, so the tomato mirror in the
 *  parent's set() is not reachable from here (zero behavior change). Generic form-control
 *  styles stay in the parent's global stylesheet. */
import { dayjs, FMT } from '../../utils/core.js'
import { confirmRecycleClear } from '../../utils/confirm.js'
import { loadRuntime } from '../../store/helpers/runtimeState.js'
import { commit as commitCommand } from "../../utils/commandBus.js"
import { SCHEMA_V } from '../../store/helpers/todoBackup.js'
import { repeatRuleMetaKeys, ruleMapFromMetaRows, repeatRuleCell } from '../../utils/exportRepeatRules.js'
import { invalidateEstimateCache } from '../../utils/tomatoEstimate.js'

/** Restore = the user wants the backup's data to win. Backup rows carry their backup-time
 *  updateTime + status:'sync', so LAN LWW instantly reverts the restore against any peer
 *  holding newer rows, and the cloud dirty filter skips status:'sync' rows. Stamping each
 *  restored row dirty ('update') with a fresh updateTime preserves "old data wins".
 *  (Only todo rows carry the sync ledger; settings/category/habits restore via store commits.) */
function restoreStampRow (row, now = null) {
  if (!row || typeof row !== 'object') return row
  return { ...row, status: 'update', updateTime: now || Date.now() }
}

/** B2 (2026-09-26): filter/plan rows keep their backup-time updatedAt in the DB, and filterUpsert/
 *  planAddMany preserve explicit stamps — on a LAN-sync peer holding newer rows the restore lost
 *  LWW instantly. Re-stamp the row's updatedAt fresh (batched per restore) so restored rows win.
 *  filterUpsert's content no-op suppression keeps unchanged rows untouched; changed rows land
 *  fresh and win, matching the restore-wins semantics above. */
function restoreStampLww (row, now) {
  if (!row || typeof row !== 'object') return row
  return { ...row, updatedAt: now }
}

/** metaState (2026-09-26): only these meta-key surfaces are restorable — same whitelist as the
 *  startup path (dbRecovery.META_RESTORE_PREFIXES). Transient keys (catProjectMetaBak.*,
 *  pending markers, todosVersion) are deliberately excluded. */
const META_RESTORE_PREFIXES = [
  'repeatRule:',
  'tomatoEstimateState:',
  'projectDeadline:',
  'projectStatus:',
  'projectCategoryFlag:',
  'projectMilestones:',
  'projectCategoryIds'
]

export default {
  name: 'SettingsDataTab',
  data () {
    return {
      exporting: false,
      importing: false,
      backingUp: false,
      backupDirDefault: '',
      autoBackupLastAt: 0,
      autoBackupLastFailAt: 0,
      autoBackupLastError: '',
      eventBackupLastFailAt: 0,
      eventBackupLastError: '',
      backupDirShown: '',
      autoBackupFiles: [] as any,
      autoBackupPick: ''
    }
  },
  computed: {
    st () { return this.$store.state.settings },
    backupDirDisplay () { return this.backupDirShown || this.$t('statsE.SettingsModal.loadingPlaceholder') },
    // Honest backup status: a recent failure outranks the "never ran" fallback so a persistently
    // failing backup (unwritable dir / offline disk) is not mislabeled as "not run yet"
    // F3 (dw wave6 adversarial round): event-snapshot (pre-purge) failures were stamped into
    // runtimeState by writeEventBackupCore but rendered NOWHERE — the lastBackupFailPrefix channel
    // only read autoBackupLast*. Surface the last failed evt snapshot through the same channel.
    eventBackupFailSuffix () {
      if (!this.eventBackupLastFailAt) return ''
      return ' · ' + this.$t('statsH.SettingsModal.lastBackupFailPrefix') + (this.eventBackupLastError || this.$t('statsH.SettingsModal.backupFailed')) + ' (evt ' + this.dfmt(this.eventBackupLastFailAt) + ')'
    },
    autoBackupStatusLine () {
      if (this.autoBackupLastFailAt && this.autoBackupLastFailAt >= this.autoBackupLastAt) {
        return this.$t('statsH.SettingsModal.lastBackupFailPrefix') + (this.autoBackupLastError || this.$t('statsH.SettingsModal.backupFailed')) + ' (' + this.dfmt(this.autoBackupLastFailAt) + ')'
      }
      return this.autoBackupLastAt ? this.$t('statsE.SettingsModal.lastRunPrefix') + this.dfmt(this.autoBackupLastAt) : this.$t('statsH.SettingsModal.notRunYet')
    }
  },
  mounted () {
    this.loadBackupDirDisplay()
  },
  methods: {
    dfmt (ts) { return dayjs(ts).format(FMT.dateTime) },
    set (patch) {
      this.$store.dispatch('settings/update', patch) // goes through the action to sync to the main process config.json (same ledger as the parent's set())
    },
    /** Unified double confirmation for dangerous operations: a regular confirm first, then an irreversible final confirm */
    async confirmDanger (msg, title, type) {
      await this.$confirm(msg, title, { type: type || 'warning' })
      // Final confirm must use its own copy, not unrelated settings labels (P1: was panelSyncHint/breakLengthLabel)
      await this.$confirm(this.$t('statsE.SettingsModal.finalConfirmMsg'), title, { type: 'error', confirmButtonText: this.$t('statsE.SettingsModal.finalConfirmBtn') })
    },
    // CSV one-click migration (other todo apps → Pickdone): main process picks file + preview, executes on confirm; repeating tasks deduped by engine fingerprint
    async importFromCsv () {
      if (this.importing) return
      this.importing = true
      try {
        const picked = await window.todoAPI.importCsvPickPreview()
        if (!picked) return // user canceled the file dialog
        // P3 (2026-09-12): expected failures arrive as { ok:false, code, message } instead of an
        // invoke() rejection (whose custom Error props never survive the context bridge). The
        // catch below keeps the '[CODE]' message-regex as a legacy-format fallback.
        if (picked.ok === false) {
          if (picked.code === 'FORMAT_UNKNOWN') this.$message.error(this.$t('statsE.SettingsModal.importErrFormatUnknown'))
          else if (picked.code === 'EMPTY_FILE') this.$message.error(this.$t('statsE.SettingsModal.importErrEmptyFile'))
          else this.$message.error(this.$t('statsE.SettingsModal.importFailedMsg') + (picked.message || ''))
          return
        }
        const r = picked.report
        const msg = this.$t('statsE.SettingsModal.importPreviewMsg', { f: r.format, n: r.wouldImport, d: r.duplicates, s: r.skipped })
        try { await this.$confirm(msg, this.$t('statsH.SettingsModal.importTitle'), { type: 'info' }) } catch { return }
        // S4 (2026-09-12): event snapshot before the bulk import, same renderer-side channel as
        // purge/purge-all (store/todo.js writeEventBackup). Main-process-side dumping would need a
        // second dump builder and risk diverging from the restore format; this reuses
        // buildBackupDump verbatim so the snapshot restores identically.
        // Domain-2 review (2026-09-24): writeEventBackupCore now returns a boolean (todoBackup.js
        // F3) — a failed pre-import snapshot must at least warn the user (no rollback point), same
        // contract as todo.js purge/purge-all.
        if (!(await this.$store.dispatch('todo/writeEventBackup', 'import'))) this.$message.warning(this.$t('statsE.SettingsModal.snapshotFailWarnMsg'))
        const done = await window.todoAPI.importCsvRun(picked.file)
        await this.$store.dispatch('_rt/refreshFromDb')
        // B1 (2026-09-25): import:run now returns the structured { ok:false, code, message } contract
        // (AUTH_EXPIRED / HASH_MISMATCH / FILE_MISSING / USAGE / FORMAT_UNKNOWN instead of throws).
        // The result used to be fed straight into the success toast — a failed run reported
        // "imported N" with N=undefined. Same code branch shape as the preview stage above.
        if (done && done.ok === false) {
          if (done.code === 'FORMAT_UNKNOWN') this.$message.error(this.$t('statsE.SettingsModal.importErrFormatUnknown'))
          else if (done.code === 'EMPTY_FILE') this.$message.error(this.$t('statsE.SettingsModal.importErrEmptyFile'))
          else this.$message.error(this.$t('statsE.SettingsModal.importFailedMsg') + (done.message || done.code || ''))
          return
        }
        this.$message.success(this.$t('statsH.SettingsModal.importDone', { n: done.imported, d: done.duplicates }))
      } catch (e) {
        // H8 (2026-09-12): worker error codes (FORMAT_UNKNOWN/EMPTY_FILE/USAGE) arrive as a
        // '[CODE] message' prefix — Electron's invoke() rejection strips custom Error props,
        // so the message prefix is the only channel that survives the context bridge.
        const msg = (e && e.message) || String(e)
        const code = (msg.match(/^\[(FORMAT_UNKNOWN|EMPTY_FILE|USAGE)\]/) || [])[1]
        if (code === 'FORMAT_UNKNOWN') this.$message.error(this.$t('statsE.SettingsModal.importErrFormatUnknown'))
        else if (code === 'EMPTY_FILE') this.$message.error(this.$t('statsE.SettingsModal.importErrEmptyFile'))
        else this.$message.error(this.$t('statsE.SettingsModal.importFailedMsg') + msg)
      } finally { this.importing = false }
    },
    async pickBackupDir () {
      // P3-8 (maint/dw 2026-09-23): the dialog/IPC rejection used to escape as an unhandled
      // rejection with zero user feedback (importFromCsv / runAutoBackupNow both report).
      try {
        const dir = await window.todoAPI.pickBackupDir()
        if (!dir) return
        this.set({ backupDir: dir })
        this.loadBackupDirDisplay()
        this.$message.success(this.$t('statsE.SettingsModal.backupLocationUpdatedMsg'))
      } catch (e) {
        this.$message.error(this.$t('statsE.SettingsModal.backupFail'))
      }
    },
    resetBackupDir () {
      this.set({ backupDir: '' })
      this.loadBackupDirDisplay()
    },
    async loadBackupDirDisplay () {
      const rt = loadRuntime()
      this.autoBackupLastAt = rt.autoBackupLastAt || 0
      this.autoBackupLastFailAt = rt.autoBackupLastFailAt || 0
      this.autoBackupLastError = rt.autoBackupLastError || ''
      this.eventBackupLastFailAt = rt.eventBackupLastFailAt || 0
      this.eventBackupLastError = rt.eventBackupLastError || ''
      try {
        const def = await window.todoAPI.getDefaultBackupDir()
        this.backupDirDefault = def
        this.backupDirShown = this.st.backupDir || def
      } catch {}
    },
    async runAutoBackupNow () {
      const ok = await this.$store.dispatch('todo/writeAutoBackup')
      const rt = loadRuntime()
      this.autoBackupLastAt = rt.autoBackupLastAt || (ok ? Date.now() : 0)
      this.autoBackupLastFailAt = rt.autoBackupLastFailAt || 0
      this.autoBackupLastError = rt.autoBackupLastError || ''
      // Failures must be reported honestly (an unwritable backupDir / an offline disk once silently faked success for a long time)
      ok === false ? this.$message.error(this.$t('statsE.SettingsModal.backupFail')) : this.$message.success(this.$t('statsE.SettingsModal.autoBackupWrittenMsg'))
    },
    async exportXlsx () {
      if (this.exporting) return
      this.exporting = true
      try {
        // Export active tasks only: recycle bin rows mixed in would lack the deleted marker (and would inevitably revive on a future import)
        const list = this.$store.state.todo.todoList
        if (!list.length) return this.$message.info(this.$t('statsE.SettingsModal.noDataYet'))
        const catName = id => (this.$store.state.category.list.find(c => c.categoryId === id) || {}).categoryName || ''
        // B7 (2026-09-25): fill column 11 with the repeat rule BODY (serialized repeatSettingsV2 JSON
        // from meta 'repeatRule:<rid>'), not just the bare repeatId — one batched meta read before
        // mapping; a read failure degrades to the old bare-repeatId cell instead of killing the export
        let ruleMap = {}
        const ruleKeys = repeatRuleMetaKeys(list)
        if (ruleKeys.length) {
          try { ruleMap = ruleMapFromMetaRows(await window.todoAPI.getMetaMany(ruleKeys)) } catch { /* export without rule bodies */ }
        }
        const rows = list.map(t => [
          t.taskId,
          t.dayStart ? dayjs(t.dayStart).format(FMT.date) : '',
          catName(t.categoryId),
          t.taskContent, t.taskDescribe || '',
          this.subtaskLines(t.subtasks),
          t.complete ? this.$t('statsE.SettingsModal.yesLabel') : this.$t('statsH.SettingsModal.exportNo'),
          String(t.estimate || 0),
          t.reminderTime ? dayjs(t.reminderTime).format(FMT.dateTime) : '',
          (t.reminderOffsets || []).join(','),
          // B7: rule body (serialized repeatSettingsV2) when the meta row exists, else the bare repeatId
          repeatRuleCell(t, ruleMap),
          t.deadlineTs ? dayjs(t.deadlineTs).format(FMT.date) : '',
          t.important === 1 || t.important === true ? 'Y' : 'N',
          t.urgent === 1 || t.urgent === true ? 'Y' : 'N',
          t.difficulty || 0, // DB row-set field is `difficulty` (db-rows.js rowToTodo); todoDifficultyLevel never existed and always exported 0
          // D6-F15: priority (0 none / 1 low / 3 high, matching the EditPanel two-tier ledger) and
          // completion time were never exported — the Excel snapshot lost the quadrant + completion data
          t.priority || 0,
          t.completedAt ? dayjs(t.completedAt).format(FMT.dateTime) : ''
        ])
        const r = await window.todoAPI.exportXlsx({ fileName: this.$t('statsH.SettingsModal.exportFileName', { ts: dayjs().format('YYYYMMDD_HHmmss') }), rows })
        if (!r.canceled && !r.error) this.$message.success(this.$t('statsE.SettingsModal.exportedPrefix') + r.filePath)
        else if (r.error) this.$message.error(r.error)
      } catch (e) {
        // Dirty subtask JSON / IPC failure must not escape as an unhandled rejection (same contract as importFromCsv)
        this.$message.error(this.$t('statsE.SettingsModal.exportFailedMsg') + (e && e.message ? e.message : String(e)))
      } finally { this.exporting = false }
    },
    /** Dirty subtask JSON must not kill the whole export: a broken row exports without its checklist */
    subtaskLines (raw) {
      try { return (JSON.parse(raw || '[]')).map(s => (s.checked ? '[x] ' : '[ ] ') + s.text).join('\n') } catch { return '' }
    },
    /** F6 (2026-09-24): write→poll→verdict as ONE async helper (extracted from writeBackupNow's
     *  confirm callback so the timeout logic has a single home). The old verdict treated
     *  "content never changed within the window" as FAILURE, but the main process rewrites the
     *  snapshot unconditionally (no dedup) — identical content IS a successful write, and the
     *  store's 5s debounce could legitimately land right after the old 5s poll deadline.
     *  Verdict: content CHANGED within the window → written; timeout with content readable and
     *  IDENTICAL to before → already up to date (success); only an unreadable snapshot (null,
     *  i.e. real IPC/write failure) reports failure. Window widened to 7.5s to cover the
     *  debounce + write latency. */
    async verifySnapshotWritten () {
      const before = await window.todoAPI.readCriticalStateBackup().catch(() => null)
      this.$store.dispatch('todo/writeCriticalBackup')
      const deadline = Date.now() + 7500
      let txt = null
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
        txt = await window.todoAPI.readCriticalStateBackup().catch(() => null)
        // done as soon as the snapshot differs from the pre-write content
        if (txt && txt !== before) return { ok: true }
      }
      // Post-deadline verdict: identical readable content is NOT a proven failure (no-dedup rewrite
      // + 5s debounce), but it is NOT a proven success either — writeCriticalBackupCore is
      // fire-and-forget and swallows write errors (p.catch → console.error), so a REAL failure
      // (disk full / permission) also leaves the content identical. Review 2026-09-24: the caller
      // reports unchanged as a NEUTRAL info toast, never a success toast. Only null (unreadable)
      // is a hard failure.
      if (txt && txt === before) return { ok: true, unchanged: true }
      return { ok: false }
    },
    async writeBackupNow () {
      // Trigger a critical-state backup immediately and point out its location.
      // Poll via verifySnapshotWritten (see there for the change-vs-identical verdict); the busy
      // flag blocks double-click re-entry.
      if (this.backingUp) return
      this.backingUp = true
      try {
        const r = await this.verifySnapshotWritten()
        if (r.ok) {
          // unchanged = NEUTRAL info, never success: identical content can mean "already up to
          // date" OR a silently failed fire-and-forget write — a false success on a disaster-
          // recovery action is worse than the old false failure.
          r.unchanged
            ? this.$message.info(this.$t('statsE.SettingsModal.snapshotUpToDateMsg'))
            : this.$message.success(this.$t('statsE.SettingsModal.criticalBackupWrittenMsg'))
        } else {
          this.$message.error(this.$t('statsH.SettingsModal.backupFailed'))
        }
      } catch (e) {
        // P3-8: readCriticalStateBackup/writeCriticalBackup IPC failures used to escape as an
        // unhandled rejection — same honest-failure contract as runAutoBackupNow.
        this.$message.error(this.$t('statsE.SettingsModal.backupFail'))
      } finally { this.backingUp = false }
    },
    async loadAutoBackupList () {
      try {
        const r = await window.todoAPI.listAutoBackups(this.st.backupDir || '')
        this.autoBackupFiles = (r && r.files) || []
        // 主进程区分了「目录不存在(正常空态)」与「读取失败」:失败时不再静默清空,一行提示告知用户
        if (r && r.ok === false) this.$message.error(this.$t('statsH.SettingsModal.backupFailed') + ': ' + (r.error || ''))
        if (!this.autoBackupPick && this.autoBackupFiles.length) this.autoBackupPick = this.autoBackupFiles[0]
      } catch { this.autoBackupFiles = [] }
    },
    async restoreFromAutoBackup () {
      if (!this.autoBackupPick) return this.$message.info(this.$t('statsE.SettingsModal.autoRestoreEmpty'))
      await this.confirmDanger(this.$t('statsE.SettingsModal.autoRestoreConfirm', { f: this.autoBackupPick }), this.$t('statsH.SettingsModal.restoreTitle'), 'warning')
        .then(async () => {
          try {
            const r = await window.todoAPI.readAutoBackup(this.st.backupDir || '', this.autoBackupPick)
            // read-auto-backup 现在返回 { ok, text?, error? }:读取失败显式报错,不再与「文件不存在」混为空串
            if (!r || !r.ok) return this.$message.error(this.$t('statsE.SettingsModal.backupFileNotFoundMsg') + ((r && r.error) ? ': ' + r.error : ''))
            // Domain-2 review (2026-09-24): boolean return is checked — a failed pre-restore
            // snapshot means NO rollback point; warn loudly but let the user's confirmed restore
            // proceed (aborting on a warning would need its own confirmation round).
            if (!(await this.$store.dispatch('todo/writeEventBackup', 'restore'))) this.$message.warning(this.$t('statsE.SettingsModal.snapshotFailWarnMsg'))
            await this.applyRestoreDump(JSON.parse(r.text))
          } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        }).catch(() => {})
    },
    // dump.todoState 解析 + 版本守卫:schemaV 高于本版支持的备份静默误读=降级导入事故,显式报错
    parseTodoState (raw) {
      const td = typeof raw === 'string' ? JSON.parse(raw) : raw
      // B13 (2026-09-26): guard against the shared SCHEMA_V constant (mirror parseStampedSeg) —
      // the hardcoded literal `> 1` drifted from the single source the moment SCHEMA_V moves.
      if (td && Number(td.schemaV) > SCHEMA_V) throw new Error('schemaV ' + td.schemaV + ' > ' + SCHEMA_V + ' (backup from a newer app version)')
      return td || {}
    },
    // Review P2 (2026-09-22): shared schemaV guard over EVERY stamped segment. parseTodoState covered
    // only todoState — a newer-app backup's category/habits/filter/plan segments were restored
    // unchecked (silent downgrade misreads). Absent/0 schemaV = legacy v1, allowed.
    parseStampedSeg (raw) {
      const seg = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (seg && Number(seg.schemaV) > SCHEMA_V) throw new Error('schemaV ' + seg.schemaV + ' > ' + SCHEMA_V + ' (backup from a newer app version)')
      return seg || {}
    },
    // H8 (2026-09-12): honest completion toast — every failed segment is named instead of a
    // blanket "parse failed" after other segments already committed
    reportRestoreResult (n, failed) {
      if (failed && failed.length) this.$message.error(this.$t('statsE.SettingsModal.restorePartialFail', { n, s: failed.join(', ') }))
      else this.$message.success(this.$t('statsH.SettingsModal.restoredCount', { n }))
    },
    /** Shared restore pipeline for both paths (auto-backup file and critical-state): per-segment
     *  isolation — a failure in one (e.g. parseTodoState rejecting a newer schemaV) no longer
     *  aborts the rest AFTER earlier segments were already committed. The heaviest segment (todo
     *  rows) runs LAST; failed segments are reported honestly in the toast. */
    async applyRestoreDump (dump) {
      const b = (dump && dump.backup) || {}
      const failed = []
      const seg = (name, fn) => { try { fn() } catch (e) { console.error('[settings] restore segment failed: ' + name, e); failed.push(name) } }
      if (b.settingsState) seg('settings', () => this.$store.commit('settings/restore', JSON.parse(b.settingsState)))
      // setListRestore: backup-time tombstones must not win category LWW and re-delete peer-recovered
      // categories (round-6 P2) — live restored rows still take the fresh stamp (backup wins locally)
      if (b.categoryState) seg('category', () => { const c = this.parseStampedSeg(b.categoryState); if (c.list) this.$store.commit('category/setListRestore', c.list) })
      let habitCount = 0
      if (b.habitsState) seg('habits', () => {
        // Single writer via the store only: replaceAll already dual-writes LS+meta; writing LS directly from the component would create a second writer (dual-write ledger discipline)
        const hb = this.parseStampedSeg(b.habitsState)
        // F6 (round-2 P1 2026-09-21): force bypasses the stale-savedAt guard and persists the
        // restored blob to the DB meta row (reaching sync); count habits honestly in the report.
        if (hb && Array.isArray(hb.habits)) { this.$store.commit('habits/replaceAll', { ...hb, force: true }); habitCount = hb.habits.length }
      })
      let rows = []
      if (b.todoState) {
        try {
          const td = this.parseTodoState(b.todoState); (td.todoList || []).forEach(r => rows.push(restoreStampRow(r))); (td.recycleList || []).forEach(r => rows.push(restoreStampRow(r)))
          if (rows.length) await commitCommand("todo", "putMany", rows)
        } catch (e) { console.error('[settings] restore segment failed: todo', e); failed.push('todo'); rows = [] }
      }
      // 回收站行与专注账本同份同回(此前 UI 恢复只进 todoList,同一份 dump 走启动灾备却能全回——两端语义割裂)
      try { await this.restoreTomatoLedger(b) } catch (e) { console.error('[settings] restore segment failed: tomato', e); failed.push('tomato') }
      // D6-F14: saved filters + schedule chips ride the same dump (id-keyed idempotent re-put, like
      // the tomato ledger) — a JSON disaster restore used to wipe every smart list and plan chip
      try { await this.restoreSavedFilters(b) } catch (e) { console.error('[settings] restore segment failed: filters', e); failed.push('filters') }
      try { await this.restorePlanChips(b) } catch (e) { console.error('[settings] restore segment failed: planChips', e); failed.push('planChips') }
      try { await this.restoreMetaState(b) } catch (e) { console.error('[settings] restore segment failed: metaState', e); failed.push('metaState') }
      this.$store.dispatch('_rt/refreshFromDb')
      this.$store.dispatch('tomato/recordsReload').catch(e => console.error('[settings] tomato/recordsReload after restore failed:', e))
      this.reportRestoreResult(rows.length + habitCount, failed) // F6: habits counted honestly
    },
    // D6-F14: saved filters 回灌——按 id 幂等 re-put(filter.putMany upsert),随后以 DB 行表为准刷新内存列表
    // B2 (2026-09-26): rows are re-stamped fresh (restoreStampLww) so LAN LWW cannot self-revert the restore.
    async restoreSavedFilters (b) {
      if (!b.filterState) return
      const fseg = this.parseStampedSeg(b.filterState)
      const list = (Array.isArray(fseg.list) ? fseg.list : []).filter(f => f && f.id != null)
      if (list.length) {
        const now = Date.now()
        await commitCommand('filter', 'putMany', list.map(f => restoreStampLww(f, now)))
        this.$store.commit('filters/setList', await window.todoAPI.dbCall('filterList'))
      }
    },
    // D6-F14: schedule chips 回灌——行级幂等 re-put(plan.putMany upsert),缺 taskId/day/id 的行跳过不拖批
    // B2 (2026-09-26): chips are re-stamped fresh for the same LWW reason as filters.
    async restorePlanChips (b) {
      if (!b.planState) return
      const pseg = this.parseStampedSeg(b.planState)
      const chips = (Array.isArray(pseg.chips) ? pseg.chips : []).filter(c => c && c.id != null && c.taskId && c.day)
      if (chips.length) {
        const now = Date.now()
        await commitCommand('plan', 'putMany', chips.map(c => restoreStampLww(c, now)))
        try { window.dispatchEvent(new CustomEvent('day-plans-changed')) } catch { /* DayRail refresh is cosmetic */ }
      }
    },
    // metaState 回灌 (2026-09-26, meta-keys-omitted): repeat rules / tomato estimates / project
    // deadline+status+flag+milestones live only in the meta table — idempotent whole-key re-put
    // through the same 'meta','put' command door the habits blob uses, whitelist-filtered.
    async restoreMetaState (b) {
      if (!b.metaState) return
      const seg = this.parseStampedSeg(b.metaState)
      const entries = (Array.isArray(seg.entries) ? seg.entries : []).filter(e =>
        e && typeof e.key === 'string' && e.value != null && e.value !== '' &&
        META_RESTORE_PREFIXES.some(p => e.key.startsWith(p)))
      for (const e of entries) await commitCommand('meta', 'put', [e.key, e.value])
      if (entries.some(e => e.key.startsWith('tomatoEstimateState:'))) {
        // the per-task estimate cache is memoized — invalidate so the next read re-fetches from meta
        try { invalidateEstimateCache() } catch { /* degraded host */ }
      }
    },
    // 账本回灌:行表幂等 UPSERT,缺 tomatoId/endTime 的行跳过不拖批(与主进程 dbRecovery 同规则)
    async restoreTomatoLedger (b) {
      if (!b.tomatoRecords) return
      const recs = typeof b.tomatoRecords === 'string' ? JSON.parse(b.tomatoRecords) : b.tomatoRecords
      const ok = (Array.isArray(recs) ? recs : []).filter(r => r && r.tomatoId && r.endTime)
      if (ok.length) await commitCommand("tomato", "appendMany", ok)
    },
    restoreFromBackup () {
      this.confirmDanger(this.$t('statsE.SettingsModal.criticalRestoreConfirmMsg'), this.$t('statsH.SettingsModal.restoreTitle'), 'warning').then(async () => {
        // F2 (2026-09-24): the dispatch MUST be awaited — writeEventBackupCore's dump builder reads
        // the live state only after an internal IPC await, so an un-awaited dispatch raced the
        // applyRestoreDump commits below and the "pre-restore rollback snapshot" could capture
        // mid/post-restore state. Same contract as restoreFromAutoBackup and importFromCsv.
        // Domain-2 review (2026-09-24): the boolean return is now CHECKED — a failed pre-restore
        // snapshot means NO rollback point; warn loudly, let the confirmed restore proceed.
        if (!(await this.$store.dispatch('todo/writeEventBackup', 'restore'))) this.$message.warning(this.$t('statsE.SettingsModal.snapshotFailWarnMsg'))
        let txt = null
        try { txt = await window.todoAPI.readCriticalStateBackup() } catch (e) { return this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        if (!txt) return this.$message.error(this.$t('statsE.SettingsModal.backupFileNotFoundMsg'))
        try {
          await this.applyRestoreDump(JSON.parse(txt))
        } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
      }).catch(() => {})
    },
    async purgeRecycle () {
      const n = this.$store.state.todo.recycleList.length
      // Same strength as the recycle bin page: unified triple confirm confirmRecycleClear (previously only single confirm, inconsistent protection)
      try {
        await confirmRecycleClear(this, n)
        // dispatch must be awaited: the async purge can fail (db write error); success toast only after it resolves
        // QC r1: purgeAllRecycle now returns a success flag — it RESOLVES (not rejects) on IPC
        // failure, so the flag must be checked or the success toast fires on a failed purge.
        const ok = await this.$store.dispatch('todo/purgeAllRecycle')
        if (ok) this.$message.success(this.$t('statsC.RecycleBin.cleared', { n }))
        else this.$message.error(this.$t('statsE.SettingsModal.purgeFailedMsg'))
      } catch (e) {
        // Element confirm rejects with the 'cancel'/'close' string on user cancel — swallow those only
        if (e !== 'cancel' && e !== 'close') this.$message.error(this.$t('statsE.SettingsModal.purgeFailedMsg') + (e && e.message ? e.message : e))
      }
    },
    async purgeSeed () {
      try {
        const n = await window.todoAPI.dbCall('countSeedTodos')
        if (!n) return this.$message.info(this.$t('statsE.SettingsModal.noDemoDataMsg'))
        await this.confirmDanger(this.$t('statsH.SettingsModal.purgeSeedConfirm', { n }), this.$t('statsE.SettingsModal.clearDemoDataMsg'), 'warning')
        // B8 (2026-09-25): event snapshot BEFORE the purge, same channel + boolean contract as
        // import/restore above (writeEventBackup 'purge-seed' tags the evt- snapshot) — a demo-data
        // purge used to be the only destructive op with NO rollback point.
        if (!(await this.$store.dispatch('todo/writeEventBackup', 'purge-seed'))) this.$message.warning(this.$t('statsE.SettingsModal.snapshotFailWarnMsg'))
        await window.todoAPI.purgeSeedTodos()
        this.$store.dispatch('tomato/removeRecordsByIdPrefix', 'seed_')
        this.$store.dispatch('_rt/refreshFromDb')
        this.$message.success(this.$t('statsE.SettingsModal.demoDataClearedMsg'))
      } catch (e) {
        // Element confirm rejects with the 'cancel'/'close' string on user cancel — only those mean "cancelled";
        // anything else is a real failure (countSeed/purgeSeed/refresh) and must not be reported as a silent success
        if (e !== 'cancel' && e !== 'close') this.$message.error(this.$t('statsE.SettingsModal.purgeFailedMsg') + (e && e.message ? e.message : e))
      }
    }
  }
}
</script>
