import React, { useEffect, useRef, useState } from 'react'
import type { ExecutionPreview, ExecutionRun, ExecutionView, TaskInput } from './types.js'

interface ExecutionClient {
  executionCall(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any>
}
interface Props { task: TaskInput; client: ExecutionClient; hostReady: boolean; readOnly: boolean; onOpenSession: (id: string) => unknown }
const LABEL: Record<ExecutionRun['status'], string> = {
  dispatching:'正在交给 DSH', accepted:'DSH 已接收', running:'正在执行', stopping:'等待停止确认',
  completed:'本轮已结束', failed:'本轮失败', cancelled:'本轮已取消', interrupted:'运行中断',
  unconfirmed:'需要核对', detached:'会话另有操作',
}
const BUSY = new Set(['dispatching','accepted','running','stopping','unconfirmed','detached'])
const messageOf = (error: any) => typeof error?.message === 'string' ? error.message.slice(0, 400) : '暂时无法取得运行状态，请查看原会话。'

/** A real run surface. Legacy phase/approval remains separately labelled human workflow. */
export function TaskExecutionPanel({ task, client, hostReady, readOnly, onOpenSession }: Props) {
  const [view, setView] = useState<ExecutionView>()
  const [preview, setPreview] = useState<ExecutionPreview>()
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const intent = useRef('')
  const sequence = useRef(0)
  const [observeEpoch, setObserveEpoch] = useState(0)
  const uncertainUntil = useRef(0)
  const refresh = async (signal?: AbortSignal) => {
    const ticket = ++sequence.current
    const next: ExecutionView = await client.executionCall('execution.status', { taskId: task.taskId }, signal)
    if (signal?.aborted || ticket !== sequence.current) return
    setView(next)
    if (next.run?.intentId === intent.current) { setUncertain(false); uncertainUntil.current = 0 }
    return next
  }
  const observeAfterAction = () => setObserveEpoch(value => value + 1)
  useEffect(() => {
    if (!hostReady) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await refresh(controller.signal)
        if (controller.signal.aborted) return
        const live = next?.run && BUSY.has(next.run.status) && !next.run.releasedAt
        const waiting = !next?.run && uncertainUntil.current > Date.now()
        if (live || waiting) timer = setTimeout(poll, document.hidden ? 5000 : 1500)
        else if (!next?.run && uncertainUntil.current) setMessage('没有取得本次启动记录。不会自动重发，请先打开原会话核对。')
      } catch (error) { if (!controller.signal.aborted) setMessage(messageOf(error)) }
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer); sequence.current++ }
  }, [task.taskId, client, hostReady, observeEpoch])
  useEffect(() => { setPreview(undefined) }, [task.revision, task.sessionBinding?.sessionId])

  const prepare = async () => {
    setWorking(true); setMessage('')
    try { setPreview(await client.executionCall('execution.preview', { taskId: task.taskId })); intent.current = `intent-${crypto.randomUUID()}` }
    catch (error) { setMessage(messageOf(error)) }
    finally { setWorking(false) }
  }
  const start = async () => {
    if (!preview || !intent.current || working) return
    setWorking(true); setUncertain(true); uncertainUntil.current = Date.now() + 60_000; setMessage('')
    try {
      const run: ExecutionRun = await client.executionCall('execution.start', { previewId: preview.previewId, intentId: intent.current })
      setView({ enabled: true, run, activeTaskId: run.taskId }); setPreview(undefined); setUncertain(false)
    } catch (error: any) {
      setPreview(undefined)
      if (typeof error?.code === 'string' && (error.code.startsWith('execution.') || error.code === 'csrf-refused')) { setUncertain(false); uncertainUntil.current = 0 }
      setMessage(`${messageOf(error)} 没有自动重发。请先查询本次启动或打开原会话核对。`)
    } finally { setWorking(false); observeAfterAction() }
  }
  const stop = async () => {
    const run = view?.run; if (!run) return
    setWorking(true); setMessage('')
    try { await client.executionCall('execution.stop', { taskId: task.taskId, runId: run.runId }) }
    catch (error) { setMessage(messageOf(error)) }
    finally { setWorking(false); observeAfterAction() }
  }
  const acknowledge = async () => {
    if (!view?.run) return
    if (!window.confirm('请先在原会话确认该轮已经结束。此操作只解除指挥台占用，不会停止命令，也不会重新执行。')) return
    setWorking(true)
    try { await client.executionCall('execution.acknowledge', { taskId: task.taskId, runId: view.run.runId, confirmed: true }); await refresh() }
    catch (error) { setMessage(messageOf(error)) }
    finally { setWorking(false) }
  }
  const run = view?.run
  const active = !!run && BUSY.has(run.status) && !run.releasedAt
  const otherBusy = !!view?.activeTaskId && view.activeTaskId !== task.taskId
  const closed = ['done','failed','cancelled'].includes(task.phase)
  const bound = task.sessionBinding?.sessionId
  const sessionId = run?.sessionId ?? bound
  return <section className="mc-execution" data-testid="mc-execution">
    <style>{EXECUTION_CSS}</style>
    <header><div><small>真实运行 · DSH</small><h3>把目标交给 AI</h3></div><strong role="status">{run ? LABEL[run.status] : '尚未启动'}</strong></header>
    {!run && <p>任务目标、验收要求和已有计划会自动带入会话。不必先填写审批流程。</p>}
    {!bound && <p className="mc-execution-note">请先在下方“会话工具”选择一个已配置工作目录和模型的会话。不会猜测项目目录或自动启动生产服务。</p>}
    {otherBusy && <p className="mc-execution-note">指挥台还有另一项运行或未确认的启动，本版不并行发送任务。</p>}
    {view?.notice && <p role="alert">{view.notice}</p>}
    {run && <>
      <p className="mc-execution-activity" aria-live="polite">{run.activity}</p>
      <dl><dt>工作目录</dt><dd>{run.cwd}</dd><dt>模型</dt><dd>{run.model}</dd></dl>
      <p className="mc-execution-note">{run.toolCalls} 次工具请求 · {run.toolErrors} 次明确工具错误。工具返回不等于验收通过。</p>
      {run.reason && <p className="mc-execution-note">{run.reason}</p>}
      {run.output && <details open={['completed','failed','cancelled','interrupted'].includes(run.status)}>
        <summary>本轮模型输出（未独立验证）</summary><pre>{run.output}</pre>
        <small>来源：该会话的 assistant/message · seq {run.outputSeq ?? '未知'}。仅显示最多 6000 字符，完整内容请打开会话。</small>
      </details>}
      {run.tools.length > 0 && <details><summary>实际工具事件（最多 40 条）</summary><ol>{run.tools.map(tool => <li key={tool.callId}>{tool.name} · {tool.status === 'requested' ? '已请求' : tool.status === 'error' ? '返回错误' : '已返回'} · seq {tool.resultSeq ?? tool.callSeq}</li>)}</ol></details>}
    </>}
    {preview && <div className="mc-execution-preview">
      <h4>确认这次执行</h4><dl><dt>工作目录</dt><dd>{preview.cwd}</dd><dt>模型</dt><dd>{preview.model}</dd></dl>
      <p>{preview.warning}</p><details><summary>查看即将发送的完整指令</summary><pre>{preview.prompt}</pre></details>
      <div className="mc-execution-actions"><button type="button" onClick={start} disabled={working || readOnly} className="mc-execution-start">确认发送一次</button><button type="button" onClick={() => setPreview(undefined)} disabled={working}>返回</button></div>
    </div>}
    <div className="mc-execution-actions">
      {!preview && !active && !uncertain && <button type="button" className="mc-execution-start" onClick={prepare} disabled={working || readOnly || !hostReady || !bound || otherBusy || closed || view?.enabled === false}>交给 DSH 执行</button>}
      {active && !['unconfirmed','detached'].includes(run!.status) && <button type="button" onClick={stop} disabled={working || readOnly || !!run?.stopRequestedAt}>停止本轮</button>}
      {sessionId && <button type="button" onClick={() => { void Promise.resolve().then(() => onOpenSession(sessionId)).catch(error => setMessage(messageOf(error))) }}>打开对应会话</button>}
      {(uncertain || message) && <button type="button" onClick={() => { void refresh().catch(error => setMessage(messageOf(error))) }} disabled={working}>查询本次启动</button>}
      {run && ['unconfirmed','detached'].includes(run.status) && !run.releasedAt && <button type="button" onClick={acknowledge} disabled={working || readOnly}>我已核对，解除占用</button>}
    </div>
    {message && <p className="mc-execution-note" role="alert">{message}</p>}
    <small>关闭工作台不会停止 DSH。停止仅针对本轮请求或回合，不承诺终止外部后台进程；权限请求请在原会话处理。</small>
  </section>
}

