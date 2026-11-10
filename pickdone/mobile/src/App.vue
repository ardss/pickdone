<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { openRepository } from './repository'
import { pairDesktop, createBridgeSession } from './sync/pair-client.js'
import { mergePull, planPush, summarizePushResults } from './sync/sync-cycle.js'
import { classifyFirstScreen } from './firstscreen.js'
import copy from './i18n/zh-CN.js'
import logoUrl from '../../assets/img/favicon.svg'
import { PdActionButton, PdEmptyState, PdStatusChip, PdTaskCard, PdProjectCard, PdWorkEpisodeCard } from '../../shared/ui/index.js'

const repo = ref(null)
const booting = ref(true)
const tasks = ref([])
const projects = ref([])
const episodes = ref([])
const tab = ref('today')
const error = ref('')
const editor = ref('')
const taskForm = ref({ id: '', content: '', description: '', categoryId: 0, scheduledDay: 0, complete: 0 })
const projectName = ref('')
const episodeForm = ref({ taskId: '', startedAt: '', endedAt: '', note: '' })
const today = Number(new Date().toLocaleDateString('en-CA').replaceAll('-', ''))
const dateTitle = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
const projectNameById = id => projects.value.find(project => project.id === id)?.name || copy.inbox
const todayTasks = computed(() => tasks.value.filter(task => !task.complete && (!task.scheduledDay || task.scheduledDay <= today)).sort((a, b) => b.updatedAt - a.updatedAt))
const completeTasks = computed(() => tasks.value.filter(task => task.complete).sort((a, b) => b.updatedAt - a.updatedAt))
const sortedEpisodes = computed(() => [...episodes.value].sort((a, b) => b.startedAt - a.startedAt))

// ---- G2 four-zone cockpit state (ux-contract §4/§5) ----
const DEVICE_ID = 'android-1'
const showAllPush = ref(false)
const lastSyncAt = ref(Number(localStorage.getItem('pickdone.lastSyncAt') || 0))
const online = ref(navigator.onLine)
const goOnline = () => { online.value = true }
const goOffline = () => { online.value = false }
const cockPit = computed(() => classifyFirstScreen({
  tasks: tasks.value,
  episodes: episodes.value,
  conflicts: syncConflicts.value,
  syncError: lastSyncError.value,
  lastSyncAt: lastSyncAt.value,
  today,
  deviceId: DEVICE_ID,
  showAll: showAllPush.value,
}))
const lastSyncText = computed(() => cockPit.value.blocked.lastSyncAt
  ? copy.lastSyncLabel + ' ' + new Date(cockPit.value.blocked.lastSyncAt).toLocaleString('zh-CN')
  : copy.neverSynced)

async function refresh() {
  tasks.value = await repo.value.tasks()
  projects.value = await repo.value.projects()
  episodes.value = await repo.value.episodes()
}
async function action(work) {
  error.value = ''
  try { await work(); await refresh() } catch (cause) { error.value = cause.message || String(cause) }
}
onMounted(async () => {
  window.addEventListener('online', goOnline)
  window.addEventListener('offline', goOffline)
  try { repo.value = await openRepository(); await refresh() } catch (cause) { error.value = cause.message || String(cause) }
  booting.value = false
})
onUnmounted(() => {
  window.removeEventListener('online', goOnline)
  window.removeEventListener('offline', goOffline)
})

// ---- Pull-to-refresh: one pass refreshes all four zone inputs (G8) ----
const ptrActive = ref(false)
let ptrStartY = 0
function ptrTouchStart(event) { ptrStartY = event.touches[0].clientY }
function ptrTouchMove(event) {
  ptrActive.value = window.scrollY <= 0 && event.touches[0].clientY - ptrStartY > 70
}
function ptrTouchEnd() {
  if (!ptrActive.value) return
  ptrActive.value = false
  action(refresh)
}

