import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AtomicStateStore } from '../lib/storage.js'

test('atomic store survives close and reopen', async () => {
  const root = process.env.DSH_MC_TEST_TMP
  assert.ok(root?.startsWith('D:\\'), 'DSH_MC_TEST_TMP must be on D:')
  const dir = join(root, `store-${randomUUID()}`)
  const path = join(dir, 'state.json')
  await mkdir(dir, { recursive: true })
  try {
    const first = new AtomicStateStore(path)
    await first.open()
    await first.execute(0, { type: 'project.create', projectId: 'project-main', title: 'Project' })
    await first.close()
    const second = new AtomicStateStore(path)
    const state = await second.open()
    assert.equal(state.revision, 1)
    assert.equal(state.projects['project-main'].title, 'Project')
    await second.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('failed persistence does not change in-memory state', async () => {
  let writes = 0
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
  const io = {
    read: async () => { throw missing },
    write: async () => { if (writes++ > 0) throw new Error('disk failed') },
    rename: async () => {}, remove: async () => {}, ensureDir: async () => {},
  }
  const store = new AtomicStateStore('D:\\ignored\\state.json', io)
  await store.open()
  await assert.rejects(store.execute(0, { type: 'project.create', projectId: 'project-main', title: 'Project' }), /disk failed/)
  assert.equal(store.snapshot().revision, 0)
  assert.deepEqual(store.snapshot().projects, {})
  await store.close()
})

test('malformed persisted state fails loudly instead of being replaced', async () => {
  const malformed = JSON.stringify({
    schemaVersion: 1, revision: 0, projects: {}, tasks: {}, runs: {}, approvals: {}, evidence: {}, audit: [],
    settings: { ownerLabel: 'Owner', maxProjects: 1, maxTasks: 0, maxEvidence: 1, maxAuditEvents: 1 },
  })
  let writes = 0
  const io = {
    read: async () => malformed,
    write: async () => { writes += 1 },
    rename: async () => {}, remove: async () => {}, ensureDir: async () => {},
  }
  const store = new AtomicStateStore('D:\\ignored\\state.json', io)
  await assert.rejects(store.open(), /settings\.maxTasks is invalid/)
  assert.equal(writes, 0)
})

test('close waits for an in-flight write', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
  let renameCount = 0
  let releaseRename
  const renameGate = new Promise((resolve) => { releaseRename = resolve })
  const io = {
    read: async () => { throw missing }, write: async () => {}, remove: async () => {}, ensureDir: async () => {},
    rename: async () => { if (++renameCount === 2) await renameGate },
  }
  const store = new AtomicStateStore('D:\\ignored\\state.json', io)
  await store.open()
  const write = store.execute(0, { type: 'project.create', projectId: 'project-main', title: 'Project' })
  let closed = false
  const close = store.close().then(() => { closed = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  releaseRename()
  await Promise.all([write, close])
  assert.equal(closed, true)
})
