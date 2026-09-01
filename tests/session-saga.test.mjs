import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenBindSession } from '../lib/session-saga.js'

const task = { taskId: 'task-main', revision: 3 }

test('a Session created before an open failure is preserved and marked for repair', async () => {
  const commands = []
  const store = {
    getSnapshot: () => ({ state: { tasks: { 'task-main': task } } }),
    mutate: async (command) => { commands.push(command); return { state: { tasks: { 'task-main': task } } } },
  }
  const sessions = {
    create: async () => 'session-preserved',
    open: async () => { throw new Error('open failed') },
  }

  const result = await createOpenBindSession(task, sessions, store)
  assert.deepEqual(result, {
    status: 'binding-incomplete', sessionId: 'session-preserved',
    message: 'Session was preserved. Open it from the Session list, then bind it manually.',
  })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].type, 'task.binding-repair')
  assert.equal(commands[0].sessionId, 'session-preserved')
})
