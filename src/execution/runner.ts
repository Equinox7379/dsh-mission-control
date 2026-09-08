import { randomUUID } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { buildTaskPrompt } from './prompt.js'
import { foldExecution, replayExecution } from './fold.js'
import {
  ExecutionError, isActive, opaqueId, TERMINAL,
  type DshExecutionPort, type ExecutionRepository, type ExecutionPreview,
  type ExecutionRun, type ExecutionState, type ExecutionView, type SessionProbe, type TaskInput, type TaskSource,
} from './types.js'

const sameProbe = (a: SessionProbe, b: SessionProbe) => a.sessionId === b.sessionId && a.cwd === b.cwd && a.model === b.model && a.modelIdentity === b.modelIdentity && a.lastSeq === b.lastSeq
const DEFINITE_PRE_ADMISSION = new Set(['execution.changed-before-send','execution.prepare-failed','execution.model-unavailable','session/model-unavailable', 'session/not-found', 'session/invalid-time-zone', 'session/attachment-invalid'])

/** One active MC run per host. Calls DSH once; never interprets a network timeout as permission to resend. */
export class TaskExecutionService {
  private state: ExecutionState = { version: 1, runs: {} }
  private tail: Promise<void> = Promise.resolve()
  private previews = new Map<string, { public: ExecutionPreview; task: TaskInput; probe: SessionProbe }>()
  private unsub?: () => void
  private closed = false
  private fault = ''
  private inflight = new Set<string>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private reconcileAt = new Map<string, number>()
  private lastProgressWrite = 0
  private initialized: Promise<void>

  constructor(
    private readonly tasks: TaskSource,
    private readonly repository: ExecutionRepository,
    private readonly port: DshExecutionPort,
    private readonly now: () => number = Date.now,
    private readonly admissionTimeoutMs = 15_000,
  ) {
    this.initialized = this.initialize()
  }