// ---- Paired-desktop sync. Credentials live IN MEMORY ONLY (cleared when the app restarts);
// ---- OS secure storage (Keystore) is the follow-up home. The endpoint is never guessed: it
// ---- is whatever address the desktop pairing surface displays (loopback or controlled LAN).
const syncEndpoint = ref('')
const syncPayload = ref('')
const syncCreds = ref(null)
const syncConflicts = ref([])
const syncBusy = ref(false)
const syncNotice = ref('')
const lastSyncError = ref('')
function trimSyncUrl() { return syncEndpoint.value.trim().replace(/\/+$/, '') }
async function syncAction(work) {
  error.value = ''; syncNotice.value = ''; syncConflicts.value = []
  syncBusy.value = true
  try {
    const conflicts = await work()
    await refresh()
    syncConflicts.value = conflicts || []
    lastSyncError.value = ''
    lastSyncAt.value = Date.now()
    localStorage.setItem('pickdone.lastSyncAt', String(lastSyncAt.value))
    syncNotice.value = conflicts?.length ? (conflicts.length + ' ' + copy.syncConflicts) : copy.syncDone
  } catch (cause) {
    error.value = cause.message || String(cause)
    lastSyncError.value = error.value
  }
  finally { syncBusy.value = false }
}
async function doSyncPair() {
  let payload
  try { payload = JSON.parse(syncPayload.value) } catch { error.value = copy.syncInvalidPayload; return }
  if (!payload?.challengeId || payload.code == null || !payload.deviceId) { error.value = copy.syncInvalidPayload; return }
  await syncAction(async () => {
    syncCreds.value = await pairDesktop({ baseUrl: trimSyncUrl(), challengeId: payload.challengeId, code: payload.code, deviceId: payload.deviceId })
    syncNotice.value = copy.syncPairedState + ' (' + (syncCreds.value.scope === 'WRITE' ? copy.syncScopeWrite : copy.syncScopeRead) + ')'
    return []
  })
}
async function doSyncPull() {
  await syncAction(async () => {
    const session = createBridgeSession({ baseUrl: trimSyncUrl(), credentials: syncCreds.value, deviceId: syncCreds.value?.deviceId })
    const result = await session.pull()
    const raw = { todos: await repo.value.rawAll('todos'), categories: await repo.value.rawAll('categories'), work_episodes: await repo.value.rawAll('work_episodes') }
    const { changes, conflicts } = mergePull(raw, result.entities)
    for (const change of changes) await repo.value.applyPulled(change.entity, change.row)
    return conflicts.map(c => ({ ...c, title: c.incoming?.content || c.incoming?.name || c.incoming?.note || c.id }))
  })
}
async function doSyncPush() {
  await syncAction(async () => {
    const session = createBridgeSession({ baseUrl: trimSyncUrl(), credentials: syncCreds.value, deviceId: syncCreds.value?.deviceId })
    const raw = { todos: await repo.value.rawAll('todos'), categories: await repo.value.rawAll('categories'), work_episodes: await repo.value.rawAll('work_episodes') }
    const { ops } = planPush(raw)
    if (!ops.length) return []
    const result = await session.push(ops)
    return summarizePushResults(result.results).conflicts
  })
}
async function retryLastSync() {
  if (!syncCreds.value || !trimSyncUrl()) { syncNotice.value = copy.syncNotPaired; return }
  await doSyncPull()
}
function newTask() {
  taskForm.value = { id: '', content: '', description: '', categoryId: 0, scheduledDay: today, complete: 0 }
  editor.value = 'task'
}
function editTask(task) { taskForm.value = { ...task }; editor.value = 'task' }
async function saveTask() {
  await action(() => repo.value.saveTask(taskForm.value))
  if (!error.value) editor.value = ''
}
async function toggleTask(task) {
  await action(() => repo.value.saveTask({ ...task, complete: task.complete ? 0 : 1, completedAt: task.complete ? 0 : Date.now() }))
}
async function saveProject() {
  await action(() => repo.value.saveProject({ name: projectName.value }))
  if (!error.value) { projectName.value = ''; editor.value = '' }
}
function newEpisode(task) {
  const now = new Date()
  const earlier = new Date(now.getTime() - 30 * 60 * 1000)
  const local = value => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  episodeForm.value = { taskId: task.id, startedAt: local(earlier), endedAt: local(now), note: '' }
  editor.value = 'episode'
}
async function saveEpisode() {
  const value = episodeForm.value
  await action(() => repo.value.saveEpisode({ taskId: value.taskId, startedAt: new Date(value.startedAt).getTime(), endedAt: new Date(value.endedAt).getTime(), note: value.note }))
  if (!error.value) editor.value = ''
}
const duration = episode => Math.round((episode.endedAt - episode.startedAt) / 60000)
</script>

