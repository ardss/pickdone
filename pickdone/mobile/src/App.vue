<script setup>
import { computed, onMounted, ref } from 'vue'
import { openRepository } from './repository'
import copy from './i18n/zh-CN.js'

const repo = ref(null)
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
  try { repo.value = await openRepository(); await refresh() } catch (cause) { error.value = cause.message || String(cause) }
})
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
  <div class="app-shell">
    <header class="masthead">
      <div class="brand"><span class="brand-mark">✓</span><span>PickDone</span></div>
      <span class="local-badge">{{ copy.localRecord }}</span>
    </header>
    <main>
      <div v-if="error" class="error" role="alert">{{ error }}</div>
      <section v-if="tab === 'today'">
        <div class="eyebrow">{{ copy.today }} · {{ dateTitle }}</div>
        <h1>{{ copy.todaySlogan }}</h1>
        <p class="intro">{{ copy.todayIntroStart }} {{ todayTasks.length }} {{ copy.todayIntroEnd }}</p>
        <button class="primary-add" type="button" @click="newTask"><span>＋</span> {{ copy.addTask }}</button>
        <div class="section-heading"><h2>{{ copy.pending }}</h2><span>{{ todayTasks.length }}</span></div>
        <p v-if="!todayTasks.length" class="empty">{{ copy.todayEmpty }}</p>
        <article v-for="task in todayTasks" :key="task.id" class="task-card">
          <button class="check" type="button" :aria-label="copy.complete + task.content" @click="toggleTask(task)"></button>
          <div class="task-main" @click="editTask(task)"><strong>{{ task.content }}</strong><small>{{ projectNameById(task.categoryId) }}<template v-if="task.description"> · {{ task.description }}</template></small></div>
          <button class="mini" type="button" :aria-label="copy.record + task.content + copy.recordSuffix" @click="newEpisode(task)">◷</button>
        </article>
        <div v-if="completeTasks.length" class="section-heading completed-heading"><h2>{{ copy.completed }}</h2><span>{{ completeTasks.length }}</span></div>
        <article v-for="task in completeTasks.slice(0, 10)" :key="task.id" class="task-card done">
          <button class="check checked" type="button" :aria-label="copy.restore + task.content" @click="toggleTask(task)">✓</button>
          <div class="task-main" @click="editTask(task)"><strong>{{ task.content }}</strong><small>{{ projectNameById(task.categoryId) }}</small></div>
        </article>
      </section>
      <section v-else-if="tab === 'projects'">
        <div class="eyebrow">{{ copy.yourSpace }}</div><h1>{{ copy.projects }}</h1><p class="intro">{{ copy.projectsIntro }}</p>
        <button class="primary-add" type="button" @click="editor = 'project'"><span>＋</span> {{ copy.newProject }}</button>
        <p v-if="!projects.length" class="empty">{{ copy.projectsEmpty }}</p>
        <article v-for="project in projects" :key="project.id" class="project-card">
          <span class="project-dot" :style="{ background: project.color }"></span>
          <div><strong>{{ project.name }}</strong><small>{{ tasks.filter(task => task.categoryId === project.id && !task.complete).length }} {{ copy.pendingCount }}</small></div>
        </article>
      </section>
      <section v-else>
        <div class="eyebrow">{{ copy.historyEyebrow }}</div><h1>{{ copy.history }}</h1><p class="intro">{{ copy.historyIntro }}</p>
        <p v-if="!sortedEpisodes.length" class="empty">{{ copy.historyEmpty }}</p>
        <article v-for="episode in sortedEpisodes" :key="episode.id" class="episode-card">
          <div class="episode-top"><strong>{{ tasks.find(task => task.id === episode.taskId)?.content || copy.removedTask }}</strong><span>{{ duration(episode) }} {{ copy.minutes }}</span></div>
          <p>{{ episode.note || copy.noNote }}</p>
          <small>{{ new Date(episode.startedAt).toLocaleString('zh-CN') }} — {{ new Date(episode.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
        </article>
      </section>
    </main>
    <nav class="bottom-nav" :aria-label="copy.nav">
      <button :class="{ active: tab === 'today' }" @click="tab = 'today'"><span>◫</span>{{ copy.today }}</button>
      <button :class="{ active: tab === 'projects' }" @click="tab = 'projects'"><span>▦</span>{{ copy.projects }}</button>
      <button :class="{ active: tab === 'history' }" @click="tab = 'history'"><span>◷</span>{{ copy.historyShort }}</button>
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
        <button class="save" type="submit">{{ copy.save }}</button>
      </form>
    </div>
  </div>
</template>
