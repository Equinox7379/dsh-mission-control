export type TaskPhase =
  | 'draft' | 'planning' | 'awaiting-plan-approval' | 'ready' | 'executing'
  | 'verifying' | 'awaiting-review' | 'ready-for-owner' | 'done' | 'paused'
  | 'blocked' | 'failed' | 'cancelled'
export type TaskStatus = TaskPhase
export type Priority = 'low' | 'normal' | 'high' | 'critical'
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired'
export type EvidenceType = 'test' | 'diff' | 'build' | 'browser' | 'screenshot' | 'log' | 'artifact' | 'review' | 'manual-acceptance' | 'source'
export type EvidenceStatus = 'pass' | 'fail' | 'warning' | 'info' | 'not-reproduced'

export interface Project {
  schemaVersion: 1
  projectId: string
  revision: number
  title: string
  description?: string
  workspaceId?: string
  rootPath?: string
  repository?: { remote?: string; defaultBranch?: string }
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface Task {
  schemaVersion: 1
  taskId: string
  revision: number
  projectId: string
  parentTaskId?: string
  title: string
  objective: string
  acceptanceCriteria: string[]
  priority: Priority
  phase: TaskPhase
  blockedReason?: { code: string; message: string }
  planMarkdown?: string
  sessionBinding?: { sessionId: string; boundAt: number }
  bindingRepair?: { sessionId?: string; reason: string; at: number }
  dependencies: string[]
  activeRunId?: string
  activeApprovalId?: string
  requiredEvidence: EvidenceType[]
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface TaskRun {
  schemaVersion: 1
  runId: string
  revision: number
  taskId: string
  attempt: number
  mode: 'manual'
  status: 'planned' | 'queued' | 'running' | 'verifying' | 'reviewing' | 'completed' | 'failed' | 'cancelled'
  sessionId?: string
  startedAt?: number
  finishedAt?: number
  resultSummary?: string
  failure?: { code: string; message: string }
}

export interface Approval {
  schemaVersion: 1
  approvalId: string
  revision: number
  taskId: string
  runId?: string
  kind: 'plan'
  subjectRevision: number
  status: ApprovalState
  summary: string
  requestedAt: number
  decidedAt?: number
  decisionNote?: string
  decidedBy?: 'owner'
}

export interface Evidence {
  schemaVersion: 1
  evidenceId: string
  revision: number
  taskId: string
  runId?: string
  type: EvidenceType
  status: EvidenceStatus
  label: string
  summary: string
  locator?: { kind: 'session-range' | 'local-path' | 'commit' | 'workflow-run' | 'external-reference'; value: string }
  sha256?: string
  producer: { kind: 'human' | 'dsh-plugin' | 'desktop' | 'external-tool'; name: string; sessionId?: string; toolCallId?: string; processId?: number; commandDigest?: string }
  redacted: boolean
  createdAt: number
}

export interface AuditEvent {
  schemaVersion: 1
  auditId: string
  stateRevision: number
  entityType: 'project' | 'task' | 'run' | 'approval' | 'evidence' | 'system'
  entityId: string
  operation: string
  actor: { kind: 'owner' | 'desktop' | 'plugin' | 'system'; name: string }
  summary: string
  time: number
}

export interface Settings {
  ownerLabel: string
  maxProjects: number
  maxTasks: number
  maxEvidence: number
  maxAuditEvents: number
}

export interface MissionControlStateV1 {
  schemaVersion: 1
  revision: number
  projects: Record<string, Project>
  tasks: Record<string, Task>
  runs: Record<string, TaskRun>
  approvals: Record<string, Approval>
  evidence: Record<string, Evidence>
  audit: AuditEvent[]
  settings: Settings
}

type ActorRole = 'owner' | 'plugin'
export type DomainCommand =
  | { type: 'project.create'; projectId: string; title: string; description?: string; workspaceId?: string }
  | { type: 'project.update'; projectId: string; expectedEntityRevision: number; title?: string; description?: string; workspaceId?: string }
  | { type: 'project.archive'; projectId: string; expectedEntityRevision: number }
  | { type: 'task.create'; taskId: string; projectId: string; title: string; objective?: string; acceptanceCriteria?: string[]; priority?: Priority }
  | { type: 'task.update'; taskId: string; expectedEntityRevision: number; title?: string; objective?: string; acceptanceCriteria?: string[]; planMarkdown?: string; priority?: Priority; dependencies?: string[]; requiredEvidence?: EvidenceType[] }
  | { type: 'task.transition'; taskId: string; expectedEntityRevision: number; phase: TaskPhase; blockedReason?: { code: string; message: string }; actorRole?: ActorRole }
  | { type: 'task.bind-session'; taskId: string; expectedEntityRevision: number; sessionId: string }
  | { type: 'task.unbind-session'; taskId: string; expectedEntityRevision: number }
  | { type: 'task.binding-repair'; taskId: string; expectedEntityRevision: number; sessionId?: string; reason: string }
  | { type: 'run.create'; runId: string; taskId: string; expectedEntityRevision: number; sessionId?: string }
  | { type: 'run.update'; runId: string; expectedEntityRevision: number; status: TaskRun['status']; resultSummary?: string; failure?: { code: string; message: string } }
  | { type: 'approval.request'; approvalId: string; taskId: string; expectedEntityRevision: number; summary: string }
  | { type: 'approval.decide'; approvalId: string; expectedEntityRevision: number; decision: 'approved' | 'rejected'; actorRole: 'owner'; note?: string }
  | { type: 'evidence.append'; evidenceId: string; taskId: string; evidenceType: EvidenceType; status: EvidenceStatus; label: string; summary: string; locator?: Evidence['locator']; sha256?: string; producer: Evidence['producer']; redacted?: boolean }
  | { type: 'settings.update'; ownerLabel?: string }

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DomainError' }
}

const DEFAULT_SETTINGS: Settings = { ownerLabel: 'Owner', maxProjects: 100, maxTasks: 500, maxEvidence: 5000, maxAuditEvents: 5000 }
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PREFIX: Record<string, RegExp> = {
  project: /^project-[A-Za-z0-9._:-]{1,120}$/u,
  task: /^task-[A-Za-z0-9._:-]{1,123}$/u,
  run: /^run-[A-Za-z0-9._:-]{1,124}$/u,
  approval: /^approval-[A-Za-z0-9._:-]{1,119}$/u,
  evidence: /^evidence-[A-Za-z0-9._:-]{1,119}$/u,
}
const PRIORITIES = new Set<Priority>(['low', 'normal', 'high', 'critical'])
const EVIDENCE_TYPES = new Set<EvidenceType>(['test', 'diff', 'build', 'browser', 'screenshot', 'log', 'artifact', 'review', 'manual-acceptance', 'source'])
const EVIDENCE_STATUSES = new Set<EvidenceStatus>(['pass', 'fail', 'warning', 'info', 'not-reproduced'])
const RUN_STATUSES = new Set<TaskRun['status']>(['planned', 'queued', 'running', 'verifying', 'reviewing', 'completed', 'failed', 'cancelled'])
const APPROVAL_STATES = new Set<ApprovalState>(['pending', 'approved', 'rejected', 'superseded', 'expired'])
const LOCATOR_KINDS = new Set<NonNullable<Evidence['locator']>['kind']>(['session-range', 'local-path', 'commit', 'workflow-run', 'external-reference'])
const PRODUCER_KINDS = new Set<Evidence['producer']['kind']>(['human', 'dsh-plugin', 'desktop', 'external-tool'])
const PHASES = new Set<TaskPhase>(['draft', 'planning', 'awaiting-plan-approval', 'ready', 'executing', 'verifying', 'awaiting-review', 'ready-for-owner', 'done', 'paused', 'blocked', 'failed', 'cancelled'])
const TRANSITIONS: Record<TaskPhase, ReadonlySet<TaskPhase>> = {
  draft: new Set(['planning', 'paused', 'blocked', 'cancelled']),
  planning: new Set(['awaiting-plan-approval', 'paused', 'blocked', 'cancelled']),
  'awaiting-plan-approval': new Set(['planning', 'ready', 'paused', 'blocked', 'cancelled']),
  ready: new Set(['executing', 'paused', 'blocked', 'cancelled']),
  executing: new Set(['verifying', 'paused', 'blocked', 'failed', 'cancelled']),
  verifying: new Set(['awaiting-review', 'executing', 'paused', 'blocked', 'failed']),
  'awaiting-review': new Set(['ready-for-owner', 'executing', 'paused', 'blocked']),
  'ready-for-owner': new Set(['done', 'executing', 'paused', 'blocked']),
  paused: new Set(['planning', 'ready', 'executing', 'blocked', 'cancelled']),
  blocked: new Set(['planning', 'ready', 'executing', 'paused', 'cancelled']),
  done: new Set(), failed: new Set(), cancelled: new Set(),
}

const clone = <T>(value: T): T => structuredClone(value)
const now = () => Date.now()
const count = (value: object) => Object.keys(value).length
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, field: string, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string') throw new DomainError('invalid-argument', `${field} must be a string`)
  const result = value.trim()
  if (!allowEmpty && !result) throw new DomainError('invalid-argument', `${field} is required`)
  if ([...result].length > max) throw new DomainError('capacity', `${field} is too long`)
  return result
}
const identifier = (value: unknown, field: string, kind?: keyof typeof PREFIX): string => {
  if (typeof value !== 'string' || !ID.test(value) || (kind && !PREFIX[kind].test(value))) throw new DomainError('invalid-argument', `${field} is invalid`)
  return value
}
const safeRevision = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError('invalid-argument', `${field} is invalid`)
  return value as number
}
const textArray = (value: unknown, field: string, maxItems: number, maxEach: number): string[] => {
  if (!Array.isArray(value) || value.length > maxItems) throw new DomainError('invalid-argument', `${field} is invalid`)
  return value.map((item, index) => text(item, `${field}[${index}]`, maxEach))
}
const entityRevision = (actual: number, expected: number) => {
  if (safeRevision(expected, 'expected entity revision') !== actual) throw new DomainError('revision-conflict', `expected entity revision ${expected}, current ${actual}`)
}

