import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCommand, createInitialState, DomainError } from '../lib/domain.js'

const run = (state, command) => applyCommand(state, state.revision, command)

test('Mission Control enforces revision, workflow, Owner approval, and supersession', () => {
  let state = createInitialState()
  state = run(state, { type: 'project.create', id: 'p1', name: 'Project' })
  state = run(state, { type: 'task.create', id: 't1', projectId: 'p1', title: 'Task' })
  assert.throws(() => run(state, { type: 'approval.request', id: 'a0', taskId: 't1' }), /cannot request approval/)
  state = run(state, { type: 'task.transition', taskId: 't1', status: 'ready' })
  state = run(state, { type: 'task.transition', taskId: 't1', status: 'running' })
  state = run(state, { type: 'approval.request', id: 'a1', taskId: 't1' })
  state = run(state, { type: 'approval.request', id: 'a2', taskId: 't1' })
  assert.equal(state.approvals.a1.state, 'superseded')
  assert.throws(() => applyCommand(state, state.revision - 1, { type: 'approval.decide', approvalId: 'a2', decision: 'approved', actorRole: 'owner' }), (error) => error instanceof DomainError && error.code === 'revision-conflict')
  state = run(state, { type: 'approval.decide', approvalId: 'a2', decision: 'approved', actorRole: 'owner' })
  state = run(state, { type: 'task.transition', taskId: 't1', status: 'done' })
  assert.equal(state.tasks.t1.status, 'done')
  assert.equal(state.approvals.a2.decidedBy, 'owner')
})
