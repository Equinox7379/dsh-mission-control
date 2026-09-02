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
  catch (error: any) { return { status: 'create-failed', message: String(error?.message ?? 'Session creation failed') } }
  const sessionId = sessionIdOf(created)
  if (!sessionId) return { status: 'refresh-required', message: 'Session creation response was incomplete. Refresh the Session list and bind it manually.' }
  try { await sessions.open(sessionId) }
  catch (error: any) {
    await recordRepair(store, task.taskId, sessionId, `Session was created but could not be opened: ${String(error?.message ?? 'unknown error')}`)
    return { status: 'binding-incomplete', sessionId, message: 'Session was preserved. Open it from the Session list, then bind it manually.' }
  }
  const result = await store.mutate({ type: 'task.bind-session', taskId: task.taskId, expectedEntityRevision: task.revision, sessionId })
  const bound = result.state?.tasks[task.taskId]?.sessionBinding?.sessionId === sessionId
  if (bound) return { status: 'bound', sessionId }
  await recordRepair(store, task.taskId, sessionId, result.error?.message ?? 'Session binding failed')
  return { status: 'binding-incomplete', sessionId, message: 'Session was preserved. Binding can be repaired from the Session list.' }
}

export async function bindExistingSession(task: Task, sessionId: string, store: MissionControlClientStore): Promise<BindingSagaResult> {
  const result = await store.mutate({ type: 'task.bind-session', taskId: task.taskId, expectedEntityRevision: task.revision, sessionId })
  return result.state?.tasks[task.taskId]?.sessionBinding?.sessionId === sessionId
    ? { status: 'bound', sessionId }
    : { status: 'binding-incomplete', sessionId, message: result.error?.message ?? 'Session binding failed' }
}

export async function unbindSession(task: Task, store: MissionControlClientStore): Promise<boolean> {
  const result = await store.mutate({ type: 'task.unbind-session', taskId: task.taskId, expectedEntityRevision: task.revision })
  return !result.state?.tasks[task.taskId]?.sessionBinding
}

async function recordRepair(store: MissionControlClientStore, taskId: string, sessionId: string, reason: string) {
  const current = store.getSnapshot().state?.tasks[taskId]
  if (!current) return
  await store.mutate({ type: 'task.binding-repair', taskId, expectedEntityRevision: current.revision, sessionId, reason: reason.slice(0, 1000) })
}
