import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { installBrowserBridge, type BrowserBridge } from './bridge.js'
import { MissionControlClientStore } from './client-store.js'
import type { Approval, Task, TaskStatus } from './domain.js'

let runtime: any
let bridge: BrowserBridge | undefined
let opened = false
const openListeners = new Set<() => void>()
const hostStore = new MissionControlClientStore()
const setOpened = (value: boolean) => { opened = value; openListeners.forEach((listener) => listener()) }
const useOpened = () => { const [, redraw] = useState(0); useEffect(() => { const listener = () => redraw((v) => v + 1); openListeners.add(listener); return () => { openListeners.delete(listener) } }, []); return opened }
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const values = <T,>(record?: Record<string, T>): T[] => record ? Object.values(record) : []
const listItems = (snapshot: any): any[] => {
  if (Array.isArray(snapshot)) return snapshot
  if (Array.isArray(snapshot?.items)) return snapshot.items
  if (Array.isArray(snapshot?.sessions)) return snapshot.sessions
  if (Array.isArray(snapshot?.ids) && snapshot?.byId && typeof snapshot.byId === 'object') return snapshot.ids.map((id: string) => snapshot.byId[id]).filter(Boolean)
  return []
}
const sid = (item: any) => String(item?.sessionId ?? item?.id ?? '')
const sessionName = (item: any) => String((item?.title ?? item?.name ?? item?.summary ?? sid(item)) || '未命名会话')
const NEXT: Record<TaskStatus, TaskStatus[]> = { draft: ['ready','cancelled'], ready: ['running','cancelled'], running: ['blocked','awaiting-approval','cancelled'], blocked: ['running','cancelled'], 'awaiting-approval': ['running','done','cancelled'], done: [], cancelled: [] }

function Launcher() { return <button className="mc-launch" onClick={() => setOpened(true)}>任务指挥台</button> }
class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="mc-backdrop"><section className="mc-panel mc-failed"><strong>Mission Control 出错</strong><button onClick={() => { this.setState({ failed: false }); setOpened(false) }}>关闭</button></section></div> : this.props.children }
}

