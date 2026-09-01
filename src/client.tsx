import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { installBrowserBridge, type BrowserBridge } from './bridge.js'
import { MissionControlClientStore } from './client-store.js'
import type { Approval, EvidenceStatus, EvidenceType, Priority, Task, TaskPhase } from './domain.js'
import { bindExistingSession, createOpenBindSession, unbindSession } from './session-saga.js'

let runtime: any
let bridge: BrowserBridge | undefined
let opened = false
const openListeners = new Set<() => void>()
let hostStore = new MissionControlClientStore()
const setOpened = (value: boolean) => { opened = value; openListeners.forEach((listener) => listener()) }
const useOpened = () => { const [, redraw] = useState(0); useEffect(() => { const listener = () => redraw((value) => value + 1); openListeners.add(listener); return () => { openListeners.delete(listener) } }, []); return opened }
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const values = <T,>(record?: Record<string, T>): T[] => record ? Object.values(record) : []
const listItems = (snapshot: any): any[] => {
  if (Array.isArray(snapshot)) return snapshot
  if (Array.isArray(snapshot?.items)) return snapshot.items
  if (Array.isArray(snapshot?.sessions)) return snapshot.sessions
  if (Array.isArray(snapshot?.ids) && snapshot?.byId && typeof snapshot.byId === 'object') return snapshot.ids.map((id: string) => snapshot.byId[id]).filter(Boolean)
  return []
}
const sessionIdOf = (item: any) => String(item?.sessionId ?? item?.id ?? '')
const sessionName = (item: any) => String((item?.title ?? item?.name ?? item?.summary ?? sessionIdOf(item)) || '未命名会话')
const NEXT: Record<TaskPhase, TaskPhase[]> = {
  draft: ['planning', 'paused', 'blocked', 'cancelled'],
  planning: ['awaiting-plan-approval', 'ready', 'paused', 'blocked', 'cancelled'],
  'awaiting-plan-approval': ['planning', 'ready', 'paused', 'blocked', 'cancelled'],
  ready: ['executing', 'paused', 'blocked', 'cancelled'],
  executing: ['verifying', 'paused', 'blocked', 'failed', 'cancelled'],
  verifying: ['awaiting-review', 'executing', 'paused', 'blocked', 'failed'],
  'awaiting-review': ['ready-for-owner', 'executing', 'paused', 'blocked'],
  'ready-for-owner': ['done', 'executing', 'paused', 'blocked'],
  paused: ['planning', 'ready', 'executing', 'blocked', 'cancelled'],
  blocked: ['planning', 'ready', 'executing', 'paused', 'cancelled'],
  done: [], failed: [], cancelled: [],
}
const PHASE_ORDER: TaskPhase[] = ['awaiting-plan-approval', 'executing', 'verifying', 'awaiting-review', 'blocked', 'ready-for-owner', 'ready', 'planning', 'draft', 'paused', 'done', 'failed', 'cancelled']

function Launcher() { return <button className="mc-launch" onClick={() => setOpened(true)}>任务指挥台</button> }
class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean; message?: string }> {
  state: { failed: boolean; message?: string } = { failed: false }
  static getDerivedStateFromError(error: Error) { return { failed: true, message: error.message.slice(0, 300) } }
  render() {
    return this.state.failed
      ? <div className="mc-backdrop"><section className="mc-panel mc-failed"><div><strong>Mission Control 出错</strong><p>{this.state.message}</p><small>Conversation 与 Session 功能未被关闭。</small></div><button onClick={() => { this.setState({ failed: false }); setOpened(false) }}>关闭工作台</button></section></div>
      : this.props.children
  }
}