export function createInitialState(): MissionControlStateV1 {
  return { schemaVersion: 1, revision: 0, projects: {}, tasks: {}, runs: {}, approvals: {}, evidence: {}, audit: [], settings: clone(DEFAULT_SETTINGS) }
}

function migrateLegacy(value: any): MissionControlStateV1 | undefined {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.projects) || !object(value.tasks) || !object(value.taskRuns)) return undefined
  const at = now(); const state = createInitialState(); state.revision = Number.isSafeInteger(value.revision) ? value.revision : 0
  for (const [key, item] of Object.entries<any>(value.projects)) state.projects[key] = { schemaVersion: 1, projectId: key, revision: 0, title: String(item.name ?? key), status: 'active', createdAt: Date.parse(item.createdAt) || at, updatedAt: Date.parse(item.updatedAt) || at }
  const phaseMap: Record<string, TaskPhase> = { draft: 'draft', ready: 'ready', running: 'executing', blocked: 'blocked', 'awaiting-approval': 'awaiting-plan-approval', done: 'done', cancelled: 'cancelled' }
  for (const [key, item] of Object.entries<any>(value.tasks)) state.tasks[key] = { schemaVersion: 1, taskId: key, revision: 0, projectId: String(item.projectId), title: String(item.title ?? key), objective: '', acceptanceCriteria: String(item.acceptanceCriteria ?? '').split(/\r?\n/u).map((v) => v.trim()).filter(Boolean), priority: 'normal', phase: phaseMap[item.status] ?? 'draft', ...(item.sessionId ? { sessionBinding: { sessionId: String(item.sessionId), boundAt: Date.parse(item.updatedAt) || at } } : {}), ...(item.activeApprovalId ? { activeApprovalId: String(item.activeApprovalId) } : {}), dependencies: [], requiredEvidence: [], createdAt: Date.parse(item.createdAt) || at, updatedAt: Date.parse(item.updatedAt) || at }
  for (const [key, item] of Object.entries<any>(value.taskRuns)) state.runs[key] = { schemaVersion: 1, runId: key, revision: 0, taskId: String(item.taskId), attempt: 1, mode: 'manual', status: item.state === 'succeeded' ? 'completed' : item.state === 'running' ? 'running' : item.state ?? 'failed', ...(item.startedAt ? { startedAt: Date.parse(item.startedAt) || at } : {}), ...(item.finishedAt ? { finishedAt: Date.parse(item.finishedAt) || at } : {}), ...(item.summary ? { resultSummary: String(item.summary) } : {}) }
  for (const [key, item] of Object.entries<any>(value.approvals ?? {})) state.approvals[key] = { schemaVersion: 1, approvalId: key, revision: 0, taskId: String(item.taskId), kind: 'plan', subjectRevision: state.tasks[item.taskId]?.revision ?? 0, status: item.state ?? 'superseded', summary: String(item.note ?? 'Migrated approval'), requestedAt: Date.parse(item.requestedAt) || at, ...(item.decidedAt ? { decidedAt: Date.parse(item.decidedAt) || at } : {}), ...(item.decidedBy === 'owner' ? { decidedBy: 'owner' as const } : {}) }
  for (const [key, item] of Object.entries<any>(value.evidence ?? {})) state.evidence[key] = { schemaVersion: 1, evidenceId: key, revision: 0, taskId: String(item.taskId), type: 'source', status: 'info', label: 'Migrated evidence', summary: String(item.text ?? ''), producer: { kind: 'dsh-plugin', name: 'dsh-mission-control' }, redacted: true, createdAt: Date.parse(item.createdAt) || at }
  state.settings = { ...DEFAULT_SETTINGS, ownerLabel: String(value.settings?.ownerLabel ?? 'Owner'), maxProjects: Number(value.settings?.maxProjects ?? DEFAULT_SETTINGS.maxProjects), maxTasks: Number(value.settings?.maxTasks ?? DEFAULT_SETTINGS.maxTasks), maxEvidence: Number(value.settings?.maxEvidence ?? DEFAULT_SETTINGS.maxEvidence), maxAuditEvents: Number(value.settings?.maxAudit ?? DEFAULT_SETTINGS.maxAuditEvents) }
  state.audit = Array.isArray(value.audit) ? value.audit.map((item: any, index: number) => ({ schemaVersion: 1 as const, auditId: String(item.id ?? `audit-${index + 1}`), stateRevision: Math.min(state.revision, index + 1), entityType: item.entityType === 'taskRun' ? 'run' : (['project', 'task', 'approval', 'evidence'].includes(item.entityType) ? item.entityType : 'system'), entityId: String(item.entityId ?? 'global'), operation: String(item.action ?? 'migrated'), actor: { kind: 'system' as const, name: 'legacy-migration' }, summary: String(item.detail ?? item.action ?? 'Migrated event'), time: Date.parse(item.at) || at })) : []
  return state
}

