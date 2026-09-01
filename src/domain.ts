export type TaskStatus = 'draft' | 'ready' | 'running' | 'blocked' | 'awaiting-approval' | 'done' | 'cancelled'
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'superseded'

export interface Project { id: string; name: string; createdAt: string; updatedAt: string }
export interface Task { id: string; projectId: string; title: string; acceptanceCriteria: string; status: TaskStatus; sessionId?: string; activeApprovalId?: string; createdAt: string; updatedAt: string }
export interface TaskRun { id: string; taskId: string; state: 'running' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; finishedAt?: string; summary?: string }
export interface Approval { id: string; taskId: string; state: ApprovalState; requestedAt: string; decidedAt?: string; decidedBy?: 'owner'; note?: string }
export interface Evidence { id: string; taskId: string; text: string; createdAt: string }
export interface AuditEvent { id: string; at: string; action: string; entityType: string; entityId: string; detail?: string }
export interface Settings { ownerLabel: string; maxProjects: number; maxTasks: number; maxEvidence: number; maxAudit: number }

export interface MissionControlStateV1 {
  schemaVersion: 1
  revision: number
  projects: Record<string, Project>
  tasks: Record<string, Task>
  taskRuns: Record<string, TaskRun>
  approvals: Record<string, Approval>
  evidence: Record<string, Evidence>
  audit: AuditEvent[]
  settings: Settings
}

export type DomainCommand =
  | { type: 'project.create'; id: string; name: string }
  | { type: 'task.create'; id: string; projectId: string; title: string; acceptanceCriteria?: string }
  | { type: 'task.edit'; taskId: string; title?: string; acceptanceCriteria?: string }
  | { type: 'task.transition'; taskId: string; status: TaskStatus }
  | { type: 'task.bind-session'; taskId: string; sessionId: string }
  | { type: 'task.unbind-session'; taskId: string }
  | { type: 'run.start'; id: string; taskId: string }
  | { type: 'run.finish'; runId: string; state: 'succeeded' | 'failed' | 'cancelled'; summary?: string }
  | { type: 'approval.request'; id: string; taskId: string; note?: string }
  | { type: 'approval.decide'; approvalId: string; decision: 'approved' | 'rejected'; actorRole: 'owner'; note?: string }
  | { type: 'evidence.add'; id: string; taskId: string; text: string }
  | { type: 'settings.update'; ownerLabel?: string }

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError' }
}

const DEFAULT_SETTINGS: Settings = { ownerLabel: 'Owner', maxProjects: 100, maxTasks: 2000, maxEvidence: 5000, maxAudit: 10000 }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(['ready', 'cancelled']),
  ready: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'awaiting-approval', 'cancelled']),
  blocked: new Set(['running', 'cancelled']),
  'awaiting-approval': new Set(['running', 'done', 'cancelled']),
  done: new Set(),
  cancelled: new Set(),
}

const text = (value: unknown, field: string, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string') throw new DomainError('invalid-argument', `${field} must be a string`)
  const result = value.trim()
  if (!allowEmpty && !result) throw new DomainError('invalid-argument', `${field} is required`)
  if (result.length > max) throw new DomainError('capacity', `${field} is too long`)
  return result
}
const id = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw new DomainError('invalid-argument', `${field} is invalid`)
  return value
}
const clone = <T>(value: T): T => structuredClone(value)
const count = (value: object) => Object.keys(value).length
const stamp = () => new Date().toISOString()

export function createInitialState(): MissionControlStateV1 {
  return { schemaVersion: 1, revision: 0, projects: {}, tasks: {}, taskRuns: {}, approvals: {}, evidence: {}, audit: [], settings: clone(DEFAULT_SETTINGS) }
}