function Workbench() {
  const isOpen = useOpened()
  const snapshot = useSyncExternalStore(hostStore.subscribe, hostStore.getSnapshot)
  const state = snapshot.state
  const [projectId, setProjectId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState('')
  const [plan, setPlan] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [evidence, setEvidence] = useState('')
  const [evidenceType, setEvidenceType] = useState<EvidenceType>('test')
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceStatus>('info')
  const [draft, setDraft] = useState('')
  const [sessions, setSessions] = useState<any[]>([])
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [narrow, setNarrow] = useState(() => innerWidth <= 760)
  const heading = useRef<HTMLHeadingElement>(null)

  const projects = values(state?.projects).sort((a, b) => b.updatedAt - a.updatedAt)
  const project = projects.find((item) => item.projectId === projectId) ?? projects[0]
  const tasks: Task[] = values(state?.tasks).filter((item) => item.projectId === project?.projectId)
    .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || b.updatedAt - a.updatedAt)
  const task = tasks.find((item) => item.taskId === taskId) ?? tasks[0]
  const approvals = values(state?.approvals).filter((item) => item.taskId === task?.taskId).sort((a, b) => b.requestedAt - a.requestedAt)
  const activeApproval = task?.activeApprovalId ? state?.approvals[task.activeApprovalId] : undefined
  const taskEvidence = values(state?.evidence).filter((item) => item.taskId === task?.taskId).sort((a, b) => b.createdAt - a.createdAt)
  const filteredSessions = useMemo(() => sessions.filter((item) => sessionName(item).toLowerCase().includes(query.toLowerCase())), [sessions, query])

  useEffect(() => { if (isOpen && snapshot.phase !== 'ready' && snapshot.phase !== 'connecting') void hostStore.connect() }, [isOpen, snapshot.phase])
  useEffect(() => {
    setObjective(task?.objective ?? '')
    setCriteria(task?.acceptanceCriteria.join('\n') ?? '')
    setPlan(task?.planMarkdown ?? '')
    setPriority(task?.priority ?? 'normal')
  }, [task?.taskId, task?.revision])
  useEffect(() => {
    if (!isOpen) return
    heading.current?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpened(false) }
    const resize = () => setNarrow(innerWidth <= 760)
    addEventListener('keydown', key); addEventListener('resize', resize)
    return () => { removeEventListener('keydown', key); removeEventListener('resize', resize) }
  }, [isOpen])

  const mutate = async (command: any, success: string) => {
    const result = await hostStore.mutate(command)
    setMessage(result.error ? result.error.message : success)
    return result
  }
  const addProject = async () => {
    const title = projectTitle.trim(); if (!title || narrow) return
    const projectId = uid('project'); await mutate({ type: 'project.create', projectId, title }, '项目已创建'); setProjectId(projectId); setProjectTitle('')
  }
  const addTask = async () => {
    const title = taskTitle.trim(); if (!title || !project || narrow) return
    const taskId = uid('task'); await mutate({ type: 'task.create', taskId, projectId: project.projectId, title }, '任务已创建'); setTaskId(taskId); setTaskTitle('')
  }
  const saveTask = () => task && !narrow && mutate({ type: 'task.update', taskId: task.taskId, expectedEntityRevision: task.revision, objective, acceptanceCriteria: criteria.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean), planMarkdown: plan, priority }, '任务内容已保存')
  const transition = (phase: TaskPhase) => {
    if (!task || narrow) return
    const blockedReason = phase === 'blocked' ? { code: 'owner-blocked', message: 'Owner marked this task as blocked.' } : undefined
    return mutate({ type: 'task.transition', taskId: task.taskId, expectedEntityRevision: task.revision, phase, ...(blockedReason ? { blockedReason } : {}), ...(phase === 'done' ? { actorRole: 'owner' } : {}) }, `任务已进入 ${phase}`)
  }
  const requestApproval = () => task && !narrow && mutate({ type: 'approval.request', approvalId: uid('approval'), taskId: task.taskId, expectedEntityRevision: task.revision, summary: task.planMarkdown || task.objective || task.title }, '已提交 Owner 计划审批')
  const decide = (decision: 'approved' | 'rejected') => activeApproval && !narrow && mutate({ type: 'approval.decide', approvalId: activeApproval.approvalId, expectedEntityRevision: activeApproval.revision, decision, actorRole: 'owner' }, decision === 'approved' ? '审批已通过' : '审批已拒绝')
  const addEvidence = async () => {
    const summary = evidence.trim(); if (!task || !summary || narrow) return
    await mutate({ type: 'evidence.append', evidenceId: uid('evidence'), taskId: task.taskId, evidenceType, status: evidenceStatus, label: summary.slice(0, 120), summary, producer: { kind: 'human', name: state?.settings.ownerLabel ?? 'Owner' }, redacted: true }, '证据已添加'); setEvidence('')
  }
  const refreshSessions = async () => {
    try { await runtime.sessions.refresh?.(); setSessions(listItems(runtime.sessions.list.getSnapshot())); setMessage('会话已刷新') }
    catch (error: any) { setMessage(error?.message ?? '会话刷新失败') }
  }
  const openSession = async (sessionId: string) => {
    try { await runtime.sessions.open(sessionId); setOpened(false) }
    catch (error: any) { setMessage(error?.message ?? '打开会话失败') }
  }
  const bind = async (sessionId: string) => {
    if (!task || narrow) return
    const result = await bindExistingSession(task, sessionId, hostStore); setMessage(result.status === 'bound' ? '会话已绑定' : result.message)
  }
  const createOpenBind = async () => {
    if (!task || narrow) return
    const result = await createOpenBindSession(task, runtime.sessions, hostStore)
    setMessage(result.status === 'bound' ? '会话已创建、打开并绑定' : result.message)
  }
  const replaceDraft = () => {
    const sessionId = task?.sessionBinding?.sessionId
    if (!sessionId || narrow) return setMessage('请先绑定会话')
    try {
      const scope = runtime.sessions.scope(sessionId); if (!scope) throw new Error('会话不存在')
      runtime.conversation.input.for(scope).setDraft(draft); setMessage('草稿已替换')
    } catch (error: any) { setMessage(error?.message ?? '草稿替换失败') }
  }
  const exportState = async () => {
    try { const result = await hostStore.writeExport(undefined, true); setMessage(`已导出：${result.path}`) }
    catch (error: any) { setMessage(error?.message ?? '导出失败') }
  }

  if (!isOpen) return null
  const bridgeStatus = bridge?.status()
  const capabilities = {
    sessions: Boolean(runtime?.sessions), workspaces: Boolean(runtime?.workspaces), conversation: Boolean(runtime?.conversation),
    slots: Boolean(runtime?.slots), host: snapshot.phase === 'ready', storage: snapshot.host?.storage === 'ready', bridge: bridgeStatus?.state === 'ready',
  }
  return <div className="mc-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpened(false) }}>
    <section className="mc-panel" role="dialog" aria-modal="true" aria-label="Mission Control">
      <header><h2 ref={heading} tabIndex={-1}>MISSION CONTROL</h2><small>Host {snapshot.phase} · state r{state?.revision ?? '-'} · Bridge {bridgeStatus?.state ?? 'edge-only'} {bridgeStatus?.accepted.length ?? 0}/9 · pending {bridgeStatus?.pending ?? 0}{narrow ? ' · 窄屏只读' : ''}</small><span>{message || snapshot.error?.message}</span><button onClick={exportState} disabled={snapshot.phase !== 'ready'}>导出</button><button aria-label="关闭" onClick={() => setOpened(false)}>×</button></header>
      <main>
        <aside><h3>项目</h3>{!narrow && <div className="mc-add"><input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} placeholder="新项目"/><button onClick={addProject}>＋</button></div>}{projects.map((item) => <button className={item.projectId === project?.projectId ? 'active' : ''} onClick={() => { setProjectId(item.projectId); setTaskId('') }} key={item.projectId}><span>{item.title}</span><small>{item.status}</small></button>)}</aside>
        <aside><h3>任务</h3>{project && !narrow && <div className="mc-add"><input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="新任务"/><button onClick={addTask}>＋</button></div>}{tasks.map((item) => <button className={item.taskId === task?.taskId ? 'active' : ''} onClick={() => setTaskId(item.taskId)} key={item.taskId}><span>{item.title}</span><small>{item.phase} · {item.priority}</small></button>)}</aside>
        <article>{snapshot.phase === 'connecting' ? <div className="mc-empty">正在连接…</div> : !state ? <div className="mc-empty"><button onClick={() => hostStore.connect()}>重试连接</button></div> : task ? <>
          <div className="mc-row"><h2>{task.title}</h2>{NEXT[task.phase].map((phase) => <button disabled={narrow || (phase === 'ready' && task.phase === 'awaiting-plan-approval' && activeApproval?.status !== 'approved')} onClick={() => transition(phase)} key={phase}>{phase}</button>)}</div>
          {task.bindingRepair && <div className="mc-alert">绑定待修复：{task.bindingRepair.reason}{task.bindingRepair.sessionId && <button onClick={() => bind(task.bindingRepair!.sessionId!)}>重试绑定</button>}</div>}
          <label>目标<textarea readOnly={narrow} value={objective} onChange={(event) => setObjective(event.target.value)}/></label>
          <label>验收标准（每行一项）<textarea readOnly={narrow} value={criteria} onChange={(event) => setCriteria(event.target.value)}/></label>
          <label>计划<textarea readOnly={narrow} value={plan} onChange={(event) => setPlan(event.target.value)}/></label>
          {!narrow && <div className="mc-row"><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option>low</option><option>normal</option><option>high</option><option>critical</option></select><button onClick={saveTask}>保存任务</button></div>}
          <section className="mc-box"><h4>审批 <b>{activeApproval?.status ?? '未提交'}</b></h4>{activeApproval && <p>计划版本 r{activeApproval.subjectRevision} · {activeApproval.summary}<small>{new Date(activeApproval.requestedAt).toLocaleString()}</small></p>}{!narrow && <div className="mc-row"><button disabled={!['planning','awaiting-plan-approval'].includes(task.phase)} onClick={requestApproval}>提交计划审批</button><button disabled={activeApproval?.status !== 'pending'} onClick={() => decide('approved')}>Owner 通过</button><button disabled={activeApproval?.status !== 'pending'} onClick={() => decide('rejected')}>Owner 拒绝</button></div>}{approvals.map((item: Approval) => <p key={item.approvalId}>{item.status} · subject r{item.subjectRevision}<small>{new Date(item.decidedAt ?? item.requestedAt).toLocaleString()}</small></p>)}</section>
          <section className="mc-box"><h4>证据</h4>{!narrow && <div className="mc-add"><select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value as EvidenceType)}><option>test</option><option>build</option><option>diff</option><option>review</option><option>manual-acceptance</option><option>source</option></select><select value={evidenceStatus} onChange={(event) => setEvidenceStatus(event.target.value as EvidenceStatus)}><option>pass</option><option>fail</option><option>warning</option><option>info</option><option>not-reproduced</option></select><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="证据说明"/><button onClick={addEvidence}>添加</button></div>}{taskEvidence.map((item) => <p key={item.evidenceId}>{item.status} · {item.label}<small>{item.producer.name} · {new Date(item.createdAt).toLocaleString()}</small></p>)}</section>
          <section className="mc-box"><h4>会话 {task.sessionBinding && <b>已绑定</b>}</h4><div className="mc-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话"/><button onClick={refreshSessions}>刷新</button>{!narrow && <button onClick={createOpenBind}>新建并绑定</button>}</div><div className="mc-sessions">{filteredSessions.map((item) => { const sessionId = sessionIdOf(item); return <div key={sessionId}><span>{sessionName(item)}</span>{!narrow && <button onClick={() => bind(sessionId)}>绑定</button>}<button onClick={() => openSession(sessionId)}>打开</button></div> })}</div>{!narrow && <div className="mc-row"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="替换已绑定会话的草稿"/><button onClick={replaceDraft}>替换草稿</button>{task.sessionBinding && <button onClick={async () => setMessage(await unbindSession(task, hostStore) ? '任务已解绑；会话保留' : '解绑失败')}>解绑</button>}</div>}</section>
          <section className="mc-box"><h4>运行能力</h4><p>{Object.entries(capabilities).map(([name, ok]) => `${name}:${ok ? '可用' : '不可用'}`).join(' · ')}</p><p>Plugin {snapshot.host?.pluginVersion ?? 'unknown'} · Certified DSH {snapshot.host?.certifiedDsh ?? 'unknown'}<small>Protocol {snapshot.host?.protocolFingerprint?.slice(0, 12) ?? 'unknown'} · Bridge error {bridgeStatus?.lastError ?? 'none'} · 能力健康不等于安全认证</small></p></section>
          <section className="mc-box audit"><h4>审计时间线（只读）</h4>{state.audit.slice().sort((a, b) => b.stateRevision - a.stateRevision).slice(0, 80).map((item) => <p key={item.auditId}>r{item.stateRevision} · {item.operation} · {item.entityType}<small>{item.actor.name}</small></p>)}</section>
        </> : <div className="mc-empty">先创建项目和任务</div>}</article>
      </main>
    </section>
  </div>
}