const exactObject = (value: unknown, required: string[], optional: string[] = []): value is Record<string, any> => {
  if (!object(value)) return false
  const keys = Object.keys(value); const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}
const stateText = (value: unknown, max: number, allowEmpty = false) =>
  typeof value === 'string' && (allowEmpty || value.trim().length > 0) && [...value].length <= max
const stateTime = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const malformed = (message: string): never => { throw new DomainError('state-malformed', message) }

export function validateState(value: unknown): MissionControlStateV1 {
  const state = clone((migrateLegacy(value) ?? value) as MissionControlStateV1)
  if (!exactObject(state, ['schemaVersion', 'revision', 'projects', 'tasks', 'runs', 'approvals', 'evidence', 'audit', 'settings'])
    || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0) malformed('state header is invalid')
  for (const key of ['projects', 'tasks', 'runs', 'approvals', 'evidence'] as const) if (!object(state[key])) throw new DomainError('state-malformed', `${key} is invalid`)
  if (!Array.isArray(state.audit) || !exactObject(state.settings, ['ownerLabel', 'maxProjects', 'maxTasks', 'maxEvidence', 'maxAuditEvents']) || !stateText(state.settings.ownerLabel, 100)) malformed('state collections are invalid')
  for (const key of ['maxProjects', 'maxTasks', 'maxEvidence', 'maxAuditEvents'] as const) if (!Number.isSafeInteger(state.settings[key]) || state.settings[key] < 1) malformed(`settings.${key} is invalid`)
  if (count(state.projects) > state.settings.maxProjects || count(state.tasks) > state.settings.maxTasks || count(state.evidence) > state.settings.maxEvidence || state.audit.length > state.settings.maxAuditEvents) throw new DomainError('state-capacity', 'persisted state exceeds capacity')
  for (const [key, project] of Object.entries(state.projects)) {
    if (!exactObject(project, ['schemaVersion', 'projectId', 'revision', 'title', 'status', 'createdAt', 'updatedAt'], ['description', 'workspaceId', 'rootPath', 'repository'])
      || project.projectId !== key || !ID.test(key) || project.schemaVersion !== 1 || !Number.isSafeInteger(project.revision) || project.revision < 0
      || !stateText(project.title, 120) || !['active', 'archived'].includes(project.status) || !stateTime(project.createdAt) || !stateTime(project.updatedAt)
      || (project.description !== undefined && !stateText(project.description, 16384, true))
      || (project.workspaceId !== undefined && (!stateText(project.workspaceId, 128) || !ID.test(project.workspaceId)))
      || (project.rootPath !== undefined && !stateText(project.rootPath, 4096))
      || (project.repository !== undefined && (!exactObject(project.repository, [], ['remote', 'defaultBranch'])
        || (project.repository.remote !== undefined && !stateText(project.repository.remote, 2048))
        || (project.repository.defaultBranch !== undefined && !stateText(project.repository.defaultBranch, 256))))) malformed('project is invalid')
  }
  for (const [key, task] of Object.entries(state.tasks)) {
    if (!exactObject(task, ['schemaVersion', 'taskId', 'revision', 'projectId', 'title', 'objective', 'acceptanceCriteria', 'priority', 'phase', 'dependencies', 'requiredEvidence', 'createdAt', 'updatedAt'], ['parentTaskId', 'blockedReason', 'planMarkdown', 'sessionBinding', 'bindingRepair', 'activeRunId', 'activeApprovalId', 'completedAt'])
      || task.taskId !== key || !ID.test(key) || !state.projects[task.projectId] || task.schemaVersion !== 1 || !Number.isSafeInteger(task.revision) || task.revision < 0
      || !stateText(task.title, 160) || !stateText(task.objective, 32768, true) || !PHASES.has(task.phase) || !PRIORITIES.has(task.priority)
      || !Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length > 50 || task.acceptanceCriteria.some((item) => !stateText(item, 2048))
      || !Array.isArray(task.dependencies) || task.dependencies.length > 50 || task.dependencies.some((item) => typeof item !== 'string' || !ID.test(item) || item === key || !state.tasks[item])
      || !Array.isArray(task.requiredEvidence) || task.requiredEvidence.some((item) => !EVIDENCE_TYPES.has(item))
      || !stateTime(task.createdAt) || !stateTime(task.updatedAt) || (task.completedAt !== undefined && !stateTime(task.completedAt))
      || (task.planMarkdown !== undefined && !stateText(task.planMarkdown, 65536, true))
      || (task.blockedReason !== undefined && (!exactObject(task.blockedReason, ['code', 'message']) || !stateText(task.blockedReason.code, 100) || !stateText(task.blockedReason.message, 1000)))
      || (task.sessionBinding !== undefined && (!exactObject(task.sessionBinding, ['sessionId', 'boundAt']) || !stateText(task.sessionBinding.sessionId, 128) || !ID.test(task.sessionBinding.sessionId) || !stateTime(task.sessionBinding.boundAt)))
      || (task.bindingRepair !== undefined && (!exactObject(task.bindingRepair, ['reason', 'at'], ['sessionId']) || !stateText(task.bindingRepair.reason, 1000) || !stateTime(task.bindingRepair.at) || (task.bindingRepair.sessionId !== undefined && (!stateText(task.bindingRepair.sessionId, 128) || !ID.test(task.bindingRepair.sessionId)))))) malformed('task is invalid')
    if (task.activeApprovalId && !state.approvals[task.activeApprovalId]) malformed('task approval reference is invalid')
    if (task.activeRunId && !state.runs[task.activeRunId]) malformed('task run reference is invalid')
  }
  for (const [key, approval] of Object.entries(state.approvals)) if (!exactObject(approval, ['schemaVersion', 'approvalId', 'revision', 'taskId', 'kind', 'subjectRevision', 'status', 'summary', 'requestedAt'], ['runId', 'decidedAt', 'decisionNote', 'decidedBy'])
    || approval.approvalId !== key || !ID.test(key) || !state.tasks[approval.taskId] || approval.schemaVersion !== 1 || approval.kind !== 'plan'
    || !Number.isSafeInteger(approval.revision) || approval.revision < 0 || !Number.isSafeInteger(approval.subjectRevision) || approval.subjectRevision < 0
    || !APPROVAL_STATES.has(approval.status) || !stateText(approval.summary, 4000) || !stateTime(approval.requestedAt)
    || (approval.decidedAt !== undefined && !stateTime(approval.decidedAt)) || (approval.decisionNote !== undefined && !stateText(approval.decisionNote, 2000, true))
    || (approval.decidedBy !== undefined && approval.decidedBy !== 'owner')) malformed('approval is invalid')
  for (const [key, item] of Object.entries(state.evidence)) if (!exactObject(item, ['schemaVersion', 'evidenceId', 'revision', 'taskId', 'type', 'status', 'label', 'summary', 'producer', 'redacted', 'createdAt'], ['runId', 'locator', 'sha256'])
    || item.evidenceId !== key || !ID.test(key) || !state.tasks[item.taskId] || item.schemaVersion !== 1 || item.revision !== 0
    || !EVIDENCE_TYPES.has(item.type) || !EVIDENCE_STATUSES.has(item.status) || !stateText(item.label, 200) || !stateText(item.summary, 8000)
    || typeof item.redacted !== 'boolean' || !stateTime(item.createdAt)
    || !exactObject(item.producer, ['kind', 'name'], ['sessionId', 'toolCallId', 'processId', 'commandDigest']) || !PRODUCER_KINDS.has(item.producer.kind) || !stateText(item.producer.name, 200)
    || (item.producer.sessionId !== undefined && !stateText(item.producer.sessionId, 256)) || (item.producer.toolCallId !== undefined && !stateText(item.producer.toolCallId, 256))
    || (item.producer.processId !== undefined && (!Number.isSafeInteger(item.producer.processId) || item.producer.processId < 0)) || (item.producer.commandDigest !== undefined && !stateText(item.producer.commandDigest, 256))
    || (item.locator !== undefined && (!exactObject(item.locator, ['kind', 'value']) || !LOCATOR_KINDS.has(item.locator.kind) || !stateText(item.locator.value, 4096)))
    || (item.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(item.sha256))) malformed('evidence is invalid')
  for (const [key, run] of Object.entries(state.runs)) if (!exactObject(run, ['schemaVersion', 'runId', 'revision', 'taskId', 'attempt', 'mode', 'status'], ['sessionId', 'startedAt', 'finishedAt', 'resultSummary', 'failure'])
    || run.runId !== key || !ID.test(key) || !state.tasks[run.taskId] || run.schemaVersion !== 1 || run.mode !== 'manual'
    || !Number.isSafeInteger(run.revision) || run.revision < 0 || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || !RUN_STATUSES.has(run.status)
    || (run.sessionId !== undefined && !stateText(run.sessionId, 256)) || (run.startedAt !== undefined && !stateTime(run.startedAt)) || (run.finishedAt !== undefined && !stateTime(run.finishedAt))
    || (run.resultSummary !== undefined && !stateText(run.resultSummary, 8000, true))
    || (run.failure !== undefined && (!exactObject(run.failure, ['code', 'message']) || !stateText(run.failure.code, 100) || !stateText(run.failure.message, 2000)))) malformed('task run is invalid')
  const auditIds = new Set<string>(); let previousRevision = 0
  for (const event of state.audit) {
    if (!exactObject(event, ['schemaVersion', 'auditId', 'stateRevision', 'entityType', 'entityId', 'operation', 'actor', 'summary', 'time'])
      || event.schemaVersion !== 1 || !ID.test(event.auditId) || !auditIds.add(event.auditId) || !Number.isSafeInteger(event.stateRevision) || event.stateRevision < previousRevision || event.stateRevision > state.revision
      || !['project', 'task', 'run', 'approval', 'evidence', 'system'].includes(event.entityType) || !stateText(event.entityId, 256)
      || !stateText(event.operation, 200) || !exactObject(event.actor, ['kind', 'name']) || !['owner', 'desktop', 'plugin', 'system'].includes(event.actor.kind) || !stateText(event.actor.name, 200)
      || !stateText(event.summary, 1000, true) || !stateTime(event.time)) malformed('audit event is invalid')
    previousRevision = event.stateRevision
  }
  return state
}

