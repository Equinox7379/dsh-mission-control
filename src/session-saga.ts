import type { MissionControlClientStore } from './client-store.js'
import type { Task } from './domain.js'

export interface SessionActions {
  create(options: Record<string, unknown>): Promise<unknown>
  open(sessionId: string): Promise<unknown>
}

export type BindingSagaResult =
  | { status: 'bound'; sessionId: string }
  | { status: 'create-failed'; message: string }
  | { status: 'binding-incomplete'; sessionId: string; message: string }
  | { status: 'refresh-required'; message: string }

const sessionIdOf = (value: any) => typeof value === 'string' ? value : String(value?.sessionId ?? value?.id ?? '')

export async function createOpenBindSession(task: Task, sessions: SessionActions, store: MissionControlClientStore): Promise<BindingSagaResult> {
  let created: unknown
  try { created = await sessions.create({}) }
  catch (error: any) { return { status: 'create-failed', message: String(error?.message ?? '会话创建结果未确认，请先检查会话列表。') } }
  const sessionId = sessionIdOf(created)
  if (!sessionId) return { status: 'refresh-required', message: '会话创建回执不完整。请刷新会话列表并手动关联，不会自动重复创建。' }
  try { await sessions.open(sessionId) }
  catch (error: any) {
    await recordRepair(store, task.taskId, sessionId, `Session was created but could not be opened: ${String(error?.message ?? 'unknown error')}`)
    return { status: 'binding-incomplete', sessionId, message: '会话已经保留。请从会话列表打开，再手动关联。' }
  }
  let result
  try { result = await store.mutate({ type: 'task.bind-session', taskId: task.taskId, expectedEntityRevision: task.revision, sessionId }) }
  catch (error: any) {
    await recordRepair(store, task.taskId, sessionId, String(error?.message ?? 'Binding receipt unavailable'))
    return { status: 'binding-incomplete', sessionId, message: '会话已经创建，但关联结果未确认。请从会话列表核对，不要重复创建。' }
  }
  const bound = result.state?.tasks[task.taskId]?.sessionBinding?.sessionId === sessionId
  if (bound) return { status: 'bound', sessionId }
  await recordRepair(store, task.taskId, sessionId, result.error?.message ?? 'Session binding failed')
  return { status: 'binding-incomplete', sessionId, message: '会话已经保留，请在会话列表中核对并修复关联。' }
}

export async function bindExistingSession(task: Task, sessionId: string, store: MissionControlClientStore): Promise<BindingSagaResult> {
  const result = await store.mutate({ type: 'task.bind-session', taskId: task.taskId, expectedEntityRevision: task.revision, sessionId })
  return result.state?.tasks[task.taskId]?.sessionBinding?.sessionId === sessionId
    ? { status: 'bound', sessionId }
    : { status: 'binding-incomplete', sessionId, message: result.error?.message ?? 'Session binding failed' }
}

export async function unbindSession(task: Task, store: MissionControlClientStore): Promise<boolean> {
  const result = await store.mutate({ type: 'task.unbind-session', taskId: task.taskId, expectedEntityRevision: task.revision })
  return result.phase === 'ready' && !result.error && !!result.state?.tasks[task.taskId] && !result.state.tasks[task.taskId].sessionBinding
}

async function recordRepair(store: MissionControlClientStore, taskId: string, sessionId: string, reason: string) {
  const current = store.getSnapshot().state?.tasks[taskId]
  if (!current) return
  // A failed repair write must not discard the already created Session ID.
  // The caller still returns it so the user can locate the preserved Session.
  try { await store.mutate({ type: 'task.binding-repair', taskId, expectedEntityRevision: current.revision, sessionId, reason: reason.slice(0, 1000) }) }
  catch { /* Report binding-incomplete with the ID; never create again. */ }
}
