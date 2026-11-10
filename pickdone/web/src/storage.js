const DB_NAME = 'pickdone-web-v1'
const STORES = ['tasks', 'projects', 'episodes']
let connection

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export function openDatabase() {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('This browser does not support IndexedDB'))
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Close other PickDone tabs before upgrading storage'))
  })
  return connection
}
async function transaction(names, mode, action) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode)
    let result
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'))
    try { result = action(tx) } catch (error) { tx.abort(); reject(error) }
  })
}
export async function readAll() {
  const db = await openDatabase()
  const tx = db.transaction(STORES, 'readonly')
  const [tasks, projects, episodes] = await Promise.all(STORES.map(name => requestResult(tx.objectStore(name).getAll())))
  return { tasks, projects, episodes }
}
export async function putRow(store, row) {
  if (!STORES.includes(store)) throw new Error('Unknown collection')
  return transaction([store], 'readwrite', tx => tx.objectStore(store).put(row))
}
export async function markDeleted(store, id) {
  if (!STORES.includes(store)) throw new Error('Unknown collection')
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const objectStore = tx.objectStore(store)
    let changed = false
    const request = objectStore.get(id)
    request.onsuccess = () => {
      const row = request.result
      if (row && !row.deleted) {
        const now = Date.now()
        objectStore.put({ ...row, deleted: 1, deletedAt: now, updatedAt: now })
        changed = true
      }
    }
    tx.oncomplete = () => resolve(changed)
    tx.onerror = () => reject(tx.error)
  })
}
export async function replaceAll(data) {
  validateBackup(data)
  return transaction(STORES, 'readwrite', tx => {
    for (const name of STORES) {
      const store = tx.objectStore(name)
      store.clear()
      for (const row of data[name]) store.put(row)
    }
  })
}
export function validateBackup(data) {
  if (!data || data.format !== 'pickdone-web-backup-v1') throw new Error('Unrecognized PickDone Web backup')
  for (const name of STORES) {
    if (!Array.isArray(data[name])) throw new Error('Backup is missing ' + name)
    for (const row of data[name]) {
      if (!row || (typeof row.id !== 'string' && typeof row.id !== 'number')) throw new Error('Invalid ' + name + ' ID')
    }
  }
  if (data.tasks.some(row => typeof row.id !== 'string' || typeof row.content !== 'string')) throw new Error('Invalid task row')
  if (data.projects.some(row => !Number.isInteger(row.id) || typeof row.name !== 'string')) throw new Error('Invalid project row')
  if (data.episodes.some(row => typeof row.id !== 'string' || typeof row.taskId !== 'string')) throw new Error('Invalid episode row')
  return data
}
export function backupData(rows) {
  return { format: 'pickdone-web-backup-v1', exportedAt: Date.now(), ...rows }
}
export function todayKey(date = new Date()) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}
export function dateInput(key) {
  if (!key) return ''
  const digits = String(key)
  return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8)
}
export function dayKey(value) { return value ? Number(value.replaceAll('-', '')) : 0 }
export function newTask(content, categoryId = 0, scheduledDay = todayKey()) {
  const now = Date.now()
  return { id: crypto.randomUUID(), content: content.trim(), description: '', categoryId: Number(categoryId), complete: 0, completedAt: 0, scheduledAt: 0, scheduledDay, remindAt: null, deadlineTs: 0, createdAt: now, updatedAt: now, deleted: 0, deletedAt: 0, syncAuthor: null, version: 0, sort: now }
}
export function newProject(name, existing) {
  const now = Date.now()
  return { id: Math.max(0, ...existing.map(row => Number(row.id) || 0)) + 1, name: name.trim(), color: '#7a9e65', isFolder: 0, parentId: 0, createdAt: now, updatedAt: now, deleted: 0, deletedAt: 0, sort: existing.length }
}
export function newEpisode(taskId, note, startedAt, endedAt) {
  return { id: crypto.randomUUID(), taskId, note: note.trim(), startedAt, endedAt, updatedAt: Date.now(), deleted: 0, deletedAt: 0 }
}
export function episodeView(row) {
  return { ...row, episodeId: row.id, summary: row.note || '' }
}


// Explicit desktop boundary DTO. No transport, pairing or database access is implemented here.
// Project rows are category rows; desktop identifies projects using per-category meta flags.
export function desktopSnapshot(rows) {
  return {
    todos: rows.tasks.map(row => ({ ...row })),
    categories: rows.projects.map(row => ({ ...row })),
    work_episodes: rows.episodes.map(row => ({ ...row })),
    meta: rows.projects.filter(row => !row.deleted).map(row => ({ key: 'projectCategoryFlag:' + row.id, value: '1' }))
  }
}