function appendAudit(state: MissionControlStateV1, entityType: AuditEvent['entityType'], entityId: string, operation: string, summary: string, actor: AuditEvent['actor'] = { kind: 'plugin', name: 'dsh-mission-control' }) {
  if (state.audit.length >= state.settings.maxAuditEvents) throw new DomainError('capacity', 'audit capacity reached')
  const stateRevision = state.revision + 1
  state.audit.push({ schemaVersion: 1, auditId: `audit-${stateRevision}-${state.audit.length + 1}`, stateRevision, entityType, entityId, operation, actor, summary: text(summary, 'audit summary', 1000, true), time: now() })
}

function supersedePendingApproval(state: MissionControlStateV1, task: Task, at: number) {
  if (!task.activeApprovalId) return
  const approval = state.approvals[task.activeApprovalId]
  if (approval?.status === 'pending' && approval.subjectRevision !== task.revision) { approval.status = 'superseded'; approval.revision += 1; approval.decidedAt = at }
}

function touchTask(state: MissionControlStateV1, task: Task, at: number) { task.revision += 1; task.updatedAt = at; supersedePendingApproval(state, task, at) }
function taskFor(state: MissionControlStateV1, taskId: string, expected?: number): Task {
  const task = state.tasks[identifier(taskId, 'task id')]
  if (!task) throw new DomainError('not-found', 'task not found')
  if (expected !== undefined) entityRevision(task.revision, expected)
  return task
}

