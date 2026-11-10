<script setup>
import { computed, onMounted, ref } from 'vue'
import { PdActionButton, PdEmptyState, PdTaskCard, PdProjectCard, PdWorkEpisodeCard } from '../../shared/ui/index.js'
import t from './i18n/zh-CN.js'
import { readAll, putRow, markDeleted, replaceAll, backupData, todayKey, dateInput, dayKey, newTask, newProject, newEpisode, episodeView } from './storage.js'
import { pairDesktop, createBridgeClient } from './sync/bridge-client.js'
import { mergePull, planPush, summarizePushResults } from './sync/sync-engine.js'

const tab = ref('today')
const theme = ref(localStorage.getItem('pickdone-web-theme') || 'light')
document.documentElement.dataset.theme = theme.value
function toggleTheme() { theme.value = theme.value === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme.value; localStorage.setItem('pickdone-web-theme', theme.value) }
const rows = ref({ tasks: [], projects: [], episodes: [] })
const ready = ref(false)
const error = ref('')
const notice = ref('')
const taskDraft = ref('')
const taskProject = ref(0)
const projectDraft = ref('')
const selectedProject = ref(0)
const editingTask = ref(null)
const editingProject = ref(null)
const editingEpisode = ref(null)
const episodeTask = ref('')
const episodeNote = ref('')
const episodeStart = ref(localDateTime(Date.now() - 30 * 60000))
const episodeEnd = ref(localDateTime(Date.now()))
const fileInput = ref(null)
const today = todayKey()
const activeTasks = computed(() => rows.value.tasks.filter(row => !row.deleted))
const activeProjects = computed(() => rows.value.projects.filter(row => !row.deleted && !row.isFolder))
const activeEpisodes = computed(() => rows.value.episodes.filter(row => !row.deleted && activeTasks.value.some(task => task.id === row.taskId)).sort((a, b) => b.startedAt - a.startedAt))
const todayTasks = computed(() => activeTasks.value.filter(row => Number(row.scheduledDay) === today).sort((a, b) => Number(a.complete) - Number(b.complete) || Number(a.sort) - Number(b.sort)))
const doneCount = computed(() => todayTasks.value.filter(row => row.complete).length)
const progress = computed(() => todayTasks.value.length ? Math.round(doneCount.value / todayTasks.value.length * 100) : 0)
const projectTasks = computed(() => activeTasks.value.filter(row => Number(row.categoryId) === Number(selectedProject.value)).sort((a, b) => Number(a.complete) - Number(b.complete) || Number(a.sort) - Number(b.sort)))
const dayLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
function localDateTime(ms) {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return date.toISOString().slice(0, 16)
}
function taskProjectName(task) { return activeProjects.value.find(project => project.id === Number(task.categoryId))?.name || t.noProject }
function taskName(id) { return activeTasks.value.find(task => task.id === id)?.content || id }
function formatTime(ms) { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms) }
function minutes(row) { return Math.max(0, Math.round((row.endedAt - row.startedAt) / 60000)) }
async function refresh() { rows.value = await readAll() }
async function run(action) {
  error.value = ''; notice.value = ''
  try { await action(); await refresh(); notice.value = t.saved }
  catch (cause) { error.value = t.error + cause.message }
}
onMounted(async () => {
  try { await refresh(); ready.value = true }
  catch (cause) { error.value = t.storageError + ' ' + cause.message }
})
async function addTask() {
  if (!taskDraft.value.trim()) { error.value = t.taskRequired; return }
  await run(async () => { await putRow('tasks', newTask(taskDraft.value, taskProject.value)); taskDraft.value = '' })
}
function startTask(task) { editingTask.value = { ...task, scheduledDayInput: dateInput(task.scheduledDay) } }
async function saveTask() {
  const draft = editingTask.value
  if (!draft?.content.trim()) { error.value = t.taskRequired; return }
  await run(async () => {
    await putRow('tasks', { ...draft, content: draft.content.trim(), categoryId: Number(draft.categoryId), scheduledDay: dayKey(draft.scheduledDayInput), updatedAt: Date.now(), version: Number(draft.version || 0) + 1 })
    editingTask.value = null
  })
}
async function toggleTask(task) {
  await run(() => putRow('tasks', { ...task, complete: task.complete ? 0 : 1, completedAt: task.complete ? 0 : Date.now(), updatedAt: Date.now(), version: Number(task.version || 0) + 1 }))
}
async function deleteTask(task) { if (confirm(t.deleteTask)) await run(() => markDeleted('tasks', task.id)) }
async function addProject() {
  if (!projectDraft.value.trim()) { error.value = t.projectRequired; return }
  await run(async () => { await putRow('projects', newProject(projectDraft.value, rows.value.projects)); projectDraft.value = '' })
}
async function saveProject() {
  if (!editingProject.value?.name.trim()) { error.value = t.projectRequired; return }
  await run(async () => { await putRow('projects', { ...editingProject.value, name: editingProject.value.name.trim(), updatedAt: Date.now() }); editingProject.value = null })
}
async function deleteProject(project) {
  if (!confirm(t.deleteProject)) return
  await run(async () => { await markDeleted('projects', project.id); if (selectedProject.value === project.id) selectedProject.value = 0 })
}
function resetEpisode() {
  editingEpisode.value = null; episodeTask.value = ''; episodeNote.value = ''
  episodeStart.value = localDateTime(Date.now() - 30 * 60000); episodeEnd.value = localDateTime(Date.now())
}
function startEpisode(row) {
  editingEpisode.value = episodeView(row)
  episodeTask.value = row.taskId; episodeNote.value = row.note || ''
  episodeStart.value = localDateTime(row.startedAt); episodeEnd.value = localDateTime(row.endedAt)
  tab.value = 'history'
}
async function saveEpisode() {
  if (!episodeTask.value || !episodeNote.value.trim()) { error.value = t.episodeRequired; return }
  const start = new Date(episodeStart.value).getTime(), end = new Date(episodeEnd.value).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { error.value = t.invalidTime; return }
  await run(async () => {
    const row = editingEpisode.value
      ? { ...editingEpisode.value, taskId: episodeTask.value, note: episodeNote.value.trim(), startedAt: start, endedAt: end, updatedAt: Date.now() }
      : newEpisode(episodeTask.value, episodeNote.value, start, end)
    delete row.episodeId; delete row.summary
    await putRow('episodes', row); resetEpisode()
  })
}
async function deleteEpisode(row) { if (confirm(t.deleteEpisode)) await run(() => markDeleted('episodes', row.id)) }
async function exportBackup() {
  try {
    const data = backupData(await readAll())
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = 'pickdone-web-backup-' + new Date().toISOString().slice(0, 10) + '.json'
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { error.value = t.error + cause.message }
}
async function importBackup(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || !confirm(t.restoreWarning)) return
  try { await replaceAll(JSON.parse(await file.text())); await refresh(); notice.value = t.restoreSuccess }
  catch (cause) { error.value = t.invalidFile + cause.message }
}

