import { posix, win32 } from 'node:path'
import { ExecutionError, type DshEvent, type DshExecutionPort, type ExecutionRun, type SessionProbe } from './types.js'

const array = (value: unknown): any[] => Array.isArray(value) ? value : []
const ownRpc = (message: any, requestId: string) => message?.source?.kind === 'user' && message.source.rpcId === requestId

/** Thin adapter to the verified alpha.4 host SessionController, not a second Agent runtime. */
export function createAlpha4ExecutionPort(ctx: any, controller: any, protectedHome?: string): DshExecutionPort {
  // Cordis permits optional lookup through get(); undeclared property access
  // throws even when optional chaining is used. Keep plain standalone hosts usable.
  const service = (name: string) => typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
  const capable = () => ['inspect', 'resolveAgent', 'prompt', 'cancel', 'updateQueue'].every(k => typeof controller?.[k] === 'function')
    && typeof ctx?.on === 'function' && typeof service('agents')?.get === 'function'
  const live = (sessionId: string) => service('agents')?.get?.(sessionId)
  const inspect = async (sessionId: string) => {
    const result = await controller.inspect(sessionId, AbortSignal.timeout(5000))
    if (result?.meta?.id !== sessionId || !Array.isArray(result.events)) throw new ExecutionError('execution.session-unavailable', '官方会话检查没有返回可用结果。')
    return result
  }
  const modelOf = (events: readonly DshEvent[]) => {
    let pending: any, logged: any
    // Match the official selection policy using public events and the public
    // default-model service. A cold preview must not resume the Session.
    for (const event of events) {
      if (event.type === 'model/selection') pending = event.data
      if (event.type === 'request/header') {
        const header = event.data?.header
        const config = header?.config
        if (!config) continue
        logged = { provider: config.provider, model: config.model,
          reasoningEffort: header.adapterDefaults?.reasoningEffort === true ? undefined : config.reasoningEffort }
        if (pending?.provider === config.provider && pending?.model === config.model
          && pending?.reasoningEffort === config.reasoningEffort) pending = undefined
      }
    }
    const value = pending ?? logged ?? service('agentDefaultModel')?.currentSelection?.()
    if (typeof value?.provider !== 'string' || !value.provider || typeof value?.model !== 'string' || !value.model) {
      throw new ExecutionError('execution.model-unavailable', '无法确认此会话将使用的模型，请先在 DSH 中配置模型。')
    }
    return {
      label: `${value.provider} / ${value.model}${value.reasoningEffort === undefined ? '' : ` · ${value.reasoningEffort}`}`,
      identity: JSON.stringify([value.provider, value.model, value.reasoningEffort ?? null]),
    }
  }
  const probe = async (sessionId: string): Promise<SessionProbe> => {
    const result = await inspect(sessionId)
    const agent = live(sessionId)
    // Catch an accidentally bound profile/home as the work directory. This is not an OS sandbox.
    if (protectedHome && typeof result.meta.cwd === 'string') {
      const paths = /^[a-z]:[\\/]/i.test(protectedHome) ? win32 : posix
      const relative = paths.relative(paths.resolve(protectedHome), paths.resolve(result.meta.cwd))
      if (relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))) {
        throw new ExecutionError('execution.protected-workspace', '会话工作目录位于 DSH 数据目录中。请先关联真实项目目录，不会在 profile、会话库或存储目录施工。')
      }
    }
    const registry = service('workspaceRegistry')
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    const workspace = array(workspaces).find(w => array(w.sessionIds).includes(sessionId))
    const model = modelOf(result.events)
    return {
      sessionId, cwd: typeof result.meta.cwd === 'string' ? result.meta.cwd : '', model: model.label, modelIdentity: model.identity,
      running: agent?.status === 'running', queued: array(agent?.inbox?.nextTurn).length + array(agent?.inbox?.nextStep).length,
      lastSeq: result.events.at(-1)?.seq ?? -1,
      ...(typeof result.meta.origin === 'string' ? { origin: result.meta.origin } : {}),
      ...(workspace ? { workspaceId: String(workspace.id) } : {}),
    }
  }
  return {
    capable,
    probe,
    inspect: async sessionId => ({ events: (await inspect(sessionId)).events }),
    prepare: async sessionId => {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved?.error || !resolved?.agent || resolved.agent.id !== sessionId) throw new ExecutionError('execution.prepare-failed', '无法恢复已绑定会话，未发送任务。')
      return probe(sessionId)
    },
    send: async (sessionId, requestId, prompt, expected) => {
      const agent = live(sessionId)
      if (!agent || agent.session?.header?.origin === 'subagent') throw new ExecutionError('execution.prepare-failed', '会话尚未就绪，未发送。')
      const events: DshEvent[] = agent.session.snapshotEvents()
      if (agent.status === 'running' || array(agent.inbox?.nextTurn).length || array(agent.inbox?.nextStep).length
        || (expected && ((events.at(-1)?.seq ?? -1) !== expected.baseSeq || agent.session.header.cwd !== expected.cwd
          || (expected.modelIdentity !== undefined && modelOf(events).identity !== expected.modelIdentity)))) {
        throw new ExecutionError('execution.changed-before-send', '发送前会话已有其他活动，未发送。')
      }
      // requestId is persisted as user/message.source.rpcId by the official controller.
      // This call is NOT assumed idempotent. The coordinator calls it exactly once per admitted intent.
      return controller.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
    },
    stop: async (run: ExecutionRun) => {
      const agent = live(run.sessionId)
      if (!agent) return 'already-idle'
      const queued = [...array(agent.inbox?.nextTurn), ...array(agent.inbox?.nextStep)]
      const ourQueued = queued.filter(message => ownRpc(message, run.requestId))
      if (ourQueued.length === 1 && run.turn === undefined) {
        // Do not drop anyone else's inbox. The official cancel() deliberately keeps queued input.
        controller.updateQueue({ sessionId: run.sessionId, itemId: ourQueued[0].id, action: { kind: 'remove' } })
        return 'queue-removed'
      }
      if (agent.status !== 'running') return 'already-idle'
      // Check live events and ownership immediately before the synchronous cancel admission.
      const events: DshEvent[] = agent.session.snapshotEvents()
      const start = [...events].reverse().find(e => e.type === 'turn/start')
      if (!start || !Number.isSafeInteger(start.data?.turn)) throw new ExecutionError('execution.not-owner', '不能确认活动回合。')
      const tail = events.filter(e => e.seq > start.seq)
      const userMessages = tail.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'user')
      if (tail.some(e => e.type === 'turn/end' && e.data?.turn === start.data.turn)
        || userMessages.length !== 1 || !ownRpc(userMessages[0].data, run.requestId)
        || (run.turn !== undefined && run.turn !== start.data.turn)) {
        throw new ExecutionError('execution.not-owner', '活动回合不再能唯一归属于本任务。')
      }
      controller.cancel({ sessionId: run.sessionId })
      return 'requested'
    },
    subscribe: listener => {
      if (!capable()) return () => undefined
      const dispose = ctx.on('session/event', (session: any, event: DshEvent) => {
        // No token-level chunks are retained or duplicated by this index.
        if (typeof session?.id !== 'string' || !['turn/start','turn/end','step/start','user/message','assistant/message','tool/call','tool/result'].includes(event?.type)) return
        listener(session.id, event)
      })
      return typeof dispose === 'function' ? dispose : () => undefined
    },
  }
}