function Workbench() {
  const isOpen = useOpened()
  const snapshot = useSyncExternalStore(hostStore.subscribe, hostStore.getSnapshot)
  const state = snapshot.state
  const [projectId, setProjectId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [taskName, setTaskName] = useState('')
  const [criteria, setCriteria] = useState('')
  const [evidence, setEvidence] = useState('')
  const [draft, setDraft] = useState('')
  const [sessions, setSessions] = useState<any[]>([])
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [narrow, setNarrow] = useState(() => innerWidth <= 760)

  const projects = values(state?.projects)
  const project = projects.find((item) => item.id === projectId) ?? projects[0]
  const tasks: Task[] = values(state?.tasks).filter((item) => item.projectId === project?.id)
  const task = tasks.find((item) => item.id === taskId) ?? tasks[0]
  const approvals = values(state?.approvals).filter((item) => item.taskId === task?.id)
  const activeApproval = task?.activeApprovalId ? state?.approvals[task.activeApprovalId] : undefined
  const taskEvidence = values(state?.evidence).filter((item) => item.taskId === task?.id)
  const filteredSessions = useMemo(() => sessions.filter((item) => sessionName(item).toLowerCase().includes(query.toLowerCase())), [sessions, query])

  useEffect(() => { if (isOpen && snapshot.phase !== 'ready' && snapshot.phase !== 'connecting') void hostStore.connect() }, [isOpen, snapshot.phase])
  useEffect(() => { setCriteria(task?.acceptanceCriteria ?? '') }, [task?.id, task?.acceptanceCriteria])
  useEffect(() => {
    if (!isOpen) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpened(false) }
    const resize = () => setNarrow(innerWidth <= 760)
    addEventListener('keydown', key); addEventListener('resize', resize)
    return () => { removeEventListener('keydown', key); removeEventListener('resize', resize) }
  }, [isOpen])

  const mutate = async (command: any, success: string) => { const result = await hostStore.mutate(command); setMessage(result.error ? result.error.message : success) }
  const addProject = async () => { const name = projectName.trim(); if (!name || narrow) return; const id = uid('project'); await mutate({ type: 'project.create', id, name }, '项目已创建'); setProjectId(id); setProjectName('') }
  const addTask = async () => { const title = taskName.trim(); if (!title || !project || narrow) return; const id = uid('task'); await mutate({ type: 'task.create', id, projectId: project.id, title }, '任务已创建'); setTaskId(id); setTaskName('') }
  const saveCriteria = () => task && !narrow && mutate({ type: 'task.edit', taskId: task.id, acceptanceCriteria: criteria }, '验收标准已保存')
  const transition = (status: TaskStatus) => task && !narrow && mutate({ type: 'task.transition', taskId: task.id, status }, `任务已进入 ${status}`)
  const requestApproval = () => task && !narrow && mutate({ type: 'approval.request', id: uid('approval'), taskId: task.id }, '已提交 Owner 审批')
  const decide = (decision: 'approved' | 'rejected') => activeApproval && !narrow && mutate({ type: 'approval.decide', approvalId: activeApproval.id, decision, actorRole: 'owner' }, decision === 'approved' ? '审批已通过' : '审批已拒绝')
  const addEvidence = async () => { const text = evidence.trim(); if (!task || !text || narrow) return; await mutate({ type: 'evidence.add', id: uid('evidence'), taskId: task.id, text }, '证据已添加'); setEvidence('') }
  const refreshSessions = async () => { try { await runtime.sessions.refresh?.(); setSessions(listItems(runtime.sessions.list.getSnapshot())); setMessage('会话已刷新') } catch (error: any) { setMessage(error?.message ?? '会话刷新失败') } }
  const openSession = async (sessionId: string) => { try { await runtime.sessions.open(sessionId); setOpened(false) } catch (error: any) { setMessage(error?.message ?? '打开会话失败') } }
  const bind = (sessionId: string) => task && !narrow && mutate({ type: 'task.bind-session', taskId: task.id, sessionId }, '会话已绑定')
  const createOpenBind = async () => {
    if (!task || narrow) return
    try {
      const made = await runtime.sessions.create({}); const sessionId = sid(made) || (typeof made === 'string' ? made : '')
      if (!sessionId) throw new Error('创建会话未返回 ID')
      await runtime.sessions.open(sessionId)
      const result = await hostStore.mutate({ type: 'task.bind-session', taskId: task.id, sessionId })
      setMessage(result.error ? `会话已保留；绑定失败，可从列表重试：${result.error.message}` : '会话已创建、打开并绑定')
    } catch (error: any) { setMessage(error?.message ?? '创建会话失败；任务未绑定') }
  }
  const replaceDraft = () => {
    if (!task?.sessionId || narrow) return setMessage('请先绑定会话')
    try { runtime.conversation.input.for(runtime.sessions.scope(task.sessionId)).setDraft(draft); setMessage('草稿已替换') }
    catch (error: any) { setMessage(error?.message ?? '草稿替换失败') }
  }

  if (!isOpen) return null
  const bridgeStatus = bridge?.status()
  return <div className="mc-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpened(false) }}>
    <section className="mc-panel" role="dialog" aria-modal="true" aria-label="Mission Control">
      <header><strong>MISSION CONTROL</strong><small>v0.1.0 · Host {snapshot.phase} r{state?.revision ?? '-'} · Bridge {bridgeStatus?.state ?? 'edge-only'} {bridgeStatus?.accepted.length ?? 0}/9 · pending {bridgeStatus?.pending ?? 0}{narrow ? ' · 窄屏只读' : ''}</small><span>{message || snapshot.error?.message}</span><button onClick={() => setOpened(false)}>×</button></header>
      <main>
        <aside><h3>项目</h3>{!narrow && <div className="mc-add"><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="新项目"/><button onClick={addProject}>＋</button></div>}{projects.map((item) => <button className={item.id === project?.id ? 'active' : ''} onClick={() => { setProjectId(item.id); setTaskId('') }} key={item.id}>{item.name}</button>)}</aside>
        <aside><h3>任务</h3>{project && !narrow && <div className="mc-add"><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="新任务"/><button onClick={addTask}>＋</button></div>}{tasks.map((item) => <button className={item.id === task?.id ? 'active' : ''} onClick={() => setTaskId(item.id)} key={item.id}><span>{item.title}</span><small>{item.status}</small></button>)}</aside>
        <article>{snapshot.phase === 'connecting' ? <div className="mc-empty">正在连接…</div> : !state ? <div className="mc-empty"><button onClick={() => hostStore.connect()}>重试连接</button></div> : task ? <>
          <div className="mc-row"><h2>{task.title}</h2>{NEXT[task.status].map((status) => <button disabled={narrow} onClick={() => transition(status)} key={status}>{status}</button>)}</div>
          <label>验收标准<textarea readOnly={narrow} value={criteria} onChange={(event) => setCriteria(event.target.value)}/>{!narrow && <button onClick={saveCriteria}>保存</button>}</label>
          <section className="mc-box"><h4>审批 <b>{activeApproval?.state ?? '未提交'}</b></h4>{!narrow && <div className="mc-row"><button onClick={requestApproval}>重新提交审批</button><button disabled={activeApproval?.state !== 'pending'} onClick={() => decide('approved')}>Owner 通过</button><button disabled={activeApproval?.state !== 'pending'} onClick={() => decide('rejected')}>Owner 拒绝</button></div>}{approvals.map((item: Approval) => <p key={item.id}>{item.state}<small>{item.decidedAt ?? item.requestedAt}</small></p>)}</section>
          <section className="mc-box"><h4>证据</h4>{!narrow && <div className="mc-add"><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="链接或说明"/><button onClick={addEvidence}>添加</button></div>}{taskEvidence.map((item) => <p key={item.id}>{item.text}<small>{item.createdAt}</small></p>)}</section>
          <section className="mc-box"><h4>会话 {task.sessionId && <b>已绑定</b>}</h4><div className="mc-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话"/><button onClick={refreshSessions}>刷新</button>{!narrow && <button onClick={createOpenBind}>新建并绑定</button>}</div><div className="mc-sessions">{filteredSessions.map((item) => { const sessionId = sid(item); return <div key={sessionId}><span>{sessionName(item)}</span>{!narrow && <button onClick={() => bind(sessionId)}>绑定</button>}<button onClick={() => openSession(sessionId)}>打开</button></div> })}</div>{!narrow && <div className="mc-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="替换已绑定会话的草稿"/><button onClick={replaceDraft}>写入草稿</button>{task.sessionId && <button onClick={() => mutate({ type: 'task.unbind-session', taskId: task.id }, '任务已解绑；会话保留')}>解绑</button>}</div>}</section>
          <section className="mc-box audit"><h4>审计时间线（只读）</h4>{state.audit.slice().reverse().slice(0, 50).map((item) => <p key={item.id}>{item.action} · {item.entityType}<small>{item.at}</small></p>)}</section>
        </> : <div className="mc-empty">先创建项目和任务</div>}</article>
      </main>
    </section>
  </div>
}

const CSS = `.mc-launch{border:1px solid var(--dsw-alias-border-l2,#455);border-radius:6px;padding:7px 10px;background:transparent;color:inherit}.mc-backdrop{position:fixed;inset:0;z-index:2147483000;background:#0009;display:grid;place-items:center}.mc-panel{width:min(1180px,96vw);height:min(780px,92vh);background:var(--dsw-alias-bg-layer-1,#0b1018);color:var(--dsw-alias-label-primary,#eef);border:1px solid #4ba3a0;border-radius:10px;overflow:hidden;box-shadow:0 25px 80px #000}.mc-panel>header{height:48px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid #345}.mc-panel>header span{margin-left:auto;color:#7fd2c9}.mc-panel button,.mc-panel input,.mc-panel textarea{font:inherit;color:inherit;background:#101925;border:1px solid #34485c;border-radius:5px;padding:7px}.mc-panel button{cursor:pointer}.mc-panel button:hover,.mc-panel button.active{border-color:#48c5ba;background:#163238}.mc-panel button:focus-visible,.mc-panel input:focus-visible,.mc-panel textarea:focus-visible{outline:2px solid #56d6ca;outline-offset:2px}.mc-panel main{height:calc(100% - 49px);display:grid;grid-template-columns:210px 250px 1fr}.mc-panel aside{padding:12px;border-right:1px solid #293744;overflow:auto}.mc-panel aside>button{width:100%;display:flex;justify-content:space-between;margin:5px 0;text-align:left}.mc-panel small{display:block;color:#8ba0b2;font-size:11px}.mc-panel article{padding:18px;overflow:auto}.mc-add,.mc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mc-add input,.mc-row input,.mc-row textarea,.mc-panel label textarea{flex:1}.mc-panel label{display:grid;gap:6px;margin:14px 0}.mc-panel textarea{min-height:70px;resize:vertical}.mc-box{border-top:1px solid #2d4050;padding:14px 0;margin:10px 0}.mc-box h4{margin:0 0 10px}.mc-box h4 b{color:#55d6c8;margin-left:8px}.mc-box p{border-bottom:1px solid #253544;padding:7px 0;margin:0}.mc-box p small{float:right}.mc-sessions{max-height:180px;overflow:auto;margin:8px 0}.mc-sessions>div{display:flex;align-items:center;gap:6px;padding:4px}.mc-sessions span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-empty{height:100%;display:grid;place-items:center;color:#8ba0b2}.audit{max-height:180px;overflow:auto}.mc-failed{height:auto;padding:24px;display:flex;justify-content:space-between}@media(max-width:760px){.mc-panel{width:100vw;height:100vh;border-radius:0}.mc-panel main{grid-template-columns:30% 30% 40%}.mc-panel article{padding:8px}.mc-panel h2{font-size:15px}}`

export const inject = ['slots', 'sessions', 'workspaces', 'conversation']
export function apply(ctx: any): void {
  runtime = ctx
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-mission-control'; style.textContent = CSS; document.head.appendChild(style); return () => style.remove() })
  ctx.effect(() => { bridge = installBrowserBridge(ctx, { setOpen: setOpened }); return () => { bridge?.dispose(); bridge = undefined; hostStore.close() } })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'mission-control', order: 20 }, Launcher))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'mission-control-header', order: 20 }, Launcher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mission-control-overlay', order: 20 }, () => <Boundary><Workbench /></Boundary>))
}
