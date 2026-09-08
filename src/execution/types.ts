/** Product execution metadata only; the official DSH Session remains the transcript. */
export type ExecutionStatus = 'dispatching' | 'accepted' | 'running' | 'stopping'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unconfirmed' | 'detached'

export interface TaskInput {
  taskId: string; projectId: string; revision: number; title: string; objective: string
  acceptanceCriteria: string[]; planMarkdown?: string; phase: string
  sessionBinding?: { sessionId: string }
}
export interface TaskSource {
  snapshot(): { tasks: Record<string, TaskInput>; projects: Record<string, { title: string; workspaceId?: string }> }
}
export interface DshEvent { type: string; seq: number; time: number; data: any }
export interface SessionProbe {
  sessionId: string; cwd: string; model: string; running: boolean; queued: number
  lastSeq: number; origin?: string; workspaceId?: string; modelIdentity?: string
}
export interface ToolObservation {
  callId: string; name: string; callSeq: number; resultSeq?: number; status: 'requested' | 'returned' | 'error'
}
export interface ExecutionRun {
  runId: string; intentId: string; taskId: string; projectId: string; taskRevision: number
  sessionId: string; cwd: string; model: string; requestId: string
  status: ExecutionStatus; createdAt: number; updatedAt: number; baseSeq: number; cursor: number
  observedTurn?: number; turn?: number; userMessageSeq?: number; acceptedAt?: number
  stopRequestedAt?: number; finishedAt?: number; releasedAt?: number
  activity: string; reason?: string; output: string; outputSeq?: number
  tools: ToolObservation[]; toolCalls: number; toolErrors: number
}
export interface ExecutionState { version: 1; runs: Record<string, ExecutionRun> }
export interface ExecutionPreview {
  previewId: string; expiresAt: number; taskId: string; taskRevision: number; sessionId: string
  cwd: string; model: string; prompt: string; warning: string
}
export interface ExecutionView {
  enabled: boolean; run?: ExecutionRun; activeTaskId?: string; notice?: string
}
export interface ExecutionRepository { load(): Promise<ExecutionState>; save(state: ExecutionState): Promise<void> }
export interface DshExecutionPort {
  capable(): boolean
  /** Cold-safe preview. */
  probe(sessionId: string): Promise<SessionProbe>
  /** Explicitly resume the selected agent, never change its model or permission policy. */
  prepare(sessionId: string): Promise<SessionProbe>
  inspect(sessionId: string): Promise<{ events: readonly DshEvent[] }>
  send(sessionId: string, requestId: string, prompt: string, expected?: { baseSeq: number; cwd: string; modelIdentity?: string }): Promise<{ accepted: true }>
  /** Remove only our queued message, or cancel only the still-owned live turn. */
  stop(run: ExecutionRun): Promise<'requested' | 'queue-removed' | 'already-idle'>
  subscribe(listener: (sessionId: string, event: DshEvent) => void): () => void
}
export class ExecutionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ExecutionError' }
}
export const TERMINAL = new Set<ExecutionStatus>(['completed', 'failed', 'cancelled', 'interrupted'])
export const isActive = (run: ExecutionRun): boolean => !TERMINAL.has(run.status) && run.releasedAt === undefined
export const opaqueId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value)
export const clip = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : ''
