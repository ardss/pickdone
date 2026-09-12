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
          <span class="tip">{{ autoBackupLastAt ? $t('statsE.SettingsModal.lastRunPrefix') + dfmt(autoBackupLastAt) : $t('statsH.SettingsModal.notRunYet') }} · {{ $t('statsH.SettingsModal.backupRetentionTip') }}</span>
        </div></div>
    </div>
    <div class="form">
      <div class="form-label">{{ $t('statsE.SettingsModal.dataManagementSection') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.exportExcelLabel') }}</span>
        <div class="form-item__control"><button class="primary mini-lg" :disabled="exporting" @click="exportXlsx">{{ $t('statsE.SettingsModal.exportXlsxBtn') }}</button></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.importCsvLabel') }}</span>
        <div class="form-item__control"><button class="mini-lg" :disabled="importing" @click="importFromCsv">{{ $t('statsE.SettingsModal.importCsvBtn') }}</button></div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.snapshotWriteLabel') }}</span>
        <div class="form-item__control">
          <button class="mini-lg" @click="writeBackupNow">{{ $t('statsE.SettingsModal.snapshotBackUpNowBtn') }}</button>
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
import { loadRuntime } from '../../store/runtimeState.js'

export default {
  name: 'SettingsDataTab',
  data () {
    return {
      exporting: false,
      importing: false,
      backupDirDefault: '',
      autoBackupLastAt: 0,
      backupDirShown: '',
      autoBackupFiles: [] as any,
      autoBackupPick: ''
    }
  },
  computed: {
    st () { return this.$store.state.settings },
    backupDirDisplay () { return this.backupDirShown || this.$t('statsE.SettingsModal.loadingPlaceholder') }
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
        const r = picked.report
        const msg = this.$t('statsE.SettingsModal.importPreviewMsg', { f: r.format, n: r.wouldImport, d: r.duplicates, s: r.skipped })
        try { await this.$confirm(msg, this.$t('statsH.SettingsModal.importTitle'), { type: 'info' }) } catch { return }
        const done = await window.todoAPI.importCsvRun(picked.file)
        await this.$store.dispatch('_rt/refreshFromDb')
        this.$message.success(this.$t('statsH.SettingsModal.importDone', { n: done.imported, d: done.duplicates }))
      } catch (e) {
        this.$message.error(this.$t('statsE.SettingsModal.importFailedMsg') + (e && e.message ? e.message : String(e)))
      } finally { this.importing = false }
    },
    async pickBackupDir () {
      const dir = await window.todoAPI.pickBackupDir()
      if (!dir) return
      this.set({ backupDir: dir })
      this.loadBackupDirDisplay()
      this.$message.success(this.$t('statsE.SettingsModal.backupLocationUpdatedMsg'))
    },
    resetBackupDir () {
      this.set({ backupDir: '' })
      this.loadBackupDirDisplay()
    },
    async loadBackupDirDisplay () {
      this.autoBackupLastAt = loadRuntime().autoBackupLastAt || 0
      try {
        const def = await window.todoAPI.getDefaultBackupDir()
        this.backupDirDefault = def
        this.backupDirShown = this.st.backupDir || def
      } catch {}
    },
    async runAutoBackupNow () {
      const ok = await this.$store.dispatch('todo/writeAutoBackup')
      this.autoBackupLastAt = loadRuntime().autoBackupLastAt || Date.now()
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
        const rows = list.map(t => [
          t.taskId,
          t.dayStart ? dayjs(t.dayStart).format(FMT.date) : '',
          catName(t.categoryId),
          t.taskContent, t.taskDescribe || '',
          (JSON.parse(t.subtasks || '[]')).map(s => (s.checked ? '[x] ' : '[ ] ') + s.text).join('\n'),
          t.complete ? this.$t('statsE.SettingsModal.yesLabel') : this.$t('statsH.SettingsModal.exportNo'),
          String(t.estimate || 0),
          t.reminderTime ? dayjs(t.reminderTime).format(FMT.dateTime) : '',
          (t.reminderOffsets || []).join(','),
          t.repeatId || '',
          t.deadlineTs ? dayjs(t.deadlineTs).format(FMT.date) : '',
          t.important === 1 || t.important === true ? 'Y' : 'N',
          t.urgent === 1 || t.urgent === true ? 'Y' : 'N',
          t.todoDifficultyLevel || 0
        ])
        const r = await window.todoAPI.exportXlsx({ fileName: this.$t('statsH.SettingsModal.exportFileName', { ts: dayjs().format('YYYYMMDD_HHmmss') }), rows })
        if (!r.canceled && !r.error) this.$message.success(this.$t('statsE.SettingsModal.exportedPrefix') + r.filePath)
        else if (r.error) this.$message.error(r.error)
      } finally { this.exporting = false }
    },
    writeBackupNow () {
      // Trigger a critical-state backup immediately and point out its location
      this.$store.dispatch('todo/writeCriticalBackup')
      setTimeout(() => {
        window.todoAPI.readCriticalStateBackup().then(txt => {
          this.$message.success(txt ? this.$t('statsE.SettingsModal.criticalBackupWrittenMsg') : this.$t('statsH.SettingsModal.backupFailed'))
        }).catch(() => { this.$message.error(this.$t('statsH.SettingsModal.backupFailed')) })
      }, 1200)
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
            const d = JSON.parse(r.text); const b = d.backup || {}
            await this.$store.dispatch('todo/writeEventBackup', 'restore')
            const rows = []
            if (b.todoState) { const td = this.parseTodoState(b.todoState); (td.todoList || []).forEach(r => rows.push(r)); (td.recycleList || []).forEach(r => rows.push(r)) }
            if (rows.length) await window.todoAPI.dbCall('upsertMany', rows)
            // 字段级对齐 critical 恢复:分类与专注账本同份同回,否则"恢复"后分类消失/专注账全丢(二轮深审 P1-2)
            if (b.categoryState) { const c = JSON.parse(b.categoryState); if (c.list) this.$store.commit('category/setList', c.list) }
            await this.restoreTomatoLedger(b)
            this.$store.dispatch('_rt/refreshFromDb')
            this.$store.dispatch('tomato/recordsReload').catch(e => console.error('[settings] tomato/recordsReload after restore failed:', e))
            this.$message.success(this.$t('statsH.SettingsModal.restoredCount', { n: rows.length }))
          } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        }).catch(() => {})
    },
    // dump.todoState 解析 + 版本守卫:schemaV 高于本版支持的备份静默误读=降级导入事故,显式报错
    parseTodoState (raw) {
      const td = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (td && Number(td.schemaV) > 1) throw new Error('schemaV ' + td.schemaV + ' > 1 (backup from a newer app version)')
      return td || {}
    },
    // 账本回灌:行表幂等 UPSERT,缺 tomatoId/endTime 的行跳过不拖批(与主进程 dbRecovery 同规则)
    async restoreTomatoLedger (b) {
      if (!b.tomatoRecords) return
      const recs = typeof b.tomatoRecords === 'string' ? JSON.parse(b.tomatoRecords) : b.tomatoRecords
      const ok = (Array.isArray(recs) ? recs : []).filter(r => r && r.tomatoId && r.endTime)
      if (ok.length) await window.todoAPI.dbCall('tomatoAppendMany', ok)
    },
    restoreFromBackup () {
      this.confirmDanger(this.$t('statsE.SettingsModal.criticalRestoreConfirmMsg'), this.$t('statsH.SettingsModal.restoreTitle'), 'warning').then(async () => {
        this.$store.dispatch('todo/writeEventBackup', 'restore')
        let txt = null
        try { txt = await window.todoAPI.readCriticalStateBackup() } catch (e) { return this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        if (!txt) return this.$message.error(this.$t('statsE.SettingsModal.backupFileNotFoundMsg'))
        try {
          const d = JSON.parse(txt); const b = d.backup || {}
          if (b.settingsState) this.$store.commit('settings/restore', JSON.parse(b.settingsState))
          if (b.categoryState) { const c = JSON.parse(b.categoryState); if (c.list) this.$store.commit('category/setList', c.list) }
          if (b.habitsState) {
            try {
              const hb = JSON.parse(b.habitsState)
              if (hb && Array.isArray(hb.habits)) {
                // Single writer via the store only: replaceAll already dual-writes LS+meta; writing LS directly from the component would create a second writer (dual-write ledger discipline)
                this.$store.commit('habits/replaceAll', hb)
              }
            } catch {}
          }
          const rows = []
          if (b.todoState) { const td = this.parseTodoState(b.todoState); (td.todoList || []).forEach(r => rows.push(r)); (td.recycleList || []).forEach(r => rows.push(r)) }
          if (rows.length) await window.todoAPI.dbCall('upsertMany', rows)
          // 回收站行与专注账本同份同回(此前 UI 恢复只进 todoList,同一份 dump 走启动灾备却能全回——两端语义割裂)
          await this.restoreTomatoLedger(b)
          this.$store.dispatch('_rt/refreshFromDb')
          this.$store.dispatch('tomato/recordsReload').catch(e => console.error('[settings] tomato/recordsReload after restore failed:', e))
          this.$message.success(this.$t('statsH.SettingsModal.restoredCount', { n: rows.length }))
        } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
      }).catch(() => {})
    },
    purgeRecycle () {
      const n = this.$store.state.todo.recycleList.length
      // Same strength as the recycle bin page: unified triple confirm confirmRecycleClear (previously only single confirm, inconsistent protection)
      confirmRecycleClear(this, n).then(() => {
        this.$store.dispatch('todo/purgeAllRecycle')
        this.$message.success(this.$t('statsC.RecycleBin.cleared', { n }))
      }).catch(() => {})
    },
    async purgeSeed () {
      try {
        const n = await window.todoAPI.dbCall('countSeedTodos')
        if (!n) return this.$message.info(this.$t('statsE.SettingsModal.noDemoDataMsg'))
        await this.confirmDanger(this.$t('statsH.SettingsModal.purgeSeedConfirm', { n }), this.$t('statsE.SettingsModal.clearDemoDataMsg'), 'warning')
        await window.todoAPI.purgeSeedTodos()
        this.$store.dispatch('tomato/removeRecordsByIdPrefix', 'seed_')
        this.$store.dispatch('_rt/refreshFromDb')
        this.$message.success(this.$t('statsE.SettingsModal.demoDataClearedMsg'))
      } catch (e) { /* cancelled */ }
    }
  }
}
</script>
