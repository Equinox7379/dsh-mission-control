import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { installBrowserBridge, type BrowserBridge } from './bridge.js'
import { MissionControlClientStore } from './client-store.js'
import { TaskExecutionPanel } from './execution/panel.js'
import type { AuditEvent, Evidence, EvidenceStatus, EvidenceType, Priority, Task, TaskPhase } from './domain.js'
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
const shortId = (value?: string) => value ? value.replace(/^(project|task|session|approval|evidence)-/u, '').slice(0, 12) : '—'
const clock = (time?: number) => time ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(time) : '—'

const NEXT: Record<TaskPhase, TaskPhase[]> = {
  draft: ['planning', 'paused', 'blocked', 'cancelled'],
  planning: ['awaiting-plan-approval', 'paused', 'blocked', 'cancelled'],
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
const PHASE_LABEL: Record<TaskPhase, string> = {
  draft: '草稿', planning: '规划中', 'awaiting-plan-approval': '待审批', ready: '待执行', executing: '执行中',
  verifying: '验证中', 'awaiting-review': '待复核', 'ready-for-owner': '待 Owner 确认', done: '已完成', paused: '已暂停',
  blocked: '受阻', failed: '失败', cancelled: '已取消',
}
const PRIORITY_LABEL: Record<Priority, string> = { low: '低', normal: '中', high: '高', critical: '紧急' }
const EVIDENCE_STATUS_LABEL: Record<EvidenceStatus, string> = { pass: '通过', fail: '失败', warning: '警告', info: '记录', 'not-reproduced': '未复现' }
const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  test: '测试', diff: '变更', build: '构建', browser: '浏览器', screenshot: '截图', log: '日志', artifact: '产物', review: '复核',
  'manual-acceptance': '人工验收', source: '来源',
}
const STAGES: Array<{ label: string; phases: TaskPhase[] }> = [
  { label: '计划', phases: ['draft', 'planning'] },
  { label: '待审批', phases: ['awaiting-plan-approval'] },
  { label: '执行', phases: ['ready', 'executing'] },
  { label: '验证', phases: ['verifying', 'awaiting-review'] },
  { label: 'Owner 确认', phases: ['ready-for-owner', 'done'] },
]
const OFF_TRACK = new Set<TaskPhase>(['paused', 'blocked', 'failed', 'cancelled'])
const stageOf = (phase: TaskPhase) => STAGES.findIndex((stage) => stage.phases.includes(phase))

function Launcher() { return <button className="mc-launch" onClick={() => setOpened(true)}>任务指挥台</button> }

class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean; message?: string }> {
  state: { failed: boolean; message?: string } = { failed: false }
  static getDerivedStateFromError(error: Error) { return { failed: true, message: error.message.slice(0, 300) } }
  render() {
    return this.state.failed
      ? <div className="mc-backdrop"><section className="mc-panel mc-failed"><div><strong>任务指挥台暂时无法显示</strong><p>{this.state.message}</p><small>对话和会话功能仍然可用。</small></div><button onClick={() => { this.setState({ failed: false }); setOpened(false) }}>关闭工作台</button></section></div>
      : this.props.children
  }
}

function PhaseRail({ phase }: { phase: TaskPhase }) {
  const current = stageOf(phase)
  return <div className="mc-phase-rail" aria-label={`当前阶段：${PHASE_LABEL[phase]}`}>
    {STAGES.map((stage, index) => <div className={`mc-stage ${index < current ? 'complete' : ''} ${index === current ? 'current' : ''}`} key={stage.label}>
      <i aria-hidden="true" /><span>{stage.label}</span>
    </div>)}
    {OFF_TRACK.has(phase) && <b className={`mc-offtrack ${phase}`}>{PHASE_LABEL[phase]}</b>}
  </div>
}