export function applyCommand(current: MissionControlStateV1, expectedRevision: number, command: DomainCommand): MissionControlStateV1 {
  const source = validateState(current)
  if (safeRevision(expectedRevision, 'expected state revision') !== source.revision) throw new DomainError('revision-conflict', `expected revision ${expectedRevision}, current ${source.revision}`)
  const next = clone(source); const at = now()
  switch (command.type) {
    case 'project.create': {
      const projectId = identifier(command.projectId, 'project id', 'project')
      if (next.projects[projectId]) throw new DomainError('already-exists', 'project already exists')
      if (count(next.projects) >= next.settings.maxProjects) throw new DomainError('capacity', 'project capacity reached')
      next.projects[projectId] = { schemaVersion: 1, projectId, revision: 0, title: text(command.title, 'project title', 120), ...(command.description !== undefined ? { description: text(command.description, 'project description', 16384, true) } : {}), ...(command.workspaceId ? { workspaceId: identifier(command.workspaceId, 'workspace id') } : {}), status: 'active', createdAt: at, updatedAt: at }
      appendAudit(next, 'project', projectId, command.type, `Created project ${next.projects[projectId].title}`); break
    }
    case 'project.update': {
      const project = next.projects[identifier(command.projectId, 'project id')]; if (!project) throw new DomainError('not-found', 'project not found'); entityRevision(project.revision, command.expectedEntityRevision)
      if (command.title !== undefined) project.title = text(command.title, 'project title', 120)
      if (command.description !== undefined) project.description = text(command.description, 'project description', 16384, true)
      if (command.workspaceId !== undefined) project.workspaceId = identifier(command.workspaceId, 'workspace id')
      project.revision += 1; project.updatedAt = at; appendAudit(next, 'project', project.projectId, command.type, 'Updated project'); break
    }
    case 'project.archive': {
      const project = next.projects[identifier(command.projectId, 'project id')]; if (!project) throw new DomainError('not-found', 'project not found'); entityRevision(project.revision, command.expectedEntityRevision)
      project.status = 'archived'; project.revision += 1; project.updatedAt = at; appendAudit(next, 'project', project.projectId, command.type, 'Archived project'); break
    }
    case 'task.create': {
      const taskId = identifier(command.taskId, 'task id', 'task'); const projectId = identifier(command.projectId, 'project id')
      if (!next.projects[projectId]) throw new DomainError('not-found', 'project not found')
      if (next.tasks[taskId]) throw new DomainError('already-exists', 'task already exists')
      if (count(next.tasks) >= next.settings.maxTasks) throw new DomainError('capacity', 'task capacity reached')
      const priority = command.priority ?? 'normal'; if (!PRIORITIES.has(priority)) throw new DomainError('invalid-argument', 'priority is invalid')
      next.tasks[taskId] = { schemaVersion: 1, taskId, revision: 0, projectId, title: text(command.title, 'task title', 160), objective: text(command.objective ?? '', 'objective', 32768, true), acceptanceCriteria: textArray(command.acceptanceCriteria ?? [], 'acceptance criteria', 50, 2048), priority, phase: 'draft', dependencies: [], requiredEvidence: [], createdAt: at, updatedAt: at }
      appendAudit(next, 'task', taskId, command.type, `Created task ${next.tasks[taskId].title}`); break
    }
    case 'task.update': {
      const task = taskFor(next, command.taskId, command.expectedEntityRevision)
      if (command.title !== undefined) task.title = text(command.title, 'task title', 160)
      if (command.objective !== undefined) task.objective = text(command.objective, 'objective', 32768, true)
      if (command.acceptanceCriteria !== undefined) task.acceptanceCriteria = textArray(command.acceptanceCriteria, 'acceptance criteria', 50, 2048)
      if (command.planMarkdown !== undefined) task.planMarkdown = text(command.planMarkdown, 'plan', 65536, true)
      if (command.priority !== undefined) { if (!PRIORITIES.has(command.priority)) throw new DomainError('invalid-argument', 'priority is invalid'); task.priority = command.priority }
      if (command.dependencies !== undefined) {
        const dependencies = textArray(command.dependencies, 'dependencies', 50, 128).map((item) => identifier(item, 'dependency id'))
        if (dependencies.includes(task.taskId) || new Set(dependencies).size !== dependencies.length || dependencies.some((item) => !next.tasks[item])) throw new DomainError('invalid-argument', 'dependencies must reference distinct existing tasks')
        task.dependencies = dependencies
      }
      if (command.requiredEvidence !== undefined) { if (!Array.isArray(command.requiredEvidence) || command.requiredEvidence.some((item) => !EVIDENCE_TYPES.has(item))) throw new DomainError('invalid-argument', 'required evidence is invalid'); task.requiredEvidence = [...new Set(command.requiredEvidence)] }
      touchTask(next, task, at); appendAudit(next, 'task', task.taskId, command.type, 'Updated task'); break
    }
    case 'task.transition': {
      const task = taskFor(next, command.taskId, command.expectedEntityRevision)
      if (!PHASES.has(command.phase) || !TRANSITIONS[task.phase].has(command.phase)) throw new DomainError('invalid-transition', `${task.phase} cannot transition to ${command.phase}`)
      if (task.phase === 'awaiting-plan-approval' && command.phase === 'ready') {
        const approval = task.activeApprovalId ? next.approvals[task.activeApprovalId] : undefined
        if (!approval || approval.status !== 'approved' || approval.subjectRevision !== task.revision) throw new DomainError('approval-required', 'current Owner plan approval is required')
      }
      if (command.phase === 'done') {
        if (command.actorRole !== 'owner') throw new DomainError('forbidden', 'Owner action is required to finish a task')
        const evidence = Object.values(next.evidence).filter((item) => item.taskId === task.taskId && item.status === 'pass')
        if (evidence.length === 0 || task.requiredEvidence.some((type) => !evidence.some((item) => item.type === type))) throw new DomainError('evidence-required', 'passing evidence is required to finish a task')
      }
      task.phase = command.phase
      if (command.phase === 'blocked') {
        if (!exactObject(command.blockedReason, ['code', 'message'])) throw new DomainError('invalid-argument', 'blocked reason is required')
        task.blockedReason = { code: text(command.blockedReason.code, 'blocked code', 100), message: text(command.blockedReason.message, 'blocked message', 1000) }
      } else delete task.blockedReason
      if (command.phase === 'done') task.completedAt = at
      touchTask(next, task, at); appendAudit(next, 'task', task.taskId, command.type, `Transitioned to ${command.phase}`, command.actorRole === 'owner' ? { kind: 'owner', name: next.settings.ownerLabel } : undefined); break
    }
    case 'task.bind-session': {
      const task = taskFor(next, command.taskId, command.expectedEntityRevision); task.sessionBinding = { sessionId: identifier(command.sessionId, 'session id'), boundAt: at }; delete task.bindingRepair
      touchTask(next, task, at); appendAudit(next, 'task', task.taskId, command.type, `Bound Session ${task.sessionBinding.sessionId}`); break
    }
    case 'task.unbind-session': {
      const task = taskFor(next, command.taskId, command.expectedEntityRevision); delete task.sessionBinding; delete task.bindingRepair
      touchTask(next, task, at); appendAudit(next, 'task', task.taskId, command.type, 'Unbound Session without deleting it'); break
    }
    case 'task.binding-repair': {
      const task = taskFor(next, command.taskId, command.expectedEntityRevision); task.bindingRepair = { ...(command.sessionId ? { sessionId: identifier(command.sessionId, 'session id') } : {}), reason: text(command.reason, 'repair reason', 1000), at }
      touchTask(next, task, at); appendAudit(next, 'task', task.taskId, command.type, 'Recorded recoverable Session binding issue'); break
    }
    case 'run.create': {
      const runId = identifier(command.runId, 'run id', 'run'); const task = taskFor(next, command.taskId, command.expectedEntityRevision)
      if (next.runs[runId]) throw new DomainError('already-exists', 'run already exists')
      const attempt = Object.values(next.runs).filter((item) => item.taskId === task.taskId).length + 1
      next.runs[runId] = { schemaVersion: 1, runId, revision: 0, taskId: task.taskId, attempt, mode: 'manual', status: 'planned', ...(command.sessionId ? { sessionId: identifier(command.sessionId, 'session id') } : {}) }
      task.activeRunId = runId; touchTask(next, task, at); appendAudit(next, 'run', runId, command.type, `Created manual run ${attempt}`); break
    }
    case 'run.update': {
      const run = next.runs[identifier(command.runId, 'run id')]; if (!run) throw new DomainError('not-found', 'run not found'); entityRevision(run.revision, command.expectedEntityRevision)
      if (!RUN_STATUSES.has(command.status)) throw new DomainError('invalid-argument', 'run status is invalid')
      run.status = command.status; run.revision += 1; if (command.status === 'running' && !run.startedAt) run.startedAt = at; if (['completed', 'failed', 'cancelled'].includes(command.status)) run.finishedAt = at
      if (command.resultSummary !== undefined) run.resultSummary = text(command.resultSummary, 'result summary', 8000, true)
      if (command.failure !== undefined) {
        if (!exactObject(command.failure, ['code', 'message'])) throw new DomainError('invalid-argument', 'failure is invalid')
        run.failure = { code: text(command.failure.code, 'failure code', 100), message: text(command.failure.message, 'failure message', 2000) }
      }
      appendAudit(next, 'run', run.runId, command.type, `Run is ${command.status}`); break
    }
    case 'approval.request': {
      const approvalId = identifier(command.approvalId, 'approval id', 'approval'); const task = taskFor(next, command.taskId, command.expectedEntityRevision)
      if (next.approvals[approvalId]) throw new DomainError('already-exists', 'approval already exists')
      if (!['planning', 'awaiting-plan-approval'].includes(task.phase)) throw new DomainError('invalid-transition', `${task.phase} cannot request plan approval`)
      task.phase = 'awaiting-plan-approval'; touchTask(next, task, at)
      next.approvals[approvalId] = { schemaVersion: 1, approvalId, revision: 0, taskId: task.taskId, kind: 'plan', subjectRevision: task.revision, status: 'pending', summary: text(command.summary, 'approval summary', 4000), requestedAt: at }
      task.activeApprovalId = approvalId; appendAudit(next, 'approval', approvalId, command.type, 'Requested Owner plan approval'); break
    }
    case 'approval.decide': {
      if (command.actorRole !== 'owner') throw new DomainError('forbidden', 'Owner approval required')
      const approval = next.approvals[identifier(command.approvalId, 'approval id')]; if (!approval) throw new DomainError('not-found', 'approval not found'); entityRevision(approval.revision, command.expectedEntityRevision)
      const task = taskFor(next, approval.taskId)
      if (approval.status !== 'pending' || approval.subjectRevision !== task.revision) throw new DomainError('approval-superseded', 'approval no longer matches the current task revision')
      approval.status = command.decision; approval.revision += 1; approval.decidedAt = at; approval.decidedBy = 'owner'; if (command.note !== undefined) approval.decisionNote = text(command.note, 'decision note', 2000, true)
      appendAudit(next, 'approval', approval.approvalId, command.type, `Owner ${command.decision} plan`, { kind: 'owner', name: next.settings.ownerLabel }); break
    }
    case 'evidence.append': {
      const evidenceId = identifier(command.evidenceId, 'evidence id', 'evidence'); const task = taskFor(next, command.taskId)
      if (next.evidence[evidenceId]) throw new DomainError('already-exists', 'evidence already exists')
      if (count(next.evidence) >= next.settings.maxEvidence) throw new DomainError('capacity', 'evidence capacity reached')
      if (!EVIDENCE_TYPES.has(command.evidenceType) || !EVIDENCE_STATUSES.has(command.status)) throw new DomainError('invalid-argument', 'evidence classification is invalid')
      if (!exactObject(command.producer, ['kind', 'name'], ['sessionId', 'toolCallId', 'processId', 'commandDigest']) || !PRODUCER_KINDS.has(command.producer.kind)) throw new DomainError('invalid-argument', 'evidence producer is invalid')
      const producer = {
        kind: command.producer.kind,
        name: text(command.producer.name, 'producer name', 200),
        ...(command.producer.sessionId !== undefined ? { sessionId: text(command.producer.sessionId, 'producer session id', 256) } : {}),
        ...(command.producer.toolCallId !== undefined ? { toolCallId: text(command.producer.toolCallId, 'producer tool call id', 256) } : {}),
        ...(command.producer.processId !== undefined ? { processId: safeRevision(command.producer.processId, 'producer process id') } : {}),
        ...(command.producer.commandDigest !== undefined ? { commandDigest: text(command.producer.commandDigest, 'producer command digest', 256) } : {}),
      }
      let locator: Evidence['locator'] | undefined
      if (command.locator !== undefined) {
        if (!exactObject(command.locator, ['kind', 'value']) || !LOCATOR_KINDS.has(command.locator.kind)) throw new DomainError('invalid-argument', 'evidence locator is invalid')
        locator = { kind: command.locator.kind, value: text(command.locator.value, 'evidence locator', 4096) }
      }
      if (command.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(command.sha256)) throw new DomainError('invalid-argument', 'sha256 is invalid')
      next.evidence[evidenceId] = { schemaVersion: 1, evidenceId, revision: 0, taskId: task.taskId, type: command.evidenceType, status: command.status, label: text(command.label, 'evidence label', 200), summary: text(command.summary, 'evidence summary', 8000), ...(locator ? { locator } : {}), ...(command.sha256 ? { sha256: command.sha256 } : {}), producer, redacted: command.redacted ?? true, createdAt: at }
      appendAudit(next, 'evidence', evidenceId, command.type, `Added ${command.evidenceType} evidence`); break
    }
    case 'settings.update': {
      if (command.ownerLabel !== undefined) next.settings.ownerLabel = text(command.ownerLabel, 'owner label', 100)
      appendAudit(next, 'system', 'settings', command.type, 'Updated settings'); break
    }
    default: throw new DomainError('method-not-allowed', 'unknown command')
  }
  next.revision = source.revision + 1
  return validateState(next)
}
