import { Capacitor } from '@capacitor/core'
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

const schema = [
  'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, content TEXT, description TEXT, categoryId INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, completedAt INTEGER NOT NULL DEFAULT 0, scheduledDay INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, syncAuthor TEXT)',
  'CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT, color TEXT, isFolder INTEGER DEFAULT 0, parentId INTEGER DEFAULT 0, createdAt INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0, deleted INTEGER DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
  'CREATE TABLE IF NOT EXISTS work_episodes (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, startedAt INTEGER NOT NULL DEFAULT 0, endedAt INTEGER NOT NULL DEFAULT 0, note TEXT, deleted INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0)'
]

function browserStore() {
  const open = new Promise((resolve, reject) => {
    const request = indexedDB.open('pickdone-mobile-v1', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of ['todos', 'categories', 'meta', 'work_episodes']) {
        db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  async function operation(name, mode, action) {
    const db = await open
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode)
      const request = action(transaction.objectStore(name))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onerror = () => reject(transaction.error)
    })
  }
  return {
    all: name => operation(name, 'readonly', store => store.getAll()),
    put: (name, row) => operation(name, 'readwrite', store => store.put(row)),
    get: (name, key) => operation(name, 'readonly', store => store.get(key))
  }
}

export async function openRepository() {
  let native
  let browser
  if (Capacitor.isNativePlatform()) {
    const sqlite = new SQLiteConnection(CapacitorSQLite)
    native = await sqlite.createConnection('pickdone_mobile', false, 'no-encryption', 1, false)
    await native.open()
    for (const statement of schema) await native.execute(statement)
  } else {
    browser = browserStore()
    await browser.all('todos')
  }

  const all = async (name, where = '') => native
    ? (await native.query('SELECT * FROM ' + name + where)).values || []
    : browser.all(name)
  const run = async (statement, values) => native.run(statement, values)
  const putBrowser = async (name, row) => browser.put(name, row)
  const isDeleted = row => Boolean(row?.deleted || row?.delete)
  const live = rows => rows.filter(row => !isDeleted(row))
  const nextStamp = row => Math.max(Date.now(), Number(row?.updatedAt || row?.updateTime || 0) + 1, Number(row?.deletedAt || 0) + 1)

  return {
    async tasks() { return live(await all('todos')) },
    async projects() {
      const categories = live(await all('categories'))
      const flags = native
        ? await all('meta', " WHERE key LIKE 'projectCategoryFlag:%' AND value = '1'")
        : await browser.all('meta')
      const ids = new Set(flags.filter(flag => flag.value === '1').map(flag => Number(flag.key.split(':')[1])))
      return categories.filter(category => ids.has(category.id))
    },
    async episodes() { return live(await all('work_episodes')) },
    async saveTask(input) {
      const previous = input.id ? (await all('todos')).find(row => row.id === input.id) : undefined
      if (isDeleted(previous)) throw new Error('Deleted task cannot be edited')
      const now = nextStamp(previous)
      const row = {
        id: input.id || crypto.randomUUID(),
        content: input.content.trim(),
        description: input.description || '',
        categoryId: Number(input.categoryId || 0),
        complete: Number(input.complete || 0),
        completedAt: input.complete ? (input.completedAt || now) : 0,
        scheduledDay: Number(input.scheduledDay || 0),
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        deleted: 0,
        deletedAt: 0,
        version: (previous?.version || 0) + 1,
        syncAuthor: previous?.syncAuthor || null,
        ...previous
      }
      row.content = input.content.trim()
      row.description = input.description || ''
      row.categoryId = Number(input.categoryId || 0)
      row.complete = Number(input.complete || 0)
      row.completedAt = row.complete ? (input.completedAt || previous?.completedAt || now) : 0
      row.scheduledDay = Number(input.scheduledDay || 0)
      row.updatedAt = now
      row.version = (previous?.version || 0) + 1
      if (!row.content) throw new Error('Task title is required')
      if (native) await run('INSERT INTO todos (id,content,description,categoryId,complete,completedAt,scheduledDay,createdAt,updatedAt,deleted,deletedAt,version,syncAuthor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,description=excluded.description,categoryId=excluded.categoryId,complete=excluded.complete,completedAt=excluded.completedAt,scheduledDay=excluded.scheduledDay,updatedAt=excluded.updatedAt,version=excluded.version', [row.id,row.content,row.description,row.categoryId,row.complete,row.completedAt,row.scheduledDay,row.createdAt,row.updatedAt,row.deleted,row.deletedAt,row.version,row.syncAuthor])
      else await putBrowser('todos', row)
      return row
    },
    async saveProject(input) {
      const current = await all('categories')
      const id = input.id || Math.max(0, ...current.map(item => Number(item.id))) + 1
      const previous = current.find(item => item.id === id)
      if (isDeleted(previous)) throw new Error('Deleted project cannot be edited')
      const now = nextStamp(previous)

      const row = { ...previous, id, name: input.name.trim(), color: input.color || '#727f68', isFolder: 0, parentId: 0, createdAt: previous?.createdAt || now, updatedAt: now, deleted: 0, deletedAt: 0 }
      if (!row.name) throw new Error('Project name is required')
      if (native) {
        await run('INSERT INTO categories (id,name,color,isFolder,parentId,createdAt,updatedAt,deleted,deletedAt) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,updatedAt=excluded.updatedAt', [row.id,row.name,row.color,row.isFolder,row.parentId,row.createdAt,row.updatedAt,row.deleted,row.deletedAt])
        await run('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['projectCategoryFlag:' + id, '1'])
      } else {
        await putBrowser('categories', row)
        await putBrowser('meta', { key: 'projectCategoryFlag:' + id, value: '1' })
      }
      return row
    },
    async saveEpisode(input) {
      const previous = input.id ? (await all('work_episodes')).find(item => item.id === input.id) : undefined
      if (isDeleted(previous)) throw new Error('Deleted work episode cannot be edited')
      const now = nextStamp(previous)
      const row = { id: input.id || crypto.randomUUID(), taskId: input.taskId, startedAt: Number(input.startedAt), endedAt: Number(input.endedAt), note: input.note || '', deleted: 0, deletedAt: 0, updatedAt: now }
      if (!row.taskId || !Number.isFinite(row.startedAt) || !Number.isFinite(row.endedAt) || row.endedAt < row.startedAt) throw new Error('Invalid work episode')
      if (native) await run('INSERT INTO work_episodes (id,taskId,startedAt,endedAt,note,deleted,deletedAt,updatedAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET startedAt=excluded.startedAt,endedAt=excluded.endedAt,note=excluded.note,updatedAt=excluded.updatedAt', [row.id,row.taskId,row.startedAt,row.endedAt,row.note,row.deleted,row.deletedAt,row.updatedAt])
      else await putBrowser('work_episodes', row)
      return row
    }
  }
}
