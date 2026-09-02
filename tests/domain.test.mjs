import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCommand, createInitialState, DomainError, validateState } from '../lib/domain.js'

const run = (state, command) => applyCommand(state, state.revision, command)

function taskFixture() {
  let state = createInitialState()
  state = run(state, { type: 'project.create', projectId: 'project-main', title: 'Project' })
  state = run(state, { type: 'task.create', taskId: 'task-main', projectId: 'project-main', title: 'Task' })
  return state
}

test('Mission Control requires current revisions and Owner approval before completion', () => {
  let state = taskFixture()
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 0, phase: 'planning' })
  state = run(state, { type: 'approval.request', approvalId: 'approval-plan', taskId: 'task-main', expectedEntityRevision: 1, summary: 'Plan v1' })

  assert.throws(
    () => applyCommand(state, state.revision - 1, { type: 'approval.decide', approvalId: 'approval-plan', expectedEntityRevision: 0, decision: 'approved', actorRole: 'owner' }),
    (error) => error instanceof DomainError && error.code === 'revision-conflict',
  )

  state = run(state, { type: 'approval.decide', approvalId: 'approval-plan', expectedEntityRevision: 0, decision: 'approved', actorRole: 'owner' })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 2, phase: 'ready' })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 3, phase: 'executing' })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 4, phase: 'verifying' })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 5, phase: 'awaiting-review' })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 6, phase: 'ready-for-owner' })
  assert.throws(
    () => run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 7, phase: 'done' }),
    (error) => error instanceof DomainError && error.code === 'forbidden',
  )
  assert.throws(
    () => run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 7, phase: 'done', actorRole: 'owner' }),
    (error) => error instanceof DomainError && error.code === 'evidence-required',
  )
  state = run(state, {
    type: 'evidence.append', evidenceId: 'evidence-final', taskId: 'task-main', evidenceType: 'test', status: 'pass',
    label: 'Tests passed', summary: 'Focused regression passed', producer: { kind: 'dsh-plugin', name: 'dsh-mission-control' },
  })
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 7, phase: 'done', actorRole: 'owner' })

  assert.equal(state.tasks['task-main'].phase, 'done')
  assert.equal(state.approvals['approval-plan'].decidedBy, 'owner')
})

test('state schema, capacity, transition, audit, and no-delete invariants fail closed', () => {
  let state = taskFixture()
  assert.throws(
    () => run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 0, phase: 'ready' }),
    (error) => error instanceof DomainError && error.code === 'invalid-transition',
  )

  const previousAudit = structuredClone(state.audit)
  state = run(state, { type: 'task.update', taskId: 'task-main', expectedEntityRevision: 0, objective: 'Updated' })
  assert.deepEqual(state.audit.slice(0, previousAudit.length), previousAudit)
  assert.equal(state.audit.at(-1).stateRevision, state.revision)
  assert.throws(() => run(state, { type: 'task.delete', taskId: 'task-main' }), (error) => error instanceof DomainError && error.code === 'method-not-allowed')

  const malformed = createInitialState()
  malformed.settings.maxTasks = 0
  assert.throws(() => validateState(malformed), (error) => error instanceof DomainError && error.code === 'state-malformed')

  let limited = createInitialState(); limited.settings.maxProjects = 1
  limited = run(limited, { type: 'project.create', projectId: 'project-one', title: 'One' })
  assert.throws(() => run(limited, { type: 'project.create', projectId: 'project-two', title: 'Two' }), (error) => error instanceof DomainError && error.code === 'capacity')
})

test('editing a task supersedes a pending approval and unbinding never deletes a Session', () => {
  let state = taskFixture()
  state = run(state, { type: 'task.transition', taskId: 'task-main', expectedEntityRevision: 0, phase: 'planning' })
  state = run(state, { type: 'approval.request', approvalId: 'approval-old', taskId: 'task-main', expectedEntityRevision: 1, summary: 'Plan v1' })
  state = run(state, { type: 'task.update', taskId: 'task-main', expectedEntityRevision: 2, planMarkdown: 'Plan v2' })
  assert.equal(state.approvals['approval-old'].status, 'superseded')

  state = run(state, { type: 'task.bind-session', taskId: 'task-main', expectedEntityRevision: 3, sessionId: 'session-1' })
  assert.equal(state.tasks['task-main'].sessionBinding.sessionId, 'session-1')
  state = run(state, { type: 'task.unbind-session', taskId: 'task-main', expectedEntityRevision: 4 })
  assert.equal(state.tasks['task-main'].sessionBinding, undefined)
})