function Workbench() {
  const isOpen = useOpened()
  const snapshot = useSyncExternalStore(hostStore.subscribe, hostStore.getSnapshot)
  const state = snapshot.state
  const [projectId, setProjectId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [addingProject, setAddingProject] = useState(false)
  const [addingTask, setAddingTask] = useState(false)
  const [editing, setEditing] = useState(false)
  const [taskFilter, setTaskFilter] = useState<'all' | 'open' | 'review'>('all')
  const [taskSort, setTaskSort] = useState<'phase' | 'recent'>('recent')
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
  const projectTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    values(state?.tasks).forEach((item) => { counts[item.projectId] = (counts[item.projectId] ?? 0) + 1 })
    return counts
  }, [state?.revision])
  const allProjectTasks: Task[] = values(state?.tasks).filter((item) => item.projectId === project?.projectId)
  const tasks = allProjectTasks.filter((item) => {
    if (taskFilter === 'open') return !['done', 'failed', 'cancelled'].includes(item.phase)
    if (taskFilter === 'review') return ['awaiting-plan-approval', 'awaiting-review', 'ready-for-owner'].includes(item.phase)
    return true
  }).sort((a, b) => taskSort === 'recent'
    ? b.updatedAt - a.updatedAt
    : PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || b.updatedAt - a.updatedAt)
  const task = tasks.find((item) => item.taskId === taskId) ?? tasks[0]
  const approvals = values(state?.approvals).filter((item) => item.taskId === task?.taskId).sort((a, b) => b.requestedAt - a.requestedAt)
  const activeApproval = task?.activeApprovalId ? state?.approvals[task.activeApprovalId] : undefined
  const taskEvidence = values(state?.evidence).filter((item) => item.taskId === task?.taskId).sort((a, b) => b.createdAt - a.createdAt)
  const relatedIds = useMemo(() => new Set([task?.taskId, ...approvals.map((item) => item.approvalId), ...taskEvidence.map((item) => item.evidenceId)].filter(Boolean)), [task?.taskId, approvals.map((item) => item.approvalId).join('|'), taskEvidence.map((item) => item.evidenceId).join('|')])
  const taskAudit: AuditEvent[] = (state?.audit ?? []).filter((item) => relatedIds.has(item.entityId)).sort((a, b) => b.time - a.time)
  const timeline = useMemo(() => [
    ...taskEvidence.map((item) => ({ id: item.evidenceId, time: item.createdAt, kind: 'evidence' as const, evidence: item })),
    ...taskAudit.map((item) => ({ id: item.auditId, time: item.time, kind: 'audit' as const, audit: item })),
  ].sort((a, b) => b.time - a.time).slice(0, 10), [taskEvidence.map((item) => `${item.evidenceId}:${item.revision}`).join('|'), taskAudit.map((item) => item.auditId).join('|')])
  const filteredSessions = useMemo(() => sessions.filter((item) => sessionName(item).toLowerCase().includes(query.toLowerCase())), [sessions, query])

  useEffect(() => { if (isOpen && snapshot.phase !== 'ready' && snapshot.phase !== 'connecting') void hostStore.connect() }, [isOpen, snapshot.phase])
  useEffect(() => {
    setObjective(task?.objective ?? '')
    setCriteria(task?.acceptanceCriteria.join('\n') ?? '')
    setPlan(task?.planMarkdown ?? '')
    setPriority(task?.priority ?? 'normal')
    setEditing(false)
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
    try {
      const result = await hostStore.mutate(command)
      setMessage(result.error ? result.error.message : success)
      return result
    } catch (error: any) {
      setMessage(error?.message ?? '操作失败')
      return undefined
    }
  }
  const addProject = async () => {
    const title = projectTitle.trim(); if (!title || narrow) return
    const newProjectId = uid('project')
    const result = await mutate({ type: 'project.create', projectId: newProjectId, title }, '项目已创建')
    if (!result?.error) { setProjectId(newProjectId); setProjectTitle(''); setAddingProject(false) }
  }
  const addTask = async () => {
    const title = taskTitle.trim(); if (!title || !project || narrow) return
    const newTaskId = uid('task')
    const result = await mutate({ type: 'task.create', taskId: newTaskId, projectId: project.projectId, title }, '任务已创建')
    if (!result?.error) { setTaskId(newTaskId); setTaskTitle(''); setAddingTask(false) }
  }
  const saveTask = async () => {
    if (!task || narrow) return
    const result = await mutate({ type: 'task.update', taskId: task.taskId, expectedEntityRevision: task.revision, objective, acceptanceCriteria: criteria.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean), planMarkdown: plan, priority }, '任务内容已保存')
    if (!result?.error) setEditing(false)
  }
  const transition = (phase: TaskPhase) => {
    if (!task || narrow) return
    const blockedReason = phase === 'blocked' ? { code: 'owner-blocked', message: 'Owner marked this task as blocked.' } : undefined
    return mutate({ type: 'task.transition', taskId: task.taskId, expectedEntityRevision: task.revision, phase, ...(blockedReason ? { blockedReason } : {}), ...(phase === 'done' ? { actorRole: 'owner' } : {}) }, `任务已进入「${PHASE_LABEL[phase]}」`)
  }
  const requestApproval = () => task && !narrow && mutate({ type: 'approval.request', approvalId: uid('approval'), taskId: task.taskId, expectedEntityRevision: task.revision, summary: task.planMarkdown || task.objective || task.title }, '已提交 Owner 计划审批')
  const decide = (decision: 'approved' | 'rejected') => activeApproval && !narrow && mutate({ type: 'approval.decide', approvalId: activeApproval.approvalId, expectedEntityRevision: activeApproval.revision, decision, actorRole: 'owner' }, decision === 'approved' ? '审批已通过' : '审批已拒绝')
  const addEvidence = async () => {
    const summary = evidence.trim(); if (!task || !summary || narrow) return
    const result = await mutate({ type: 'evidence.append', evidenceId: uid('evidence'), taskId: task.taskId, evidenceType, status: evidenceStatus, label: summary.slice(0, 120), summary, producer: { kind: 'human', name: state?.settings.ownerLabel ?? 'Owner' }, redacted: true }, '证据已添加')
    if (!result?.error) setEvidence('')
  }
  const refreshState = async () => {
    setMessage('正在刷新…')
    const result = await hostStore.refresh()
    setMessage(result.error ? result.error.message : '已刷新到最新状态')
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
  const healthyEvidence = taskEvidence.filter((item) => item.status === 'pass').length
  const primaryAction = (() => {
    if (!task || narrow) return undefined
    if (task.phase === 'draft') return { label: '开始规划', hint: '补充目标和计划，再交给 Owner 审批。', run: () => transition('planning') }
    if (task.phase === 'planning') return { label: '提交审批', hint: '计划准备好后，提交给 Owner 确认。', run: requestApproval }
    if (task.phase === 'awaiting-plan-approval') {
      if (activeApproval?.status === 'pending') return { label: '通过计划', hint: 'Owner 确认计划后，任务才能进入执行。', run: () => decide('approved') }
      if (activeApproval?.status === 'approved') return { label: '进入待执行', hint: '只将手工记录改为待执行，不会自动发送任务。', run: () => transition('ready') }
      if (activeApproval?.status === 'rejected') return { label: '返回规划', hint: '根据 Owner 意见调整计划后重新提交。', run: () => transition('planning') }
      return { label: '提交审批', hint: '当前还没有有效的 Owner 审批请求。', run: requestApproval }
    }
    if (task.phase === 'ready') return { label: '标记为执行中', hint: '只更新手工记录。真实运行请使用上方“交给 DSH 执行”。', run: () => transition('executing') }
    if (task.phase === 'executing') return { label: '开始验证', hint: '执行完成后收集证据并进入验证。', run: () => transition('verifying') }
    if (task.phase === 'verifying') return { label: '提交复核', hint: '确认关键证据齐备，再提交复核。', run: () => transition('awaiting-review') }
    if (task.phase === 'awaiting-review') return { label: '交给 Owner', hint: '复核完成后交由 Owner 做最终确认。', run: () => transition('ready-for-owner') }
    if (task.phase === 'ready-for-owner') return { label: '确认完成', hint: 'Owner 确认目标与证据无误后关闭任务。', run: () => transition('done') }
    if (task.phase === 'paused' || task.phase === 'blocked') return { label: '恢复手工流程', hint: '只修改任务记录，不重启或续跑 AI。', run: () => transition(NEXT[task.phase][0]) }
    return undefined
  })()

  return <div className="mc-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpened(false) }}>
    <section className="mc-panel" role="dialog" aria-modal="true" aria-label="任务指挥台">
      <header className="mc-topbar">
        <h2 ref={heading} tabIndex={-1}>任务指挥台</h2>
        <div className="mc-connection"><i className={snapshot.phase === 'ready' ? 'ok' : ''} aria-hidden="true" />主机{snapshot.phase === 'ready' ? '已连接' : snapshot.phase === 'connecting' ? '连接中' : '未连接'}<span>state r{state?.revision ?? '—'} · bridge {bridgeStatus?.state ?? 'edge-only'} {bridgeStatus?.accepted.length ?? 0}/9 · pending {bridgeStatus?.pending ?? 0}</span></div>
        {(message || snapshot.error?.message) && <output title={message || snapshot.error?.message}>{message || snapshot.error?.message}</output>}
        <button className="mc-top-action" onClick={exportState} disabled={snapshot.phase !== 'ready'}>导出报告</button>
        <button className="mc-icon-button" aria-label="刷新" title="刷新" onClick={refreshState} disabled={snapshot.phase === 'connecting'}>↻</button>
        <button className="mc-icon-button" aria-label="关闭" title="关闭" onClick={() => setOpened(false)}>×</button>
      </header>

      <main className="mc-layout">
        <aside className="mc-project-rail">
          <div className="mc-section-head"><h3>项目</h3>{!narrow && <button onClick={() => setAddingProject((value) => !value)}>＋ 新建项目</button>}</div>
          {addingProject && !narrow && <div className="mc-create-row"><input autoFocus value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addProject() }} placeholder="项目名称" /><button onClick={addProject}>创建</button></div>}
          <nav aria-label="项目列表">
            {projects.map((item) => <button className={item.projectId === project?.projectId ? 'active' : ''} onClick={() => { setProjectId(item.projectId); setTaskId('') }} key={item.projectId}>
              <span>{item.title}</span><b>{projectTaskCounts[item.projectId] ?? 0}</b>
            </button>)}
          </nav>
          {!projects.length && <div className="mc-rail-empty">还没有项目。<br />从上方新建一个开始。</div>}
          <footer>共 {projects.length} 个项目</footer>
        </aside>

        <section className="mc-task-queue">
          <div className="mc-queue-head">
            <h3>任务列表</h3>
            <label>筛选：<select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as typeof taskFilter)}><option value="all">全部</option><option value="open">进行中</option><option value="review">待处理</option></select></label>
            <label>排序：<select value={taskSort} onChange={(event) => setTaskSort(event.target.value as typeof taskSort)}><option value="recent">最新</option><option value="phase">阶段</option></select></label>
            {project && !narrow && <button className="mc-new-task" onClick={() => setAddingTask((value) => !value)}>＋</button>}
          </div>
          {addingTask && project && !narrow && <div className="mc-create-row"><input autoFocus value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addTask() }} placeholder="任务名称" /><button onClick={addTask}>创建</button></div>}
          <div className="mc-task-list">
            {tasks.map((item) => {
              const itemApproval = item.activeApprovalId ? state?.approvals[item.activeApprovalId] : undefined
              const itemEvidence = values(state?.evidence).filter((entry) => entry.taskId === item.taskId).length
              return <button className={`mc-task-strip ${item.taskId === task?.taskId ? 'active' : ''}`} onClick={() => setTaskId(item.taskId)} key={item.taskId}>
                <span className="mc-task-copy"><strong>{item.title}</strong><small>{project?.title}</small></span>
                <span className="mc-task-meta"><em className={`mc-dot phase-${item.phase}`} />{PHASE_LABEL[item.phase]}</span>
                <span className="mc-task-meta"><em className={`mc-dot priority-${item.priority}`} />{PRIORITY_LABEL[item.priority]}</span>
                <span className="mc-task-meta approval">{itemApproval?.status === 'approved' ? '已确认' : itemApproval?.status === 'pending' ? '待审批' : '—'}<small>{itemApproval?.status === 'approved' ? state?.settings.ownerLabel : ''}</small></span>
                <span className="mc-doc-count">▤ {itemEvidence}</span>
              </button>
            })}
            {project && !tasks.length && <div className="mc-queue-empty"><strong>{taskFilter === 'all' ? '这个项目还没有任务' : '当前筛选下没有任务'}</strong><span>{taskFilter === 'all' ? '点击右上角的＋创建第一项任务。' : '切换到“全部”查看完整队列。'}</span></div>}
            {!project && <div className="mc-queue-empty"><strong>先选择一个项目</strong><span>项目中的任务会出现在这里。</span></div>}
          </div>
          <footer>共 {tasks.length} 项任务</footer>
        </section>

        <article className="mc-task-detail">
          {snapshot.phase === 'connecting' ? <div className="mc-detail-empty"><span className="mc-loader" /><strong>正在连接任务主机</strong><small>连接完成后会自动恢复当前工作。</small></div>
            : !state ? <div className="mc-detail-empty"><strong>暂时无法读取任务</strong><small>{snapshot.error?.message ?? '主机没有返回可用状态。'}</small><button onClick={() => hostStore.connect()}>重新连接</button></div>
              : task ? <>
                <div className="mc-detail-scroll">
                  <header className="mc-task-titlebar">
                    <div><small>当前任务</small><h1>{task.title}</h1><p>{project?.title}</p></div>
                    <div className="mc-task-identity"><span>任务 ID：{shortId(task.taskId)}</span>{!narrow && <button onClick={() => setEditing((value) => !value)}>{editing ? '收起编辑' : '编辑任务'}</button>}</div>
                  </header>

                  <TaskExecutionPanel key={task.taskId} task={task} client={hostStore} hostReady={snapshot.phase === 'ready'} readOnly={narrow} onOpenSession={openSession} />
                  <details className="mc-manual-workflow"><summary>手工流程记录（不控制实际运行）</summary><PhaseRail phase={task.phase} /></details>

                  {task.bindingRepair && <div className="mc-alert"><strong>会话绑定需要修复</strong><span>{task.bindingRepair.reason}</span>{task.bindingRepair.sessionId && !narrow && <button onClick={() => bind(task.bindingRepair!.sessionId!)}>重试绑定</button>}</div>}

                  <section className="mc-objective">
                    <h3>目标</h3>
                    <p>{task.objective || '尚未填写目标。打开“编辑任务”补充这项任务要达成的结果。'}</p>
                  </section>

                  {editing && !narrow && <section className="mc-editor">
                    <div className="mc-editor-grid">
                      <label>目标<textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="这项任务最终要解决什么？" /></label>
                      <label>验收标准（每行一项）<textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="怎样才算真正完成？" /></label>
                      <label className="wide">执行计划<textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="写下清晰、可执行的计划。" /></label>
                    </div>
                    <div className="mc-editor-actions"><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option value="low">低</option><option value="normal">中</option><option value="high">高</option><option value="critical">紧急</option></select></label><button onClick={() => setEditing(false)}>取消</button><button className="accent" onClick={saveTask}>保存任务</button></div>
                  </section>}

                  <div className="mc-detail-grid">
                    <section className="mc-gate">
                      <header><h3>Owner 确认</h3><b className={activeApproval?.status ?? 'none'}>{activeApproval ? ({ pending: '待审批', approved: '已通过', rejected: '已拒绝', superseded: '已替换', expired: '已过期' } as Record<string, string>)[activeApproval.status] : '未提交'}</b></header>
                      <p className="mc-person">♙ <span>{state.settings.ownerLabel}</span></p>
                      <p className="mc-gate-state">◷ {activeApproval ? `${clock(activeApproval.decidedAt ?? activeApproval.requestedAt)} · 计划 r${activeApproval.subjectRevision}` : '等待提交计划'}</p>
                      {!narrow && <div className="mc-gate-actions">
                        {['planning', 'awaiting-plan-approval'].includes(task.phase) && activeApproval?.status !== 'pending' && <button onClick={requestApproval}>发送审批请求</button>}
                        {activeApproval?.status === 'pending' && <><button onClick={() => decide('approved')}>Owner 通过</button><button className="quiet-danger" onClick={() => decide('rejected')}>拒绝</button></>}
                      </div>}
                    </section>

                    <section className="mc-evidence-summary">
                      <header><h3>证据</h3><span>{taskEvidence.length} 条 · {healthyEvidence} 条通过</span></header>
                      <div className="mc-evidence-list">
                        {taskEvidence.slice(0, 3).map((item: Evidence) => <div key={item.evidenceId}><i className={item.status}>▤</i><p><strong>{item.label}</strong><small>{EVIDENCE_TYPE_LABEL[item.type]} · {clock(item.createdAt)}</small></p></div>)}
                        {!taskEvidence.length && <p className="mc-inline-empty">还没有证据。验证工作开始后，把关键结果记录在这里。</p>}
                      </div>
                      {!narrow && <details className="mc-inline-form"><summary>＋ 添加证据</summary><div><select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value as EvidenceType)}>{Object.entries(EVIDENCE_TYPE_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={evidenceStatus} onChange={(event) => setEvidenceStatus(event.target.value as EvidenceStatus)}>{Object.entries(EVIDENCE_STATUS_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="简要说明结果" /><button onClick={addEvidence}>添加</button></div></details>}
                    </section>
                  </div>

                  <section className="mc-session-panel">
                    <header><h3>会话</h3>{task.sessionBinding && <b>已连接</b>}</header>
                    {task.sessionBinding ? <div className="mc-bound-session"><span className="mc-terminal-icon">›_</span><p><strong>{shortId(task.sessionBinding.sessionId)}</strong><small>开始于 {clock(task.sessionBinding.boundAt)} · 与当前任务保持关联</small></p><button onClick={() => openSession(task.sessionBinding!.sessionId)}>打开会话</button></div>
                      : <div className="mc-bound-session empty"><span className="mc-terminal-icon">›_</span><p><strong>尚未绑定会话</strong><small>绑定后可以从任务直接回到执行现场。</small></p>{!narrow && <button onClick={createOpenBind}>新建并绑定</button>}</div>}
                    {!narrow && <details className="mc-session-tools"><summary>会话工具</summary><div className="mc-session-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已有会话" /><button onClick={refreshSessions}>刷新列表</button></div><div className="mc-session-results">{filteredSessions.map((item) => { const sessionId = sessionIdOf(item); return <div key={sessionId}><span>{sessionName(item)}</span><button onClick={() => bind(sessionId)}>绑定</button><button onClick={() => openSession(sessionId)}>打开</button></div> })}{!filteredSessions.length && <small>刷新后可从这里选择已有会话。</small>}</div>{task.sessionBinding && <div className="mc-draft-tools"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="替换已绑定会话的输入草稿" /><button onClick={replaceDraft}>替换草稿</button><button onClick={async () => setMessage(await unbindSession(task, hostStore) ? '任务已解绑；会话保留' : '解绑失败')}>解除绑定</button></div>}</details>}
                  </section>

                  <section className="mc-spine-section">
                    <header><div><h3>任务记录</h3><small>证据与关键操作按时间连续排列</small></div><span>{timeline.length} 条最近记录</span></header>
                    <div className="mc-spine">
                      {timeline.map((item) => item.kind === 'evidence'
                        ? <div className="mc-spine-item evidence" key={`e-${item.id}`}><i /><time>{clock(item.time)}</time><p><strong>{EVIDENCE_STATUS_LABEL[item.evidence.status]} · {item.evidence.label}</strong><small>{EVIDENCE_TYPE_LABEL[item.evidence.type]} · {item.evidence.producer.name}</small></p></div>
                        : <div className="mc-spine-item audit" key={`a-${item.id}`}><i /><time>{clock(item.time)}</time><p><strong>{item.audit.summary || item.audit.operation}</strong><small>r{item.audit.stateRevision} · {item.audit.actor.name}</small></p></div>)}
                      {!timeline.length && <p className="mc-inline-empty">推进任务后，审批、证据和状态变化会依次出现在这里。</p>}
                    </div>
                  </section>

                  <details className="mc-advanced">
                    <summary>更多状态与运行信息</summary>
                    {!narrow && <div className="mc-status-actions"><span>手动切换：</span>{NEXT[task.phase].map((phase) => <button disabled={phase === 'ready' && task.phase === 'awaiting-plan-approval' && activeApproval?.status !== 'approved'} onClick={() => transition(phase)} key={phase}>{PHASE_LABEL[phase]}</button>)}</div>}
                    <p>{Object.entries(capabilities).map(([name, ok]) => `${name}:${ok ? '可用' : '不可用'}`).join(' · ')}</p>
                    <small>Plugin {snapshot.host?.pluginVersion ?? 'unknown'} · Certified DSH {snapshot.host?.certifiedDsh ?? 'unknown'} · Protocol {snapshot.host?.protocolFingerprint?.slice(0, 12) ?? 'unknown'} · Bridge error {bridgeStatus?.lastError ?? 'none'}</small>
                  </details>
                </div>

                <details className="mc-manual-actions"><summary>可选：手工流程与任务确认</summary><footer className="mc-next-action">
                  <div><strong>{narrow ? '窄屏只读' : primaryAction ? '手工记录（不启动 AI）' : task.phase === 'done' ? '任务已完成' : '当前没有可执行动作'}</strong><span>{narrow ? '可查看全部状态；请在桌面宽屏中执行修改与推进。' : primaryAction?.hint ?? (task.phase === 'done' ? '目标已由 Owner 确认完成，全部记录仍可查阅。' : `当前状态：${PHASE_LABEL[task.phase]}`)}</span></div>
                  {primaryAction && <button className="mc-primary" onClick={primaryAction.run}>{primaryAction.label}<span>→</span></button>}
                </footer></details>
              </>
                : <div className="mc-detail-empty"><strong>{taskFilter === 'all' ? '请选择或创建一项任务' : '筛选结果为空'}</strong><small>{taskFilter === 'all' ? '任务的目标、审批、证据与会话会集中显示在这里。' : '切换到“全部”继续查看任务。'}</small></div>}
        </article>
      </main>
    </section>
  </div>
}

const CSS = `
.mc-launch{border:1px solid var(--dsw-alias-border-l2,#394048);border-radius:3px;padding:7px 10px;background:transparent;color:inherit;font:inherit}
.mc-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.76);display:grid;place-items:center;padding:24px}
.mc-panel{--mc-frame:#0b0e12;--mc-rail:#12171d;--mc-raised:#1c2229;--mc-line:#303841;--mc-line-soft:#252c33;--mc-text:#ebeff2;--mc-muted:#8a939d;--mc-teal:#62b6b1;--mc-amber:#f4c44e;--mc-red:#e07178;width:min(1280px,96vw);height:min(744px,92vh);display:flex;flex-direction:column;overflow:hidden;background:var(--mc-frame);color:var(--mc-text);border:1px solid #39434d;border-radius:4px;box-shadow:0 28px 90px rgba(0,0,0,.72);font-family:"Microsoft YaHei UI","Segoe UI Variable","PingFang SC",sans-serif;font-size:13px;line-height:1.5}
.mc-panel *{box-sizing:border-box}
.mc-panel button,.mc-panel input,.mc-panel textarea,.mc-panel select{font:inherit;color:inherit}
.mc-panel button{cursor:pointer}
.mc-panel button:disabled{cursor:not-allowed;opacity:.38}
.mc-panel button:focus-visible,.mc-panel input:focus-visible,.mc-panel textarea:focus-visible,.mc-panel select:focus-visible,.mc-panel summary:focus-visible,.mc-panel h2:focus-visible{outline:2px solid var(--mc-teal);outline-offset:2px}
.mc-topbar{height:58px;flex:0 0 58px;display:flex;align-items:center;gap:14px;padding:0 14px;border-bottom:1px solid var(--mc-line);background:#0f1318}
.mc-topbar h2{margin:0;font:600 19px/1 "Bahnschrift SemiCondensed","Microsoft YaHei UI",sans-serif;letter-spacing:.02em;white-space:nowrap}
.mc-connection{display:flex;align-items:center;gap:7px;color:#bdc5cc;white-space:nowrap;font:12px/1.4 "Cascadia Mono",Consolas,monospace}
.mc-connection i{width:7px;height:7px;border-radius:50%;background:#69737c}.mc-connection i.ok{background:var(--mc-teal)}
.mc-connection span{color:#6f7983}.mc-topbar output{max-width:28%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c5a84f;font-size:12px}
.mc-top-action,.mc-icon-button{border:1px solid var(--mc-line);border-radius:3px;background:#13181e;color:#c9d0d6;height:34px;padding:0 12px}.mc-top-action{margin-left:auto}.mc-top-action:hover,.mc-icon-button:hover{background:#1b2229;border-color:#515c66}.mc-icon-button{width:36px;padding:0;font-size:20px}
.mc-layout{min-height:0;flex:1;display:grid;grid-template-columns:220px 375px minmax(0,1fr)}
.mc-project-rail,.mc-task-queue{min-width:0;display:flex;flex-direction:column;background:var(--mc-rail);border-right:1px solid var(--mc-line)}
.mc-section-head,.mc-queue-head{height:58px;flex:0 0 58px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--mc-line-soft)}
.mc-section-head h3,.mc-queue-head h3{margin:0;font:600 17px/1 "Bahnschrift SemiCondensed","Microsoft YaHei UI",sans-serif;white-space:nowrap}
.mc-section-head button,.mc-queue-head button,.mc-queue-head select{border:1px solid var(--mc-line);border-radius:3px;background:#151b21;padding:7px 9px}.mc-section-head button{margin-left:auto;color:#b9c1c8}.mc-queue-head label{display:flex;align-items:center;gap:4px;color:var(--mc-muted);font-size:11px;white-space:nowrap}.mc-queue-head h3+label{margin-left:auto}.mc-new-task{width:32px}
.mc-create-row{display:flex;gap:6px;padding:9px 10px;border-bottom:1px solid var(--mc-line-soft);background:#10151a}.mc-create-row input{min-width:0;flex:1;border:1px solid var(--mc-line);border-radius:2px;background:#0c1116;padding:7px 8px}.mc-create-row button{border:1px solid #467b78;border-radius:2px;background:#17302f;padding:7px 9px;color:#bfe0de}
.mc-project-rail nav{padding:8px 7px;overflow:auto}.mc-project-rail nav>button{position:relative;width:100%;height:43px;display:flex;align-items:center;justify-content:space-between;gap:10px;border:0;border-radius:2px;background:transparent;color:#c6cdd3;padding:0 12px;text-align:left}.mc-project-rail nav>button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-project-rail nav>button b{color:#9aa4ad;font:400 13px/1 "Cascadia Mono",Consolas,monospace}.mc-project-rail nav>button:hover{background:#181e24}.mc-project-rail nav>button.active{background:#242a31;color:#fff}.mc-project-rail nav>button.active:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;background:var(--mc-teal)}.mc-project-rail nav>button.active b{color:#d7dddf}
.mc-project-rail footer,.mc-task-queue>footer{margin-top:auto;flex:0 0 43px;display:flex;align-items:center;padding:0 16px;border-top:1px solid var(--mc-line-soft);color:#8f98a1}.mc-rail-empty{padding:20px 14px;color:#707a84;line-height:1.8}
.mc-task-list{min-height:0;flex:1;overflow:auto;padding:10px}
.mc-task-strip{width:100%;min-height:76px;display:grid;grid-template-columns:minmax(145px,1.5fr) 70px 45px 70px 34px;align-items:center;gap:7px;margin-bottom:8px;padding:11px 11px;border:1px solid var(--mc-line-soft);border-radius:2px;background:#181d23;color:#cbd2d7;text-align:left;box-shadow:none}.mc-task-strip:hover{border-color:#46515b;background:#1c2228}.mc-task-strip.active{position:relative;border-color:#355a60;background:#20272e}.mc-task-strip.active:before{content:"";position:absolute;left:-1px;top:-1px;bottom:-1px;width:3px;background:var(--mc-teal)}
.mc-task-copy{min-width:0}.mc-task-copy strong,.mc-task-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-task-copy strong{color:#eef1f3;font-size:14px;font-weight:600}.mc-task-copy small{margin-top:3px;color:#77818b;font-size:11px}.mc-task-meta{display:flex;align-items:center;gap:6px;color:#bac2c8;font-size:12px;white-space:nowrap}.mc-task-meta.approval{display:block}.mc-task-meta.approval small{display:block;color:#75808a;font:10px/1.4 "Cascadia Mono",Consolas,monospace}.mc-dot{width:7px;height:7px;border-radius:50%;background:#7e8992;flex:0 0 auto}.mc-dot.phase-executing,.mc-dot.phase-ready,.mc-dot.phase-done,.mc-dot.priority-normal{background:var(--mc-teal)}.mc-dot.phase-awaiting-plan-approval,.mc-dot.phase-awaiting-review,.mc-dot.phase-ready-for-owner,.mc-dot.priority-high,.mc-dot.priority-critical{background:var(--mc-amber)}.mc-dot.phase-blocked,.mc-dot.phase-failed{background:var(--mc-red)}.mc-doc-count{color:#b9c1c7;font:12px/1 "Cascadia Mono",Consolas,monospace;white-space:nowrap}
.mc-queue-empty,.mc-detail-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:8px;text-align:center;color:var(--mc-muted)}.mc-queue-empty{min-height:210px}.mc-queue-empty strong,.mc-detail-empty strong{color:#cbd2d7}.mc-queue-empty span,.mc-detail-empty small{max-width:320px}.mc-detail-empty button{margin-top:8px;border:1px solid #477f7b;border-radius:2px;background:#17302f;padding:8px 12px}.mc-loader{width:22px;height:22px;border:2px solid #33414a;border-top-color:var(--mc-teal);border-radius:50%;animation:mc-spin .8s linear infinite}
.mc-task-detail{min-width:0;min-height:0;display:flex;flex-direction:column;background:#0f1318}.mc-detail-scroll{min-height:0;flex:1;overflow:auto;padding:16px 18px 20px}.mc-task-titlebar{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding-bottom:12px}.mc-task-titlebar small{display:block;color:#8d97a0}.mc-task-titlebar h1{margin:3px 0 1px;font:600 22px/1.2 "Bahnschrift SemiCondensed","Microsoft YaHei UI",sans-serif}.mc-task-titlebar p{margin:0;color:#9ba4ac}.mc-task-identity{display:flex;align-items:center;gap:10px;color:#7d8790;font:11px/1.3 "Cascadia Mono",Consolas,monospace;white-space:nowrap}.mc-task-identity button{border:1px solid var(--mc-line);border-radius:2px;background:#151a20;padding:6px 8px;color:#b8c0c6}
.mc-phase-rail{position:relative;min-height:52px;display:grid;grid-template-columns:repeat(5,1fr);align-items:start;padding:12px 12px 8px;border:1px solid var(--mc-line);border-radius:2px;background:#12171c}.mc-phase-rail:before{content:"";position:absolute;left:10%;right:10%;top:20px;height:1px;background:#6a747c}.mc-stage{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;color:#aab2b9;white-space:nowrap}.mc-stage i{width:14px;height:14px;border:1px solid #c1c7cc;border-radius:50%;background:#12171c}.mc-stage.complete i{border-color:var(--mc-teal);background:var(--mc-teal)}.mc-stage.current{color:#e7edef}.mc-stage.current i{border-color:var(--mc-teal);background:var(--mc-teal);box-shadow:0 0 0 4px rgba(98,182,177,.13)}.mc-offtrack{position:absolute;right:8px;bottom:3px;color:var(--mc-amber);font-size:10px;font-weight:500}.mc-offtrack.blocked,.mc-offtrack.failed{color:var(--mc-red)}
.mc-alert{display:flex;align-items:center;gap:10px;margin-top:10px;padding:9px 11px;border:1px solid #695d31;background:#201d13;color:#d7c789}.mc-alert span{flex:1}.mc-alert button{border:1px solid #7d713d;background:#292516;padding:5px 8px}
.mc-objective{padding:12px 10px 10px;border-bottom:1px solid var(--mc-line)}.mc-objective h3,.mc-detail-grid h3,.mc-session-panel h3,.mc-spine-section h3{margin:0;font:600 15px/1.2 "Bahnschrift SemiCondensed","Microsoft YaHei UI",sans-serif}.mc-objective p{margin:7px 0 0;color:#b8c0c7;line-height:1.75}
.mc-editor{margin-top:10px;border:1px solid #3d4851;background:#12171c;padding:12px}.mc-editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mc-editor label{display:grid;gap:5px;color:#9fa8b0}.mc-editor label.wide{grid-column:1/-1}.mc-editor textarea{width:100%;min-height:76px;resize:vertical;border:1px solid var(--mc-line);border-radius:2px;background:#0b1015;padding:8px}.mc-editor label.wide textarea{min-height:94px}.mc-editor-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px}.mc-editor-actions label{display:flex;align-items:center;gap:6px;margin-right:auto}.mc-editor-actions select,.mc-editor-actions button{border:1px solid var(--mc-line);border-radius:2px;background:#171d23;padding:7px 10px}.mc-editor-actions button.accent{border-color:#477f7b;background:#17302f;color:#c7e4e2}
.mc-detail-grid{display:grid;grid-template-columns:minmax(220px,.78fr) minmax(280px,1.22fr);gap:10px;margin-top:10px}.mc-gate,.mc-evidence-summary,.mc-session-panel,.mc-spine-section{border:1px solid var(--mc-line);border-radius:2px;background:#11161b}.mc-gate,.mc-evidence-summary{padding:12px}.mc-gate>header,.mc-evidence-summary>header,.mc-session-panel>header,.mc-spine-section>header{display:flex;align-items:center;justify-content:space-between;gap:10px}.mc-gate header b{color:var(--mc-amber);font-size:12px}.mc-gate header b.approved{color:var(--mc-teal)}.mc-gate header b.rejected{color:var(--mc-red)}.mc-person,.mc-gate-state{margin:12px 0 0;color:#b7bfc5}.mc-person{font-size:14px}.mc-person span{margin-left:7px}.mc-gate-state{color:#8a949d}.mc-gate-actions{display:flex;gap:7px;margin-top:14px}.mc-gate-actions button{flex:1;border:1px solid var(--mc-line);border-radius:2px;background:#1b2127;padding:8px}.mc-gate-actions button:hover{border-color:#4d5a64}.mc-gate-actions .quiet-danger{flex:0 0 auto;color:#d98a8f}
.mc-evidence-summary>header span{color:#8e98a1;font-size:11px}.mc-evidence-list{margin-top:8px}.mc-evidence-list>div{display:flex;gap:9px;padding:6px 0;border-bottom:1px solid var(--mc-line-soft)}.mc-evidence-list>div:last-child{border-bottom:0}.mc-evidence-list i{color:#8d99a3;font-style:normal}.mc-evidence-list i.pass{color:var(--mc-teal)}.mc-evidence-list i.fail{color:var(--mc-red)}.mc-evidence-list i.warning{color:var(--mc-amber)}.mc-evidence-list p{min-width:0;margin:0}.mc-evidence-list strong,.mc-evidence-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-evidence-list strong{font-weight:500;color:#cbd2d7}.mc-evidence-list small{color:#77818a;font-size:10px}.mc-inline-empty{margin:8px 0;color:#77818a;line-height:1.6}.mc-inline-form{margin-top:7px}.mc-inline-form summary,.mc-session-tools summary,.mc-advanced summary{cursor:pointer;color:#9eb4b3;list-style:none}.mc-inline-form summary::-webkit-details-marker,.mc-session-tools summary::-webkit-details-marker,.mc-advanced summary::-webkit-details-marker{display:none}.mc-inline-form>div{display:grid;grid-template-columns:90px 90px minmax(120px,1fr) auto;gap:6px;margin-top:8px}.mc-inline-form select,.mc-inline-form input,.mc-inline-form button{min-width:0;border:1px solid var(--mc-line);border-radius:2px;background:#0d1217;padding:6px}
.mc-session-panel{margin-top:10px;padding:12px}.mc-session-panel>header b{color:var(--mc-teal);font-size:12px}.mc-bound-session{display:flex;align-items:center;gap:10px;margin-top:10px}.mc-terminal-icon{width:36px;height:36px;display:grid;place-items:center;border:1px solid var(--mc-line);border-radius:2px;background:#181e24;font:14px/1 "Cascadia Mono",Consolas,monospace;color:#d4dade}.mc-bound-session p{min-width:0;flex:1;margin:0}.mc-bound-session strong,.mc-bound-session small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-bound-session strong{font:12px/1.5 "Cascadia Mono",Consolas,monospace}.mc-bound-session small{color:#7f8992}.mc-bound-session>button{border:1px solid var(--mc-line);border-radius:2px;background:#1a2026;padding:8px 12px}.mc-bound-session.empty strong{font-family:inherit}.mc-session-tools{margin-top:10px;padding-top:9px;border-top:1px solid var(--mc-line-soft)}.mc-session-search{display:flex;gap:6px;margin-top:8px}.mc-session-search input{min-width:0;flex:1}.mc-session-search input,.mc-session-search button,.mc-session-results button,.mc-draft-tools button{border:1px solid var(--mc-line);border-radius:2px;background:#0d1217;padding:6px}.mc-session-results{max-height:140px;overflow:auto;margin-top:6px}.mc-session-results>div{display:flex;align-items:center;gap:6px;padding:4px 0}.mc-session-results>div span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mc-session-results>small{color:#737e87}.mc-draft-tools{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;margin-top:8px}.mc-draft-tools textarea{min-height:54px;resize:vertical;border:1px solid var(--mc-line);border-radius:2px;background:#0d1217;padding:7px}
.mc-spine-section{margin-top:10px;padding:12px}.mc-spine-section>header small{display:block;margin-top:3px;color:#77818a}.mc-spine-section>header>span{color:#77818a;font-size:11px}.mc-spine{margin-top:10px}.mc-spine-item{position:relative;display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px;margin-left:4px;padding:0 0 13px 16px;border-left:1px solid #39434c}.mc-spine-item:last-child{padding-bottom:2px}.mc-spine-item>i{position:absolute;left:-4px;top:5px;width:7px;height:7px;border-radius:50%;background:#77838c}.mc-spine-item.evidence>i{background:var(--mc-teal)}.mc-spine-item time{color:#737e87;font:10px/1.5 "Cascadia Mono",Consolas,monospace}.mc-spine-item p{min-width:0;margin:0}.mc-spine-item strong,.mc-spine-item small{display:block}.mc-spine-item strong{color:#c4cbd0;font-weight:500}.mc-spine-item small{color:#77818a;font-size:10px}
.mc-advanced{margin-top:10px;padding:9px 2px;color:#7e8992}.mc-advanced>p{margin:10px 0 2px;font:10px/1.6 "Cascadia Mono",Consolas,monospace}.mc-advanced>small{font:10px/1.5 "Cascadia Mono",Consolas,monospace}.mc-status-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px}.mc-status-actions button{border:1px solid var(--mc-line);border-radius:2px;background:#151a20;padding:5px 8px;color:#aeb6bc}
.mc-next-action{flex:0 0 78px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:10px 18px;border-top:1px solid var(--mc-line);background:#101419}.mc-next-action strong,.mc-next-action span{display:block}.mc-next-action strong{font:600 15px/1.4 "Bahnschrift SemiCondensed","Microsoft YaHei UI",sans-serif}.mc-next-action>div>span{margin-top:3px;color:#8b959e}.mc-primary{min-width:160px;height:46px;display:flex;align-items:center;justify-content:center;gap:18px;border:1px solid #ffd65b;border-radius:2px;background:var(--mc-amber);color:#17150d!important;font-weight:700}.mc-primary:hover{background:#ffd45d}.mc-primary span{font-size:19px}
.mc-failed{height:auto;min-height:180px;padding:24px;display:flex;flex-direction:row;justify-content:space-between;align-items:center}.mc-failed button{border:1px solid var(--mc-line);background:#181e24;padding:8px 12px}
@keyframes mc-spin{to{transform:rotate(360deg)}}
@media(max-width:1100px){.mc-panel{width:98vw}.mc-layout{grid-template-columns:185px 315px minmax(0,1fr)}.mc-task-strip{grid-template-columns:minmax(120px,1fr) 64px 38px 30px}.mc-task-meta.approval{display:none}.mc-topbar output{display:none}.mc-detail-grid{grid-template-columns:1fr}.mc-stage{font-size:11px;gap:5px}}
@media(max-width:820px){.mc-backdrop{padding:8px}.mc-layout{grid-template-columns:155px 250px minmax(0,1fr)}.mc-connection span{display:none}.mc-task-strip{grid-template-columns:minmax(110px,1fr) 65px 30px}.mc-task-meta:nth-of-type(3){display:none}.mc-task-identity span{display:none}.mc-detail-scroll{padding:12px}.mc-inline-form>div{grid-template-columns:1fr 1fr}.mc-inline-form input{grid-column:1/-1}.mc-inline-form button{grid-column:2}.mc-phase-rail{padding-left:5px;padding-right:5px}.mc-stage span{font-size:10px}}
@media(max-width:760px){.mc-backdrop{place-items:stretch;padding:0}.mc-panel{width:100vw;height:100vh;border:0;border-radius:0}.mc-topbar{height:auto;min-height:58px;flex-wrap:wrap;padding:9px 10px}.mc-topbar h2{font-size:17px}.mc-connection{order:3;width:100%}.mc-topbar output,.mc-top-action{display:none}.mc-layout{display:flex;flex-direction:column;overflow:auto}.mc-project-rail,.mc-task-queue{display:block;flex:0 0 auto;border-right:0;border-bottom:1px solid var(--mc-line)}.mc-section-head,.mc-queue-head{height:46px;min-height:46px}.mc-project-rail nav{display:flex;gap:6px;overflow-x:auto;padding:7px 10px}.mc-project-rail nav>button{width:auto;min-width:130px}.mc-project-rail footer,.mc-task-queue>footer,.mc-rail-empty{display:none}.mc-task-list{display:flex;gap:7px;overflow-x:auto;padding:8px 10px}.mc-task-strip{min-width:240px;margin:0;grid-template-columns:minmax(120px,1fr) 70px 30px}.mc-task-meta:nth-of-type(3),.mc-task-meta.approval{display:none}.mc-queue-empty{min-width:100%;min-height:90px}.mc-task-detail{min-height:520px;flex-shrink:0;overflow:visible}.mc-detail-scroll{flex:0 0 auto;overflow:visible}.mc-task-titlebar h1{font-size:19px}.mc-task-identity{display:none}.mc-phase-rail{overflow-x:auto;grid-template-columns:repeat(5,minmax(90px,1fr))}.mc-phase-rail:before{left:45px;right:45px}.mc-detail-grid{grid-template-columns:1fr}.mc-next-action{position:sticky;bottom:0;min-height:76px;flex:0 0 auto}.mc-next-action>div>span{font-size:11px}.mc-primary{min-width:130px}.mc-spine-item{grid-template-columns:58px minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.mc-loader{animation:none}}
`

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