  private async initialize(): Promise<void> {
    try {
      this.state = await this.repository.load()
      if (this.closed) return
      this.unsub = this.port.subscribe((sessionId, event) => {
        if (this.closed) return
        void this.enqueue(async () => {
          if (this.closed) return
          const run = Object.values(this.state.runs).find(r => r.sessionId === sessionId && isActive(r))
          if (!run) return
          const next = foldExecution(run, event)
          if (next === run) return
          this.state.runs[run.taskId] = next
          if (next.status !== run.status || TERMINAL.has(next.status) || this.now() - this.lastProgressWrite >= 1000) {
            await this.repository.save(this.state); this.lastProgressWrite = this.now()
          }
        }).catch(() => { this.fault = '运行观察记录暂时无法保存，请查看原会话；不会自动重发。' })
      })
      // On plugin/host restart, only read. inspect() does not resume an Agent.
      for (const run of Object.values(this.state.runs)) {
        if (!isActive(run)) continue
        try {
          const { events } = await this.port.inspect(run.sessionId)
          let next = replayExecution(run, events)
          if (!TERMINAL.has(next.status) && next.status !== 'detached') {
            const probe = await this.port.probe(run.sessionId)
            if (!(probe.running || probe.queued) || next.userMessageSeq === undefined) {
              next = { ...next, status: 'unconfirmed', activity: '重开后需要核对原会话', reason: '未自动续跑或重新发送，请核对本轮结果。' }
            }
          }
          this.state.runs[run.taskId] = { ...next, updatedAt: this.now() }
        } catch {
          this.state.runs[run.taskId] = { ...run, status: 'unconfirmed', activity: '无法读取原会话', reason: '运行状态未确认；不会重新发送。' }
        }
      }
      await this.repository.save(this.state)
    } catch {
      this.fault = '运行索引无法安全读取或保存。原始记录未清空，普通任务管理仍可使用。'
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  private requireReady() {
    if (this.closed || this.fault || !this.port.capable()) throw new ExecutionError('execution.unavailable', this.fault || '当前宿主没有可用的真实执行能力。')
  }
  private task(taskId: string): TaskInput {
    if (!opaqueId(taskId)) throw new ExecutionError('execution.arguments', '任务引用无效。')
    const value = this.tasks.snapshot().tasks[taskId]
    if (!value) throw new ExecutionError('execution.task-missing', '任务不存在，请刷新工作台。')
    if (['done','cancelled','failed'].includes(value.phase)) throw new ExecutionError('execution.task-closed', '任务已关闭，请新建任务，不能暗中重开。')
    if (!value.sessionBinding?.sessionId) throw new ExecutionError('execution.session-required', '先在“关联会话”中绑定已配置工作区和模型的会话，再启动。')
    return structuredClone(value)
  }
  private verifyProbe(task: TaskInput, probe: SessionProbe) {
    if (probe.sessionId !== task.sessionBinding?.sessionId || probe.origin === 'subagent') throw new ExecutionError('execution.session-mismatch', '只允许任务明确绑定的普通会话。')
    if (!probe.cwd || !(isAbsolute(probe.cwd) || win32.isAbsolute(probe.cwd))) throw new ExecutionError('execution.cwd-required', '会话缺少明确工作目录，请先在 DSH 中配置工作区。')
    const project = this.tasks.snapshot().projects[task.projectId]
    if (!project) throw new ExecutionError('execution.project-missing', '项目不存在。')
    if (project.workspaceId && project.workspaceId !== probe.workspaceId) throw new ExecutionError('execution.workspace-mismatch', '任务项目与会话工作区不一致，未发送。')
    if (probe.running || probe.queued > 0) throw new ExecutionError('execution.session-busy', '该会话正在执行或有排队消息，请先在原会话处理。')
  }
  private async saveRun(run: ExecutionRun) {
    const next: ExecutionState = { version: 1, runs: { ...this.state.runs, [run.taskId]: structuredClone(run) } }
    await this.repository.save(next)
    this.state = next
  }

  async preview(taskId: string): Promise<ExecutionPreview> {
    await this.initialized
    return this.enqueue(async () => {
      this.requireReady()
      const task = this.task(taskId)
      const probe = await this.port.probe(task.sessionBinding!.sessionId)
      this.verifyProbe(task, probe)
      const project = this.tasks.snapshot().projects[task.projectId]!
      const publicValue: ExecutionPreview = {
        previewId: `preview-${randomUUID()}`, expiresAt: this.now() + 120_000,
        taskId, taskRevision: task.revision, sessionId: probe.sessionId, cwd: probe.cwd, model: probe.model,
        prompt: buildTaskPrompt(task, project.title),
        warning: '将向这个会话发送一次目标，沿用它的模型、工具和权限。提示词要求不提交或推送，但不构成额外沙箱；请不要同时在同一会话追加其他指令。',
      }
      for (const [key, entry] of this.previews) if (entry.public.expiresAt < this.now()) this.previews.delete(key)
      if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(publicValue.previewId, { public: publicValue, task, probe })
      return structuredClone(publicValue)
    })
  }

  async start(previewId: string, intentId: string): Promise<ExecutionRun> {
    await this.initialized
    return this.enqueue(async () => {
      this.requireReady()
      if (!opaqueId(previewId) || !opaqueId(intentId)) throw new ExecutionError('execution.arguments', '启动引用无效。')
      // Same user intent returns the original result, even when the first HTTP response was lost.
      const repeated = Object.values(this.state.runs).find(r => r.intentId === intentId)
      if (repeated) return structuredClone(repeated)
      if (Object.values(this.state.runs).some(isActive)) throw new ExecutionError('execution.busy', '指挥台已有运行或未确认的启动，请先处理该运行。')
      const preview = this.previews.get(previewId)
      if (!preview || preview.public.expiresAt < this.now()) throw new ExecutionError('execution.preview-expired', '预览已失效，请重新查看将发送的内容。')
      const task = this.task(preview.task.taskId)
      if (task.revision !== preview.task.revision || task.sessionBinding?.sessionId !== preview.public.sessionId) throw new ExecutionError('execution.task-changed', '任务或关联会话已变化，请重新预览。')
      const latest = await this.port.probe(preview.public.sessionId)
      this.verifyProbe(task, latest)
      if (!sameProbe(latest, preview.probe)) throw new ExecutionError('execution.session-changed', '会话内容、模型或工作目录发生变化，请重新预览。')
      const ready = await this.port.prepare(preview.public.sessionId)
      this.verifyProbe(task, ready)
      if (ready.cwd !== preview.probe.cwd || ready.model !== preview.probe.model || ready.modelIdentity !== preview.probe.modelIdentity) throw new ExecutionError('execution.session-changed', '恢复后的会话配置已变化，请重新预览。')
      const afterPrepare = this.task(task.taskId)
      if (afterPrepare.revision !== task.revision) throw new ExecutionError('execution.task-changed', '准备期间任务已变化，未发送。')
      if (!this.state.runs[task.taskId] && Object.keys(this.state.runs).length >= 500) throw new ExecutionError('execution.capacity', '运行索引已达到本版容量。')
      const time = this.now()
      const run: ExecutionRun = {
        runId: `execution-${randomUUID()}`, intentId, taskId: task.taskId, projectId: task.projectId, taskRevision: task.revision,
        sessionId: ready.sessionId, cwd: ready.cwd, model: ready.model, requestId: `mc-run-${randomUUID()}`,
        status: 'dispatching', createdAt: time, updatedAt: time, baseSeq: ready.lastSeq, cursor: ready.lastSeq,
        activity: '启动请求已登记，正在交给 DSH', output: '', tools: [], toolCalls: 0, toolErrors: 0,
      }
      await this.saveRun(run) // Failure here means no external command has been sent.
      this.previews.delete(previewId)
      this.inflight.add(run.runId)
      queueMicrotask(() => { void this.dispatch(run, preview.public.prompt, ready.modelIdentity) })
      return structuredClone(run)
    })
  }

  private async dispatch(run: ExecutionRun, prompt: string, modelIdentity?: string): Promise<void> {
    const timer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.closed) return
        const current = this.state.runs[run.taskId]
        if (current?.runId === run.runId && current.status === 'dispatching') {
          await this.saveRun({ ...current, status: 'unconfirmed', activity: '启动结果未确认', reason: 'DSH 尚未返回接收结果；不会重发，请到原会话检查。', updatedAt: this.now() })
        }
      }).catch(() => { this.fault = '运行状态保存失败，请查看原会话。' })
    }, this.admissionTimeoutMs)
    this.timers.add(timer)
    try {
      if (this.closed) throw new Error('closed')
      const taskNow = this.tasks.snapshot().tasks[run.taskId]
      if (!taskNow || taskNow.revision !== run.taskRevision || taskNow.sessionBinding?.sessionId !== run.sessionId
        || ['done', 'failed', 'cancelled'].includes(taskNow.phase)) {
        throw new ExecutionError('execution.changed-before-send', '发送前任务发生变化，未发送。')
      }
      const response = await this.port.send(run.sessionId, run.requestId, prompt, { baseSeq: run.baseSeq, cwd: run.cwd, modelIdentity })
      if (response.accepted !== true) throw new Error('no-receipt')
      await this.enqueue(async () => {
        if (this.closed) return
        const current = this.state.runs[run.taskId]
        if (current?.runId !== run.runId || TERMINAL.has(current.status) || current.userMessageSeq !== undefined || current.status === 'detached') return
        await this.saveRun({ ...current, status: current.stopRequestedAt ? 'stopping' : 'accepted', acceptedAt: this.now(), activity: 'DSH 已接收，等待本次回合事件', updatedAt: this.now() })
      })
    } catch (error: any) {
      await this.enqueue(async () => {
        if (this.closed) return
        const current = this.state.runs[run.taskId]
        if (current?.runId !== run.runId || TERMINAL.has(current.status) || current.userMessageSeq !== undefined || current.status === 'detached') return
        const definite = DEFINITE_PRE_ADMISSION.has(String(error?.code ?? ''))
        await this.saveRun({ ...current, status: definite ? 'failed' : 'unconfirmed',
          activity: definite ? '本次启动未被接受' : '启动结果未确认',
          reason: definite ? '任务、会话或模型配置已变化，请重新核对后启动。' : '请求可能已被接收，不会自动重发，请核对原会话。',
          ...(definite ? { finishedAt: this.now() } : {}), updatedAt: this.now() })
      }).catch(() => { this.fault = '运行状态保存失败，请查看原会话。' })
    } finally { clearTimeout(timer); this.timers.delete(timer); this.inflight.delete(run.runId) }
  }

  async status(taskId: string): Promise<ExecutionView> {
    await this.initialized
    return this.enqueue(async () => {
      if (!opaqueId(taskId)) throw new ExecutionError('execution.arguments', '任务引用无效。')
      let run = this.state.runs[taskId]
      // A low-frequency read repair, not a send retry; no daemon loop or full-history polling per token.
      if (run && isActive(run) && this.now() - (this.reconcileAt.get(run.runId) ?? run.createdAt) > 10_000) {
        this.reconcileAt.set(run.runId, this.now())
        try {
          const { events } = await this.port.inspect(run.sessionId)
          let replayed = replayExecution(run, events)
          if (!TERMINAL.has(replayed.status) && replayed.status !== 'detached') {
            const probe = await this.port.probe(run.sessionId)
            if (!probe.running && !probe.queued && !this.inflight.has(run.runId)) {
              replayed = { ...replayed, status: 'unconfirmed', activity: '会话已空闲，但本次结束记录尚未确认，请核对原会话' }
            }
          }
          if (TERMINAL.has(replayed.status) || replayed.status === 'detached' || replayed.status === 'unconfirmed' || replayed.userMessageSeq !== undefined) {
            run = { ...replayed, updatedAt: this.now() }; await this.saveRun(run)
          }
        } catch { /* Existing status remains; no destructive recovery or re-send. */ }
      }
      const active = Object.values(this.state.runs).find(isActive)
      return { enabled: !this.closed && !this.fault && this.port.capable(), ...(run ? { run: structuredClone(run) } : {}),
        ...(active ? { activeTaskId: active.taskId } : {}), ...(this.fault ? { notice: this.fault } : {}) }
    })
  }

  async stop(taskId: string, runId: string): Promise<ExecutionRun> {
    await this.initialized
    return this.enqueue(async () => {
      this.requireReady()
      const current = this.state.runs[taskId]
      if (!current || current.runId !== runId) throw new ExecutionError('execution.run-changed', '运行已变化，未取消任何会话。')
      if (TERMINAL.has(current.status) || current.releasedAt) return structuredClone(current)
      if (current.status === 'detached') throw new ExecutionError('execution.not-owner', '此会话已有其他人工操作，请直接在原会话停止。')
      if (current.stopRequestedAt) return structuredClone(current)
      const next: ExecutionRun = { ...current, stopRequestedAt: this.now(), updatedAt: this.now(), activity: '正在请求停止本次运行' }
      await this.saveRun(next)
      try {
        const receipt = await this.port.stop(next)
        if (receipt === 'queue-removed') {
          next.status = 'cancelled'; next.finishedAt = this.now(); next.activity = '本次排队消息已移除，未取消其他工作'
        } else if (receipt === 'already-idle') {
          const { events } = await this.port.inspect(next.sessionId)
          const resolved = replayExecution(next, events)
          if (TERMINAL.has(resolved.status)) { await this.saveRun(resolved); return structuredClone(resolved) }
          delete next.stopRequestedAt
          next.status = 'unconfirmed'; next.activity = '尚未确认可停止的本次回合；若随后开始，可再次请求停止'
        } else { next.status = 'stopping'; next.activity = '停止请求已提交，等待 DSH 回合结束事件' }
        await this.saveRun(next)
        return structuredClone(next)
      } catch {
        delete next.stopRequestedAt
        next.status = 'unconfirmed'; next.reason = '无法确认本次消息或回合的独占归属，没有取消其他工作。请在原会话处理。'
        next.activity = '停止结果未确认'
        await this.saveRun(next)
        return structuredClone(next)
      }
    })
  }

  async acknowledge(taskId: string, runId: string): Promise<ExecutionRun> {
    await this.initialized
    return this.enqueue(async () => {
      this.requireReady()
      const run = this.state.runs[taskId]
      if (!run || run.runId !== runId || !['unconfirmed','detached'].includes(run.status)) throw new ExecutionError('execution.arguments', '仅可人工确认未确认的运行。')
      const probe = await this.port.probe(run.sessionId)
      if (probe.running || probe.queued || this.inflight.has(run.runId)) throw new ExecutionError('execution.still-active', '原会话或本次接收请求仍未结束，不能解除占用。')
      const next = { ...run, releasedAt: this.now(), updatedAt: this.now(), activity: '已由用户核对并解除指挥台占用；没有重新执行' }
      await this.saveRun(next); return structuredClone(next)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.initialized
    this.unsub?.(); this.unsub = undefined
    for (const timer of this.timers) clearTimeout(timer)
    await this.tail
    // Do not stop an official Agent merely because this view/plugin is closing.
    if (!this.fault) await this.repository.save(this.state)
  }
}