// ---- Desktop sync (one-shot pairing against the 127.0.0.1 bridge; credentials are short-lived) ----
const syncUrl = ref(sessionStorage.getItem('pickdone-sync-endpoint') || '')
const syncPairPayload = ref('')
const syncCreds = ref(JSON.parse(sessionStorage.getItem('pickdone-sync-creds') || 'null'))
const syncConflicts = ref([])
const syncBusy = ref(false)
const lastPullAt = ref(Number(sessionStorage.getItem('pickdone-sync-lastpull') || 0))
function saveCreds() {
  if (syncCreds.value) sessionStorage.setItem('pickdone-sync-creds', JSON.stringify(syncCreds.value))
  else sessionStorage.removeItem('pickdone-sync-creds')
}
function rememberEndpoint() {
  if (syncUrl.value) sessionStorage.setItem('pickdone-sync-endpoint', syncUrl.value.trim().replace(/\/+$/, ''))
  else sessionStorage.removeItem('pickdone-sync-endpoint')
}
function trimUrl() { return syncUrl.value.trim().replace(/\/+$/, '') }
function syncClient() {
  return createBridgeClient({ baseUrl: trimUrl(), credentials: syncCreds.value, deviceId: syncCreds.value?.deviceId })
}
async function withSync(action, failLabel, okNotice) {
  error.value = ''; notice.value = ''; syncConflicts.value = []
  syncBusy.value = true
  try {
    const conflicts = await action()
    await refresh()
    syncConflicts.value = conflicts || []
    notice.value = conflicts?.length ? (conflicts.length + ' ' + t.syncConflicts) : okNotice
  } catch (cause) { error.value = failLabel + cause.message }
  finally { syncBusy.value = false }
}
async function doSyncPair() {
  let payload
  try { payload = JSON.parse(syncPairPayload.value) } catch { error.value = t.syncInvalidPayload; return }
  if (!payload || !payload.challengeId || payload.code == null || !payload.deviceId) { error.value = t.syncInvalidPayload; return }
  error.value = ''; notice.value = ''
  syncBusy.value = true
  try {
    syncCreds.value = await pairDesktop({ baseUrl: trimUrl(), challengeId: payload.challengeId, code: payload.code, deviceId: payload.deviceId })
    rememberEndpoint(); saveCreds(); notice.value = t.syncPaired + ' (' + (syncCreds.value.scope === 'WRITE' ? t.syncScopeWrite : t.syncScopeRead) + ')'
  } catch (cause) { error.value = t.syncPairFailed + cause.message }
  finally { syncBusy.value = false }
}
async function doSyncPull() {
  await withSync(async () => {
    const result = await syncClient().pull()
    const local = await readAll()
    const { changes, conflicts } = mergePull(local, result.entities)
    for (const change of changes) await putRow(change.store, change.row)
    lastPullAt.value = Date.now(); sessionStorage.setItem('pickdone-sync-lastpull', String(lastPullAt.value))
    return conflicts.map(c => ({ ...c, title: c.incoming?.content || c.incoming?.name || c.incoming?.note || c.id }))
  }, t.syncPullFailed, t.syncPullDone)
}
async function doSyncPush() {
  await withSync(async () => {
    const local = await readAll()
    const { ops } = planPush(local)
    if (!ops.length) return []
    const result = await syncClient().push(ops)
    return summarizePushResults(result.results).conflicts
  }, t.syncPushFailed, t.syncPushDone)
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark">✓</div><div><strong>{{ t.brand }}</strong><small>WEB EDITION</small></div></div>
      <p class="side-caption">WORKSPACE</p>
      <nav aria-label="主导航">
        <button :class="{ selected: tab === 'today' }" @click="tab = 'today'"><span class="nav-icon">◫</span>{{ t.today }}<span class="nav-count">{{ todayTasks.length }}</span></button>
        <button :class="{ selected: tab === 'projects' }" @click="tab = 'projects'"><span class="nav-icon">▦</span>{{ t.projects }}<span class="nav-count">{{ activeProjects.length }}</span></button>
        <button :class="{ selected: tab === 'history' }" @click="tab = 'history'"><span class="nav-icon">◷</span>{{ t.history }}</button>
        <button :class="{ selected: tab === 'sync' }" @click="tab = 'sync'"><span class="nav-icon">⇄</span>{{ t.sync }}</button>
      </nav>
      <div class="side-bottom"><button :class="{ selected: tab === 'backup' }" @click="tab = 'backup'"><span class="nav-icon">⇩</span>{{ t.backup }}</button><p>{{ t.syncNote }}</p></div>
    </aside>
    <div class="main-wrap">
      <header class="topbar"><div class="topbar-breadcrumb">PICKDONE <span>/</span> {{ tab === 'today' ? t.today : tab === 'projects' ? t.projects : tab === 'history' ? t.history : tab === 'sync' ? t.sync : t.backup }}</div><div class="topbar-actions"><button class="theme-toggle" type="button" @click="toggleTheme">{{ theme === "dark" ? t.lightTheme : t.darkTheme }}</button><div class="storage-pill"><span class="status-dot"></span>{{ t.local }}</div></div></header>
      <main>
        <div v-if="error" class="message error" role="alert">{{ error }}</div>
        <div v-if="notice" class="message success" role="status">{{ notice }}</div>
        <div v-if="!ready" class="loading">Loading…</div>
        <template v-else-if="tab === 'today'">
          <section class="hero"><div><span class="eyebrow">{{ dayLabel }}</span><h1>{{ t.todayOverview }}</h1><p>{{ t.subtitle }}</p></div><div class="hero-orbit"><span>{{ progress }}<small>%</small></span><div>{{ t.progress }}</div></div></section>
          <div class="section-head"><div><span class="eyebrow">TODAY'S FOCUS</span><h2>{{ t.today }} <span class="muted-count">{{ todayTasks.length }}</span></h2></div><span class="section-meta">{{ doneCount }} / {{ todayTasks.length }} {{ t.done }}</span></div>
          <form class="quick-add" @submit.prevent="addTask"><span class="plus">＋</span><input v-model="taskDraft" :placeholder="t.taskPlaceholder" :aria-label="t.taskPlaceholder" required><select v-model.number="taskProject" :aria-label="t.selectProject"><option :value="0">{{ t.noProject }}</option><option v-for="project in activeProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select><PdActionButton tone="primary" type="submit">{{ t.addTask }}</PdActionButton></form>
          <PdEmptyState v-if="!todayTasks.length" class="empty" :title="t.noTasks" :description="t.noTasksDetail"><template #icon>&#10022;</template></PdEmptyState>
          <div v-else class="task-list"><PdTaskCard v-for="task in todayTasks" :key="task.id" class="task-row" :class="{ completed: task.complete }" :done="Boolean(task.complete)"><button class="check" :aria-label="task.complete ? t.active : t.done" @click="toggleTask(task)">{{ task.complete ? '✓' : '' }}</button><div class="task-main"><strong>{{ task.content }}</strong><div class="task-meta"><span>{{ taskProjectName(task) }}</span><span v-if="task.description">· {{ task.description }}</span></div></div><button class="text-button" @click="startTask(task)">{{ t.edit }}</button><button class="icon-button" :aria-label="t.remove" @click="deleteTask(task)">×</button></PdTaskCard></div>
        </template>
        <template v-else-if="tab === 'projects'">
          <div class="page-heading"><span class="eyebrow">ORGANIZE YOUR WORK</span><h1>{{ t.projects }}</h1><p>{{ t.projectEmptyDetail }}</p></div>
          <div class="project-layout"><div class="project-column"><form class="quick-add project-add" @submit.prevent="addProject"><input v-model="projectDraft" :placeholder="t.projectName" :aria-label="t.projectName" required><PdActionButton tone="primary" type="submit">{{ t.addProject }}</PdActionButton></form><PdEmptyState v-if="!activeProjects.length" class="empty compact" :title="t.projectEmpty"><template #icon>&#9638;</template></PdEmptyState><PdProjectCard v-for="project in activeProjects" :key="project.id" class="project-card" :class="{ current: selectedProject === project.id }" role="button" tabindex="0" @click="selectedProject = project.id" @keydown.enter="selectedProject = project.id"><span class="project-color"></span><span class="project-card-name">{{ project.name }}<small>{{ activeTasks.filter(task => Number(task.categoryId) === project.id).length }} {{ t.tasks }}</small></span><span class="project-arrow">→</span></PdProjectCard></div><div class="project-detail"><template v-if="activeProjects.find(project => project.id === selectedProject)"><div class="detail-head"><div><span class="eyebrow">PROJECT SPACE</span><h2>{{ activeProjects.find(project => project.id === selectedProject).name }}</h2></div><div><button class="text-button" @click="editingProject = { ...activeProjects.find(project => project.id === selectedProject) }">{{ t.edit }}</button><button class="text-button danger" @click="deleteProject(activeProjects.find(project => project.id === selectedProject))">{{ t.remove }}</button></div></div><p class="section-meta">{{ projectTasks.length }} {{ t.tasks }}</p><PdEmptyState v-if="!projectTasks.length" class="empty compact" :title="t.noTasks" /><PdTaskCard v-for="task in projectTasks" :key="task.id" class="task-row" :done="Boolean(task.complete)"><button class="check" :aria-label="task.complete ? t.active : t.done" @click="toggleTask(task)">{{ task.complete ? '✓' : '' }}</button><div class="task-main"><strong>{{ task.content }}</strong><div class="task-meta">{{ dateInput(task.scheduledDay) }}</div></div><button class="text-button" @click="startTask(task)">{{ t.edit }}</button><button class="icon-button" :aria-label="t.remove" @click="deleteTask(task)">×</button></PdTaskCard></template><PdEmptyState v-else class="empty" :title="t.projectTasks" :description="t.projectEmptyDetail"><template #icon>&#8594;</template></PdEmptyState></div></div>
        </template>
        <template v-else-if="tab === 'history'">
          <div class="page-heading"><span class="eyebrow">WORK JOURNAL</span><h1>{{ t.historyTitle }}</h1><p>{{ t.historyIntro }}</p></div>
          <div class="history-layout"><form class="episode-form card" @submit.prevent="saveEpisode"><h2>{{ editingEpisode ? t.editEpisode : t.addEpisode }}</h2><label>{{ t.chooseTask }}<select v-model="episodeTask" required><option value="" disabled>{{ t.chooseTask }}</option><option v-for="task in activeTasks" :key="task.id" :value="task.id">{{ task.content }}</option></select></label><div class="form-pair"><label>{{ t.started }}<input v-model="episodeStart" type="datetime-local" required></label><label>{{ t.ended }}<input v-model="episodeEnd" type="datetime-local" required></label></div><label>{{ t.summary }}<textarea v-model="episodeNote" :placeholder="t.summaryPlaceholder" rows="5" required></textarea></label><div class="form-actions"><button v-if="editingEpisode" type="button" class="text-button" @click="resetEpisode">{{ t.cancel }}</button><PdActionButton tone="primary" type="submit">{{ editingEpisode ? t.save : t.addEpisode }}</PdActionButton></div></form><div class="history-feed"><div class="section-head"><h2>{{ t.history }} <span class="muted-count">{{ activeEpisodes.length }}</span></h2></div><PdEmptyState v-if="!activeEpisodes.length" class="empty compact" :title="t.noEpisodes" :description="t.noEpisodesDetail"><template #icon>&#9687;</template></PdEmptyState><PdWorkEpisodeCard v-for="episode in activeEpisodes" :key="episode.id" class="episode-card"><div class="episode-top"><span class="episode-date">{{ formatTime(episode.startedAt) }}</span><span class="episode-duration">{{ minutes(episode) }} {{ t.duration }}</span></div><h3>{{ taskName(episode.taskId) }}</h3><p>{{ episode.note }}</p><div class="episode-actions"><button class="text-button" @click="startEpisode(episode)">{{ t.edit }}</button><button class="text-button danger" @click="deleteEpisode(episode)">{{ t.remove }}</button></div></PdWorkEpisodeCard></div></div>
        </template>
        <template v-else-if="tab === 'sync'">
          <div class="page-heading"><span class="eyebrow">PAIRED DESKTOP SYNC</span><h1>{{ t.syncTitle }}</h1><p>{{ t.syncIntro }}</p></div>
          <div class="sync-layout">
            <form class="card sync-card" @submit.prevent="doSyncPair">
              <h2>{{ t.syncPairBtn }}</h2>
              <label>{{ t.syncEndpoint }}<input v-model="syncUrl" type="url" required :placeholder="t.syncEndpointHint"></label>
              <label>{{ t.syncPairPayload }}<textarea v-model="syncPairPayload" rows="4" placeholder='{"challengeId":"…","code":"123456","deviceId":"web-1"}'></textarea></label>
              <div class="form-actions"><PdActionButton tone="primary" type="submit" :disabled="syncBusy">{{ t.syncPairBtn }}</PdActionButton></div>
            </form>
            <div class="card sync-card">
              <h2>{{ t.sync }}</h2>
              <p class="sync-state">
                <span v-if="syncCreds">{{ t.syncPaired }} · {{ syncCreds.scope === 'WRITE' ? t.syncScopeWrite : t.syncScopeRead }} · {{ t.syncLastPull }} {{ lastPullAt ? formatTime(lastPullAt) : t.syncNever }}</span>
                <span v-else>{{ t.syncNotPaired }}</span>
              </p>
              <div class="form-actions">
                <PdActionButton tone="primary" :disabled="syncBusy || !syncCreds" @click="doSyncPull">{{ t.syncPullBtn }}</PdActionButton>
                <PdActionButton tone="secondary" :disabled="syncBusy || !syncCreds" @click="doSyncPush">{{ t.syncPushBtn }}</PdActionButton>
              </div>
              <ul v-if="syncConflicts.length" class="sync-conflicts">
                <li v-for="c in syncConflicts" :key="c.store + ':' + c.id">{{ c.title }} · {{ c.verdict }}</li>
              </ul>
            </div>
          </div>
        </template>
        <template v-else><div class="page-heading"><span class="eyebrow">DATA & PORTABILITY</span><h1>{{ t.backup }}</h1><p>{{ t.backupIntro }}</p></div><div class="backup-card card"><div class="backup-icon">⇩</div><div><h2>{{ t.backupTitle }}</h2><p>{{ t.backupIntro }}</p><p class="sync-note">{{ t.syncNote }}</p><div class="backup-actions"><PdActionButton tone="primary" @click="exportBackup">{{ t.export }}</PdActionButton><PdActionButton tone="secondary" @click="fileInput.click()">{{ t.import }}</PdActionButton><input ref="fileInput" type="file" accept=".json,application/json" hidden @change="importBackup"></div></div></div></template>
      </main>
      <footer>{{ t.footer }}</footer>
    </div>
    <div v-if="editingTask || editingProject" class="modal-backdrop" @click.self="editingTask = null; editingProject = null"><form v-if="editingTask" class="modal card" @submit.prevent="saveTask"><div class="modal-head"><h2>{{ t.editTask }}</h2><button type="button" class="icon-button" :aria-label="t.cancel" @click="editingTask = null">×</button></div><label>{{ t.taskDetails }}<input v-model="editingTask.content" required></label><label>{{ t.description }}<textarea v-model="editingTask.description" :placeholder="t.descriptionPlaceholder" rows="4"></textarea></label><div class="form-pair"><label>{{ t.project }}<select v-model.number="editingTask.categoryId"><option :value="0">{{ t.noProject }}</option><option v-for="project in activeProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>{{ t.schedule }}<input v-model="editingTask.scheduledDayInput" type="date"></label></div><div class="form-actions"><button type="button" class="secondary" @click="editingTask = null">{{ t.cancel }}</button><PdActionButton tone="primary" type="submit">{{ t.save }}</PdActionButton></div></form><form v-else class="modal card" @submit.prevent="saveProject"><div class="modal-head"><h2>{{ t.edit }}{{ t.project }}</h2><button type="button" class="icon-button" :aria-label="t.cancel" @click="editingProject = null">×</button></div><label>{{ t.projectName }}<input v-model="editingProject.name" required></label><div class="form-actions"><button type="button" class="secondary" @click="editingProject = null">{{ t.cancel }}</button><PdActionButton tone="primary" type="submit">{{ t.save }}</PdActionButton></div></form></div>
  </div>
</template>