export function validateState(value: unknown): MissionControlStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('state-malformed', 'state must be an object')
  const state = value as MissionControlStateV1
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new DomainError('state-malformed', 'state header is invalid')
  for (const key of ['projects', 'tasks', 'taskRuns', 'approvals', 'evidence'] as const) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new DomainError('state-malformed', `${key} is invalid`)
  }
  if (!Array.isArray(state.audit) || !state.settings || typeof state.settings !== 'object') throw new DomainError('state-malformed', 'state collections are invalid')
  if (count(state.projects) > state.settings.maxProjects || count(state.tasks) > state.settings.maxTasks || count(state.evidence) > state.settings.maxEvidence || state.audit.length > state.settings.maxAudit) throw new DomainError('state-capacity', 'persisted state exceeds capacity')
  for (const [key, project] of Object.entries(state.projects)) if (project.id !== key || !ID.test(key) || !project.name) throw new DomainError('state-malformed', 'project is invalid')
  for (const [key, task] of Object.entries(state.tasks)) {
    if (task.id !== key || !state.projects[task.projectId] || !TRANSITIONS[task.status]) throw new DomainError('state-malformed', 'task is invalid')
    if (task.activeApprovalId && !state.approvals[task.activeApprovalId]) throw new DomainError('state-malformed', 'task approval reference is invalid')
  }
  for (const [key, approval] of Object.entries(state.approvals)) if (approval.id !== key || !state.tasks[approval.taskId]) throw new DomainError('state-malformed', 'approval is invalid')
  for (const [key, item] of Object.entries(state.evidence)) if (item.id !== key || !state.tasks[item.taskId]) throw new DomainError('state-malformed', 'evidence is invalid')
  for (const [key, run] of Object.entries(state.taskRuns)) if (run.id !== key || !state.tasks[run.taskId]) throw new DomainError('state-malformed', 'task run is invalid')
  return clone(state)
}

function appendAudit(state: MissionControlStateV1, action: string, entityType: string, entityId: string, detail?: string) {
  if (state.audit.length >= state.settings.maxAudit) throw new DomainError('capacity', 'audit capacity reached')
  state.audit.push({ id: `audit-${state.revision + 1}-${state.audit.length + 1}`, at: stamp(), action, entityType, entityId, ...(detail ? { detail } : {}) })
}

