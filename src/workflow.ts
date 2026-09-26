import { applyCommand, DomainError, validateState, type DomainCommand, type MissionControlStateV1, type Task } from './domain.js'

/** User actions, not model events. Both files retain their existing v1 schemas. */
export type WorkCommand = DomainCommand
  | { type: 'task.accept'; taskId: string; expectedEntityRevision: number; evidenceId: string; note: string; confirmed: true; actorRole: 'owner' }
  | { type: 'task.reopen'; taskId: string; expectedEntityRevision: number; confirmed: true; actorRole: 'owner' }
  | { type: 'project.restore'; projectId: string; expectedEntityRevision: number }

const CLOSED = new Set(['done', 'failed', 'cancelled'])
const conflict = () => { throw new DomainError('revision-conflict', '内容已更新，请核对最新内容后再保存。') }
const assertOwner = (command: { actorRole: string; confirmed: boolean }) => {
  if (command.actorRole !== 'owner' || command.confirmed !== true) throw new DomainError('forbidden', '需要你明确确认此操作。')
}
const taskFor = (state: MissionControlStateV1, id: string, revision: number): Task => {
  const task = Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined
  if (!task) throw new DomainError('not-found', '任务不存在，请刷新。')
  if (task.revision !== revision || !Number.isSafeInteger(revision)) conflict()
  return task!
}
function audit(state: MissionControlStateV1, entityType: 'task' | 'project', entityId: string, operation: string, summary: string, at: number) {
  if (state.audit.length >= state.settings.maxAuditEvents) throw new DomainError('capacity', '记录容量已满，本次更改未保存。')
  state.audit.push({ schemaVersion: 1, auditId: `audit-${state.revision}-${state.audit.length + 1}`,
    stateRevision: state.revision, entityType, entityId, operation,
    actor: { kind: 'owner', name: state.settings.ownerLabel }, summary, time: at })
}

/** One store commit records the user's decision and its evidence together. */
export function applyWorkCommand(current: MissionControlStateV1, expectedRevision: number, command: WorkCommand): MissionControlStateV1 {
  if (command.type !== 'task.accept' && command.type !== 'task.reopen' && command.type !== 'project.restore') {
    return applyCommand(current, expectedRevision, command)
  }
  const next = validateState(current)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== next.revision) conflict()
  const at = Date.now()
  if (command.type === 'project.restore') {
    const project = Object.hasOwn(next.projects, command.projectId) ? next.projects[command.projectId] : undefined
    if (!project) throw new DomainError('not-found', '项目不存在。')
    if (project.revision !== command.expectedEntityRevision) conflict()
    if (project.status !== 'archived') throw new DomainError('invalid-transition', '项目并未归档。')
    project.status = 'active'; project.revision += 1; project.updatedAt = at; next.revision += 1
    audit(next, 'project', project.projectId, command.type, '重新启用项目', at)
    return validateState(next)
  }
  assertOwner(command)
  const task = taskFor(next, command.taskId, command.expectedEntityRevision)
  if (command.type === 'task.reopen') {
    if (!CLOSED.has(task.phase)) throw new DomainError('invalid-transition', '只有已关闭的任务需要重新打开。')
    task.phase = 'draft'; task.revision += 1; task.updatedAt = at
    delete task.completedAt; delete task.blockedReason
    next.revision += 1
    audit(next, 'task', task.taskId, command.type, '重新打开任务；保留会话、计划和历史记录，未发送任何请求', at)
    return validateState(next)
  }
  if (CLOSED.has(task.phase)) throw new DomainError('invalid-transition', '任务已关闭，请先查看现有验收记录。')
  if (typeof command.note !== 'string' || !command.note.trim() || [...command.note.trim()].length > 2000) {
    throw new DomainError('invalid-argument', '请简要填写你核对过的结果，最多 2000 字。')
  }
  const approval = task.activeApprovalId ? next.approvals[task.activeApprovalId] : undefined
  if (approval?.status === 'pending' || approval?.status === 'rejected'
    || (task.phase === 'awaiting-plan-approval' && approval?.status !== 'approved')) {
    throw new DomainError('approval-required', '这项任务还有未通过的计划，请先处理计划确认。')
  }
  if (task.dependencies.some(id => next.tasks[id]?.phase !== 'done')) {
    throw new DomainError('dependency-incomplete', '前置任务尚未验收，请先核对前置工作。')
  }
  const passing = Object.values(next.evidence).filter(item => item.taskId === task.taskId && item.status === 'pass')
  if (task.requiredEvidence.some(type => type !== 'manual-acceptance' && !passing.some(item => item.type === type))) {
    throw new DomainError('evidence-required', '还有要求的验证证据未通过，请先补齐对应记录。')
  }
  if (next.audit.length + 2 > next.settings.maxAuditEvents) throw new DomainError('capacity', '记录容量已满，本次验收未保存。')
  // Reuse the existing evidence validator; do not invent a second evidence shape.
  const accepted = applyCommand(next, expectedRevision, { type: 'evidence.append', evidenceId: command.evidenceId,
    taskId: task.taskId, evidenceType: 'manual-acceptance', status: 'pass', label: '人工验收',
    summary: command.note.trim(), producer: { kind: 'human', name: next.settings.ownerLabel }, redacted: true })
  const acceptedTask = accepted.tasks[task.taskId]
  acceptedTask.phase = 'done'; acceptedTask.completedAt = at; acceptedTask.updatedAt = at; acceptedTask.revision += 1
  delete acceptedTask.blockedReason
  audit(accepted, 'task', task.taskId, command.type, '用户确认交付结果并完成验收', at)
  return validateState(accepted)
}