<template>
  <div class="app-shell" @touchstart="ptrTouchStart" @touchmove="ptrTouchMove" @touchend="ptrTouchEnd">
    <header class="masthead">
      <div class="brand"><img class="brand-mark" :src="logoUrl" alt="" /><span>PickDone</span></div>
      <PdStatusChip class="local-badge" tone="brand">{{ copy.localRecord }}</PdStatusChip>
    </header>
    <div v-if="!online" class="offline-banner" role="status">{{ copy.offlineBanner }}</div>
    <div v-if="ptrActive" class="ptr-indicator" aria-hidden="true">↓</div>
    <main>
      <div v-if="booting" class="cockpit-skeleton" aria-hidden="true">
        <div class="skel-line w60"></div><div class="skel-line w90"></div><div class="skel-line w80"></div><div class="skel-line w40"></div>
      </div>
      <template v-else>
      <div v-if="error" class="error" role="alert">{{ error }}</div>
      <section v-if="tab === 'today'">
        <div class="eyebrow">{{ copy.cockpitEyebrow }} · {{ dateTitle }}</div>
        <h1>{{ copy.todaySlogan }}</h1>
        <PdActionButton class="primary-add" block @click="newTask"><span>＋</span> {{ copy.addTask }}</PdActionButton>

        <!-- Zone 1: push-now (待推进) -->
        <div class="zone-heading"><h2>{{ copy.zonePush }}</h2><PdStatusChip>{{ cockPit.push.total }}</PdStatusChip></div>
        <PdEmptyState v-if="!cockPit.push.total" class="empty" :description="copy.pushEmpty" />
        <PdTaskCard v-for="row in cockPit.push.rows" :key="row.id" class="task-card zone-row">
          <button class="check" type="button" :aria-label="copy.complete + row.task.content" @click="toggleTask(row.task)"></button>
          <button class="task-main" type="button" @click="editTask(row.task)"><strong>{{ row.task.content }}</strong><small><span class="project-dot inline-dot" :style="{ background: projects.find(p => p.id === row.task.categoryId)?.color || 'var(--pd-muted)' }"></span>{{ projectNameById(row.task.categoryId) }}</small><small v-if="row.nextAction" class="next-action">{{ copy.nextActionLabel }}：{{ row.nextAction }}</small></button>
          <PdActionButton class="mini" tone="quiet" type="button" :aria-label="copy.record + row.task.content + copy.recordSuffix" @click="newEpisode(row.task)">◷</PdActionButton>
        </PdTaskCard>
        <button v-if="cockPit.push.hidden" class="zone-showall" type="button" @click="showAllPush = true">{{ copy.zoneShowAll }} ({{ cockPit.push.total }})</button>
        <button v-else-if="showAllPush && cockPit.push.total > 5" class="zone-showall" type="button" @click="showAllPush = false">{{ copy.zoneShowLess }}</button>

        <!-- Zone 2: waiting-on-me (待我接手) -->
        <div class="zone-heading"><h2>{{ copy.zoneWaiting }}</h2><PdStatusChip>{{ cockPit.waiting.rows.length }}</PdStatusChip></div>
        <p v-if="!cockPit.waiting.rows.length" class="zone-zero">{{ copy.waitingEmpty }}<span class="zone-gap-note">{{ copy.waitingGapNote }}</span></p>
        <PdTaskCard v-for="row in cockPit.waiting.rows" :key="row.id" class="task-card zone-row">
          <span class="project-dot" :style="{ background: 'var(--pd-brand)' }"></span>
          <button class="task-main" type="button" @click="editTask(row.task)"><strong>{{ row.task.content }}</strong><small>{{ copy.zoneWaiting }} ← {{ row.from }}</small><small v-if="row.note" class="next-action">{{ row.note }}</small></button>
          <PdActionButton class="mini takeover" type="button" @click="editTask(row.task)">{{ copy.takeOver }}</PdActionButton>
        </PdTaskCard>

        <!-- Zone 3: agent-working (Agent 处理中) -->
        <div class="zone-heading"><h2>{{ copy.zoneAgent }}</h2><PdStatusChip>{{ cockPit.agent.rows.length }}</PdStatusChip></div>
        <p v-if="!cockPit.agent.rows.length" class="zone-zero">{{ copy.agentEmpty }}</p>
        <button v-for="row in cockPit.agent.rows" :key="row.id" class="agent-row" type="button" @click="tab = 'history'">
          <span class="agent-dot" aria-hidden="true">◆</span>
          <span class="agent-main"><strong>{{ tasks.find(task => task.id === row.episode.taskId)?.content || copy.removedTask }}</strong><small>{{ row.agentId }} · {{ copy.agentStarted }} {{ new Date(row.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}<template v-if="row.note"> · {{ row.note }}</template></small></span>
          <span class="agent-open">{{ copy.openTimeline }}</span>
        </button>

        <!-- Zone 4: blocked/conflict (阻塞/冲突) -->
        <div class="zone-heading"><h2>{{ copy.zoneBlocked }}</h2><PdStatusChip :tone="cockPit.blocked.rows.length ? 'danger' : 'brand'">{{ cockPit.blocked.rows.length }}</PdStatusChip></div>
        <p v-if="cockPit.blocked.healthy" class="zone-zero healthy">✓ {{ copy.noBlockers }} {{ lastSyncText }}</p>
        <div v-for="row in cockPit.blocked.rows" :key="row.id" class="blocked-row">
          <span class="blocker-text">{{ row.kind === 'conflict' ? row.title + '（' + row.verdict + '）' : row.title }}</span>
          <PdActionButton class="mini blocker-action" tone="quiet" type="button" @click="row.action === 'resolve-conflict' ? (tab = 'sync') : retryLastSync()">{{ row.action === 'resolve-conflict' ? copy.resolveConflict : copy.retrySync }}</PdActionButton>
        </div>

        <div v-if="completeTasks.length" class="section-heading completed-heading"><h2>{{ copy.completed }}</h2><PdStatusChip>{{ completeTasks.length }}</PdStatusChip></div>
        <PdTaskCard v-for="task in completeTasks.slice(0, 10)" :key="task.id" class="task-card done" :done="true">
          <button class="check checked" type="button" :aria-label="copy.restore + task.content" @click="toggleTask(task)">✓</button>
          <button class="task-main" type="button" @click="editTask(task)"><strong>{{ task.content }}</strong><small>{{ projectNameById(task.categoryId) }}</small></button>
        </PdTaskCard>
      </section>
      <section v-else-if="tab === 'projects'">
        <div class="eyebrow">{{ copy.yourSpace }}</div><h1>{{ copy.projects }}</h1><p class="intro">{{ copy.projectsIntro }}</p>
        <PdActionButton class="primary-add" block @click="editor = 'project'"><span>＋</span> {{ copy.newProject }}</PdActionButton>
        <PdEmptyState v-if="!projects.length" class="empty" :description="copy.projectsEmpty" />
        <PdProjectCard v-for="project in projects" :key="project.id" class="project-card">
          <span class="project-dot" :style="{ background: project.color }"></span>
          <div><strong>{{ project.name }}</strong><small>{{ tasks.filter(task => task.categoryId === project.id && !task.complete).length }} {{ copy.pendingCount }}</small></div>
        </PdProjectCard>
      </section>
      <section v-else-if="tab === 'sync'">
        <div class="eyebrow">{{ copy.syncEyebrow }}</div><h1>{{ copy.syncTitle }}</h1><p class="intro">{{ copy.syncIntro }}</p>
        <div class="sync-card">
          <label>{{ copy.syncEndpoint }}<input v-model="syncEndpoint" type="url" :placeholder="copy.syncEndpointHint" /></label>
          <label>{{ copy.syncPairPayload }}<textarea v-model="syncPayload" rows="3" placeholder='{"challengeId":"…","code":"123456","deviceId":"android-1"}'></textarea></label>
          <div class="sync-actions">
            <PdActionButton :disabled="syncBusy" @click="doSyncPair">{{ copy.syncPairBtn }}</PdActionButton>
            <PdActionButton :disabled="syncBusy || !syncCreds" @click="doSyncPull">{{ copy.syncPullBtn }}</PdActionButton>
            <PdActionButton :disabled="syncBusy || !syncCreds" @click="doSyncPush">{{ copy.syncPushBtn }}</PdActionButton>
          </div>
          <p class="sync-state">
            <span v-if="syncCreds">{{ copy.syncPairedState }} · {{ syncCreds.scope === 'WRITE' ? copy.syncScopeWrite : copy.syncScopeRead }}</span>
            <span v-else>{{ copy.syncNotPaired }}</span>
            <span v-if="syncNotice">{{ syncNotice }}</span>
          </p>
          <ul v-if="syncConflicts.length" class="sync-conflicts">
            <li v-for="c in syncConflicts" :key="c.entity + ':' + c.id">{{ c.title }} · {{ c.verdict }}</li>
          </ul>
        </div>
      </section>
      <section v-else>
        <div class="eyebrow">{{ copy.historyEyebrow }}</div><h1>{{ copy.history }}</h1><p class="intro">{{ copy.historyIntro }}</p>
        <PdEmptyState v-if="!sortedEpisodes.length" class="empty" :description="copy.historyEmpty" />
        <PdWorkEpisodeCard v-for="episode in sortedEpisodes" :key="episode.id" class="episode-card">
          <div class="episode-top"><strong>{{ tasks.find(task => task.id === episode.taskId)?.content || copy.removedTask }}</strong><span>{{ duration(episode) }} {{ copy.minutes }}</span></div>
          <p>{{ episode.note || copy.noNote }}</p>
          <small>{{ new Date(episode.startedAt).toLocaleString('zh-CN') }} — {{ new Date(episode.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
        </PdWorkEpisodeCard>
      </section>
      </template>
    </main>
    <nav class="bottom-nav" :aria-label="copy.nav">
      <button :class="{ active: tab === 'today' }" @click="tab = 'today'"><span>◫</span>{{ copy.today }}</button>
      <button :class="{ active: tab === 'projects' }" @click="tab = 'projects'"><span>▦</span>{{ copy.projects }}</button>
      <button :class="{ active: tab === 'history' }" @click="tab = 'history'"><span>◷</span>{{ copy.historyShort }}</button>
      <button :class="{ active: tab === 'sync' }" @click="tab = 'sync'"><span>⇄</span>{{ copy.syncNav }}</button>
    </nav>
    <div v-if="editor" class="scrim" @click.self="editor = ''">
      <form class="sheet" @submit.prevent="editor === 'task' ? saveTask() : editor === 'project' ? saveProject() : saveEpisode()">
        <div class="sheet-handle"></div>
        <div class="sheet-header"><h2>{{ editor === 'task' ? (taskForm.id ? copy.editTask : copy.newTask) : editor === 'project' ? copy.newProject : copy.recordHistory }}</h2><button type="button" class="close-x" :aria-label="copy.close" @click="editor = ''">×</button></div>
        <template v-if="editor === 'task'">
          <label>{{ copy.taskName }}<input v-model="taskForm.content" required autofocus :placeholder="copy.taskPrompt" /></label>
          <label>{{ copy.description }}<textarea v-model="taskForm.description" rows="3" :placeholder="copy.descriptionPrompt"></textarea></label>
          <label>{{ copy.taskProject }}<select v-model.number="taskForm.categoryId"><option :value="0">{{ copy.inbox }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
          <label>{{ copy.scheduleDate }}<input type="date" :value="taskForm.scheduledDay ? String(taskForm.scheduledDay).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : ''" @input="taskForm.scheduledDay = Number($event.target.value.replaceAll('-', ''))" /></label>
        </template>
        <template v-else-if="editor === 'project'"><label>{{ copy.projectName }}<input v-model="projectName" required autofocus :placeholder="copy.projectPrompt" /></label></template>
        <template v-else>
          <label>{{ copy.startTime }}<input v-model="episodeForm.startedAt" type="datetime-local" required /></label>
          <label>{{ copy.endTime }}<input v-model="episodeForm.endedAt" type="datetime-local" required /></label>
          <label>{{ copy.whatDone }}<textarea v-model="episodeForm.note" rows="3" :placeholder="copy.episodePrompt"></textarea></label>
        </template>
        <PdActionButton class="save" type="submit" block>{{ copy.save }}</PdActionButton>
      </form>
    </div>
  </div>
</template>