export function applyCommand(current: MissionControlStateV1, expectedRevision: number, command: DomainCommand): MissionControlStateV1 {
  const source = validateState(current)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== source.revision) throw new DomainError('revision-conflict', `expected revision ${expectedRevision}, current ${source.revision}`)
  const next = clone(source)
  const at = stamp()
  switch (command.type) {
    case 'project.create': {
      const projectId = id(command.id, 'project id'); const name = text(command.name, 'project name', 200)
      if (next.projects[projectId]) throw new DomainError('already-exists', 'project already exists')
      if (count(next.projects) >= next.settings.maxProjects) throw new DomainError('capacity', 'project capacity reached')
      next.projects[projectId] = { id: projectId, name, createdAt: at, updatedAt: at }
      appendAudit(next, command.type, 'project', projectId, name); break
    }
    case 'task.create': {
      const taskId = id(command.id, 'task id'); const projectId = id(command.projectId, 'project id')
      if (!next.projects[projectId]) throw new DomainError('not-found', 'project not found')
      if (next.tasks[taskId]) throw new DomainError('already-exists', 'task already exists')
      if (count(next.tasks) >= next.settings.maxTasks) throw new DomainError('capacity', 'task capacity reached')
      next.tasks[taskId] = { id: taskId, projectId, title: text(command.title, 'task title', 300), acceptanceCriteria: text(command.acceptanceCriteria ?? '', 'acceptance criteria', 8000, true), status: 'draft', createdAt: at, updatedAt: at }
      appendAudit(next, command.type, 'task', taskId); break
    }
    case 'task.edit': {
      const task = next.tasks[id(command.taskId, 'task id')]; if (!task) throw new DomainError('not-found', 'task not found')
      if (command.title !== undefined) task.title = text(command.title, 'task title', 300)
      if (command.acceptanceCriteria !== undefined) task.acceptanceCriteria = text(command.acceptanceCriteria, 'acceptance criteria', 8000, true)
      task.updatedAt = at; appendAudit(next, command.type, 'task', task.id); break
    }
    case 'task.transition': {
      const task = next.tasks[id(command.taskId, 'task id')]; if (!task) throw new DomainError('not-found', 'task not found')
      if (!TRANSITIONS[task.status].has(command.status)) throw new DomainError('invalid-transition', `${task.status} cannot transition to ${command.status}`)
      if (command.status === 'done') {
        const approval = task.activeApprovalId ? next.approvals[task.activeApprovalId] : undefined
        if (!approval || approval.state !== 'approved') throw new DomainError('approval-required', 'approved Owner approval is required')
      }
      task.status = command.status; task.updatedAt = at; appendAudit(next, command.type, 'task', task.id, command.status); break
    }
    case 'task.bind-session': {
      const task = next.tasks[id(command.taskId, 'task id')]; if (!task) throw new DomainError('not-found', 'task not found')
      task.sessionId = text(command.sessionId, 'session id', 200); task.updatedAt = at; appendAudit(next, command.type, 'task', task.id, task.sessionId); break
    }
    case 'task.unbind-session': {
      const task = next.tasks[id(command.taskId, 'task id')]; if (!task) throw new DomainError('not-found', 'task not found')
      delete task.sessionId; task.updatedAt = at; appendAudit(next, command.type, 'task', task.id); break
    }
    case 'run.start': {
      const runId = id(command.id, 'run id'); const task = next.tasks[id(command.taskId, 'task id')]
      if (!task) throw new DomainError('not-found', 'task not found'); if (next.taskRuns[runId]) throw new DomainError('already-exists', 'run already exists')
      next.taskRuns[runId] = { id: runId, taskId: task.id, state: 'running', startedAt: at }; appendAudit(next, command.type, 'taskRun', runId); break
    }
    case 'run.finish': {
      const run = next.taskRuns[id(command.runId, 'run id')]; if (!run) throw new DomainError('not-found', 'run not found')
      if (run.state !== 'running') throw new DomainError('invalid-transition', 'run is already finished')
      run.state = command.state; run.finishedAt = at; if (command.summary !== undefined) run.summary = text(command.summary, 'run summary', 4000, true)
      appendAudit(next, command.type, 'taskRun', run.id, command.state); break
    }
    case 'approval.request': {
      const approvalId = id(command.id, 'approval id'); const task = next.tasks[id(command.taskId, 'task id')]
      if (!task) throw new DomainError('not-found', 'task not found'); if (next.approvals[approvalId]) throw new DomainError('already-exists', 'approval already exists')
      if (task.status !== 'running' && task.status !== 'awaiting-approval') throw new DomainError('invalid-transition', `${task.status} cannot request approval`)
      if (task.activeApprovalId) { const old = next.approvals[task.activeApprovalId]; if (old) { old.state = 'superseded'; old.decidedAt = at } }
      next.approvals[approvalId] = { id: approvalId, taskId: task.id, state: 'pending', requestedAt: at, ...(command.note ? { note: text(command.note, 'approval note', 2000, true) } : {}) }
      task.activeApprovalId = approvalId; task.status = 'awaiting-approval'; task.updatedAt = at; appendAudit(next, command.type, 'approval', approvalId); break
    }
    case 'approval.decide': {
      if (command.actorRole !== 'owner') throw new DomainError('forbidden', 'Owner approval required')
      const approval = next.approvals[id(command.approvalId, 'approval id')]; if (!approval) throw new DomainError('not-found', 'approval not found')
      if (approval.state !== 'pending') throw new DomainError('invalid-transition', 'approval is not pending')
      approval.state = command.decision; approval.decidedAt = at; approval.decidedBy = 'owner'; if (command.note !== undefined) approval.note = text(command.note, 'approval note', 2000, true)
      appendAudit(next, command.type, 'approval', approval.id, command.decision); break
    }
    case 'evidence.add': {
      const evidenceId = id(command.id, 'evidence id'); const task = next.tasks[id(command.taskId, 'task id')]
      if (!task) throw new DomainError('not-found', 'task not found'); if (next.evidence[evidenceId]) throw new DomainError('already-exists', 'evidence already exists')
      if (count(next.evidence) >= next.settings.maxEvidence) throw new DomainError('capacity', 'evidence capacity reached')
      next.evidence[evidenceId] = { id: evidenceId, taskId: task.id, text: text(command.text, 'evidence', 8000), createdAt: at }
      appendAudit(next, command.type, 'evidence', evidenceId); break
    }
    case 'settings.update': {
      if (command.ownerLabel !== undefined) next.settings.ownerLabel = text(command.ownerLabel, 'owner label', 100)
      appendAudit(next, command.type, 'settings', 'global'); break
    }
    default: throw new DomainError('method-not-allowed', 'unknown command')
  }
  next.revision = source.revision + 1
  return validateState(next)
}