const EXECUTION_CSS = `
.mc-manual-actions{padding:10px 16px;border-top:1px solid var(--mc-line,#303841);color:var(--mc-muted,#9ba4ac)}
.mc-manual-actions summary,.mc-manual-workflow summary{cursor:pointer;font-size:12px;padding:8px 0}
.mc-execution{border-block:1px solid var(--mc-line,#303841);padding:18px 0;margin:4px 0 18px;color:inherit}
.mc-execution header{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.mc-execution header small,.mc-execution>small,.mc-execution details>small{color:var(--mc-muted,#9ba4ac);font-size:12px}
.mc-execution h3{font-size:18px;margin:2px 0 4px}.mc-execution h4{margin:0 0 10px}
.mc-execution header>strong{font-size:12px;font-weight:500;padding-top:5px;color:var(--mc-teal,#62b6b1)}
.mc-execution p{margin:10px 0;line-height:1.7}.mc-execution .mc-execution-note{font-size:12px;color:var(--mc-muted,#9ba4ac)}
.mc-execution dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:5px;margin:10px 0;font-size:12px}
.mc-execution dt{color:var(--mc-muted,#9ba4ac)}.mc-execution dd{margin:0;overflow-wrap:anywhere}
.mc-execution details{margin:12px 0}.mc-execution summary{cursor:pointer;font-size:13px;line-height:1.7}
.mc-execution pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;font:inherit;font-size:13px;line-height:1.75;background:var(--mc-frame,#0b0e12);padding:12px}
.mc-execution-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.mc-execution-actions button{padding:8px 11px;border:1px solid var(--mc-line,#303841);background:transparent;color:inherit;border-radius:3px;min-height:36px}
.mc-execution-actions .mc-execution-start{border-color:var(--mc-teal,#62b6b1);color:var(--mc-teal,#62b6b1)}
.mc-execution-preview{margin-top:14px;padding:14px;background:var(--mc-rail,#12171d);border:1px solid var(--mc-line,#303841)}
.mc-execution li{margin:5px 0;font-size:12px;overflow-wrap:anywhere}
@media(max-width:760px){.mc-execution{padding:14px 0}.mc-execution header{display:block}.mc-execution dl{grid-template-columns:1fr;gap:3px}}
@media(prefers-reduced-motion:reduce){.mc-execution *{transition:none!important}}
`
