import { clip, TERMINAL, type DshEvent, type ExecutionRun } from './types.js'

/** Only official DSH events from the correlated user RPC and its turn can settle a run. */
export function foldExecution(run: ExecutionRun, event: DshEvent): ExecutionRun {
  if (!Number.isSafeInteger(event.seq) || event.seq <= run.cursor || event.seq <= run.baseSeq) return run
  if (TERMINAL.has(run.status) || run.releasedAt !== undefined || run.status === 'detached') return run
  const next: ExecutionRun = { ...run, tools: run.tools.map(x => ({ ...x })), cursor: event.seq }
  const data = event.data ?? {}
  const now = Number.isFinite(event.time) ? event.time : run.updatedAt
  if (event.type === 'turn/start') next.observedTurn = data.turn
  if (event.type === 'user/message' && data.source?.kind === 'user') {
    if (data.source.rpcId === run.requestId) {
      if (!Number.isSafeInteger(next.observedTurn)) {
        next.status = 'unconfirmed'; next.reason = '缺少可关联的 turn/start，请到原会话核对。'
      } else {
        next.turn = next.observedTurn; next.userMessageSeq = event.seq
        next.status = next.stopRequestedAt === undefined ? 'running' : 'stopping'
        next.acceptedAt ??= now; next.activity = 'DSH 已开始处理这次目标'
      }
    } else {
      // Never take credit for, or cancel, work another window injected into this session.
      next.status = 'detached'; next.reason = '此会话出现了另一条人工指令，已停止自动归属，请到原会话查看。'
      next.activity = '会话另有操作'
    }
  }
  if (next.userMessageSeq === undefined || !Number.isSafeInteger(next.turn)) return next
  if (data.turn !== next.turn) return next
  if (event.type === 'step/start') next.activity = '模型正在处理，完整过程可在会话中查看'
  if (event.type === 'tool/call') {
    next.toolCalls += 1
    next.activity = `工具请求：${clip(data.name, 80) || '未知工具'}（授权请求请在原会话处理）`
    if (next.tools.length < 40 && typeof data.callId === 'string') {
      next.tools.push({ callId: data.callId, name: clip(data.name, 80), callSeq: event.seq, status: 'requested' })
    }
  }
  if (event.type === 'tool/result') {
    const callId = data.message?.source?.callId
    // Ordinary tool refusals carry isError in the canonical result block;
    // the optional event-level error contains only additional structured info.
    const failed = data.error !== undefined || (Array.isArray(data.message?.content)
      && data.message.content.some((block: any) => block?.type === 'tool-result'
        && block.toolCallId === callId && block.isError === true))
    if (failed) next.toolErrors += 1
    const tool = next.tools.find(x => x.callId === callId)
    if (tool) { tool.resultSeq = event.seq; tool.status = failed ? 'error' : 'returned' }
    next.activity = failed ? '工具返回错误，查看会话了解处理结果' : '工具已返回；这不等同于测试通过'
  }
  if (event.type === 'assistant/message') {
    const content = data.message?.content
    if (Array.isArray(content)) {
      const texts = content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text)
      if (texts.length) { next.output = texts.join('\n').slice(0, 6000); next.outputSeq = event.seq }
    }
    next.activity = data.interrupted === true ? '已保留中断前的模型输出' : '已收到模型输出'
  }
  if (event.type === 'turn/end') {
    const kind = data.reason?.kind
    next.finishedAt = now
    if (kind === 'completed') { next.status = 'completed'; next.activity = '本轮已结束，任务是否达标仍待你确认' }
    else if (kind === 'aborted') { next.status = 'cancelled'; next.activity = '本轮已取消；外部后台作业请在 DSH 会话中确认' }
    else if (kind === 'interrupted') { next.status = 'interrupted'; next.activity = '运行被中断，不会自动重发' }
    else { next.status = 'failed'; next.activity = '本轮未正常完成'; next.reason = `DSH 回合结束原因：${clip(kind, 60) || '未知'}` }
  }
  next.updatedAt = now
  return next
}

export function replayExecution(run: ExecutionRun, events: readonly DshEvent[]): ExecutionRun {
  // Replay from the saved admission boundary. Progress is a projection, never a second transcript.
  let value: ExecutionRun = {
    ...run, status: 'dispatching', cursor: run.baseSeq, output: '', tools: [], toolCalls: 0, toolErrors: 0,
    activity: '正在核对官方会话记录',
  }
  delete value.observedTurn; delete value.turn; delete value.userMessageSeq; delete value.finishedAt
  delete value.outputSeq; delete value.reason
  for (const event of events) value = foldExecution(value, event)
  return value
}