const CSS = `.mc-launch{border:1px solid var(--dsw-alias-border-l2,#455);border-radius:5px;padding:7px 10px;background:transparent;color:inherit}.mc-backdrop{position:fixed;inset:0;z-index:2147483000;background:#000a;display:grid;place-items:center}.mc-panel{width:min(1180px,96vw);height:min(780px,92vh);background:var(--dsw-alias-bg-layer-1,#0b1018);color:var(--dsw-alias-label-primary,#eef);border:1px solid #35505b;border-radius:8px;overflow:hidden;box-shadow:0 24px 72px #000}.mc-panel>header{min-height:50px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #2b3b46}.mc-panel>header h2{font-size:14px;letter-spacing:.08em;margin:0}.mc-panel>header span{margin-left:auto;color:#8fc8c3;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-panel button,.mc-panel input,.mc-panel textarea,.mc-panel select{font:inherit;color:inherit;background:#101925;border:1px solid #344854;border-radius:4px;padding:7px}.mc-panel button{cursor:pointer}.mc-panel button:hover,.mc-panel button.active{border-color:#55aaa3;background:#142b31}.mc-panel button:disabled{opacity:.45;cursor:not-allowed}.mc-panel button:focus-visible,.mc-panel input:focus-visible,.mc-panel textarea:focus-visible,.mc-panel select:focus-visible,.mc-panel h2:focus-visible{outline:2px solid #65c7bf;outline-offset:2px}.mc-panel main{height:calc(100% - 51px);display:grid;grid-template-columns:210px 270px minmax(0,1fr)}.mc-panel aside{padding:12px;border-right:1px solid #293944;overflow:auto}.mc-panel aside>button{width:100%;display:flex;justify-content:space-between;gap:8px;margin:5px 0;text-align:left}.mc-panel small{display:block;color:#8ba0ad;font-size:11px}.mc-panel article{padding:18px;overflow:auto}.mc-add,.mc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mc-add input,.mc-row input,.mc-row textarea,.mc-panel label textarea{flex:1}.mc-panel label{display:grid;gap:6px;margin:12px 0}.mc-panel textarea{min-height:68px;resize:vertical}.mc-box{border-top:1px solid #2d4049;padding:14px 0;margin:10px 0}.mc-box h4{margin:0 0 10px}.mc-box h4 b{color:#67c7be;margin-left:8px}.mc-box p{border-bottom:1px solid #25343d;padding:7px 0;margin:0}.mc-box p small{float:right}.mc-sessions{max-height:180px;overflow:auto;margin:8px 0}.mc-sessions>div{display:flex;align-items:center;gap:6px;padding:4px}.mc-sessions span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-empty{height:100%;display:grid;place-items:center;color:#8ba0ad}.mc-alert{border:1px solid #806e32;background:#211f14;padding:10px;margin:8px 0}.audit{max-height:220px;overflow:auto}.mc-failed{height:auto;padding:24px;display:flex;justify-content:space-between;align-items:center}@media(max-width:760px){.mc-backdrop{place-items:stretch}.mc-panel{width:100vw;height:100vh;border-radius:0}.mc-panel>header{align-items:flex-start;padding:10px;flex-wrap:wrap}.mc-panel>header span{max-width:100%;width:100%;margin:0}.mc-panel main{height:auto;display:block}.mc-panel aside,.mc-panel article{border-right:0;border-bottom:1px solid #293944;max-height:none}.mc-panel aside>button{display:inline-flex;width:auto;margin-right:6px}.mc-panel article{padding:12px}.mc-panel h2{font-size:14px}}`

export const inject = ['slots', 'sessions', 'workspaces', 'conversation']
export function apply(ctx: any): void {
  hostStore = new MissionControlClientStore()
  runtime = ctx
  ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = 'dsh-mission-control'; style.textContent = CSS; document.head.appendChild(style); return () => style.remove() })
  ctx.effect(() => { bridge = installBrowserBridge(ctx, { setOpen: setOpened }); return () => { bridge?.dispose(); bridge = undefined; hostStore.close() } })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'mission-control', order: 20 }, Launcher))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'mission-control-header', order: 20 }, Launcher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mission-control-overlay', order: 20 }, () => <Boundary><Workbench /></Boundary>))
}
