import type { MissionControlStateV1, Task, TaskPhase, Priority, EvidenceType } from '../domain.js'
import type { ExecutionRun } from '../execution/types.js'

export type QueueFilter = 'open' | 'attention' | 'review' | 'closed' | 'all'
export interface RunSummary {
  taskId: string; runId: string; sessionId: string; status: ExecutionRun['status'];
  releasedAt?: number; updatedAt: number; taskRevision?: number; teamBusy?: boolean; teamUnavailable?: boolean
}
export interface WorkOverview { runs: RunSummary[]; activeTaskId?: string; enabled: boolean; notice?: string }
export type TaskSignal = { label: string; kind: 'quiet' | 'live' | 'attention' | 'review' | 'done'; order: number }
export const closed = (task: Pick<Task, 'phase'>) => ['done', 'failed', 'cancelled'].includes(task.phase)
export const PHASE: Record<TaskPhase, string> = {
  draft: '待开始', planning: '规划中', 'awaiting-plan-approval': '待确认计划', ready: '准备就绪', executing: '手工记录：进行中',
  verifying: '待验证', 'awaiting-review': '待复核', 'ready-for-owner': '待你验收', done: '已验收', paused: '已搁置', blocked: '需要处理', failed: '已结束：未完成', cancelled: '已取消',
}
export const PRIORITY: Record<Priority, string> = { critical: '紧急', high: '优先', normal: '普通', low: '稍后' }
export const EVIDENCE: Record<EvidenceType, string> = { test: '测试', build: '构建', browser: '浏览器验证', diff: '代码变更', screenshot: '截图', log: '日志', artifact: '交付文件', review: '复核', 'manual-acceptance': '人工验收', source: '参考来源' }
export const NEXT: Record<TaskPhase, TaskPhase[]> = {
  draft: ['planning','paused','blocked','cancelled'], planning: ['awaiting-plan-approval','paused','blocked','cancelled'],
  'awaiting-plan-approval': ['planning','ready','paused','blocked','cancelled'], ready: ['executing','paused','blocked','cancelled'],
  executing: ['verifying','paused','blocked','failed','cancelled'], verifying: ['awaiting-review','executing','paused','blocked','failed'],
  'awaiting-review': ['ready-for-owner','executing','paused','blocked'], 'ready-for-owner': ['executing','paused','blocked'],
  paused: ['planning','ready','executing','blocked','cancelled'], blocked: ['planning','ready','executing','paused','cancelled'], done: [], failed: [], cancelled: [],
}
export function taskSignal(task: Task, run?: RunSummary, state?: MissionControlStateV1): TaskSignal {
  // Official activity always remains visible, including on a manually closed task.
  if (run?.teamUnavailable) return { label: '团队状态待核对', kind: 'attention', order: 0 }
  if (run?.teamBusy) return { label: '团队仍在工作', kind: 'live', order: 2 }
  if (run && !run.releasedAt && ['unconfirmed','detached'].includes(run.status)) return { label: run.status === 'unconfirmed' ? '执行结果未确认' : '会话另有操作', kind: 'attention', order: 0 }
  if (run && !run.releasedAt && ['dispatching','accepted','running','stopping'].includes(run.status)) return { label: run.status === 'stopping' ? '正在停止主助手' : 'AI 正在处理', kind: 'live', order: 2 }
  if (closed(task)) return { label: PHASE[task.phase], kind: task.phase === 'done' ? 'done' : 'quiet', order: 6 }
  const approval = task.activeApprovalId && state?.approvals[task.activeApprovalId]
  if (approval && ['pending','rejected'].includes(approval.status)) return { label: approval.status === 'pending' ? '待确认计划' : '计划需要修改', kind: 'attention', order: 0 }
  if (task.phase === 'blocked' || task.bindingRepair) return { label: task.bindingRepair ? '会话关联待修复' : '需要处理', kind: 'attention', order: 0 }
  // A historical run does not claim to have completed a newly edited task.
  if (run?.status === 'completed' && run.taskRevision !== undefined && run.taskRevision !== task.revision) return { label: '目标已改，核对上轮结果', kind: 'attention', order: 0 }
  if (run?.status === 'completed' || ['verifying','awaiting-review','ready-for-owner'].includes(task.phase)) return { label: '待你验收', kind: 'review', order: 1 }
  if (run && ['failed','interrupted','cancelled'].includes(run.status)) return { label: '上轮未完成', kind: 'attention', order: 0 }
  return { label: PHASE[task.phase], kind: 'quiet', order: task.phase === 'paused' ? 5 : 3 }
}
export function selectTasks(state: MissionControlStateV1, overview: WorkOverview, options: { projectId?: string; query?: string; filter: QueueFilter; sort?: 'priority' | 'recent'; archived?: boolean }): Task[] {
  const runs = new Map(overview.runs.map(run => [run.taskId, run]))
  const needle = (options.query ?? '').trim().toLocaleLowerCase()
  const rank: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 }
  return Object.values(state.tasks).filter(task => {
    const project = state.projects[task.projectId]
    if (options.projectId && task.projectId !== options.projectId) return false
    const run = runs.get(task.taskId)
    const activeReference = run && ((!run.releasedAt && ['dispatching','accepted','running','stopping','unconfirmed','detached'].includes(run.status)) || run.teamBusy || run.teamUnavailable)
    if (!options.projectId && !options.archived && project?.status === 'archived' && !activeReference) return false
    if (needle && ![task.title, task.objective, project?.title ?? ''].join('\n').toLocaleLowerCase().includes(needle)) return false
    const signal = taskSignal(task, runs.get(task.taskId), state)
    if (options.filter === 'open') return !closed(task) || ['live','attention'].includes(signal.kind)
    if (options.filter === 'attention') return signal.kind === 'attention'
    if (options.filter === 'review') return signal.kind === 'review'
    if (options.filter === 'closed') return closed(task)
    return true
  }).sort((a,b) => options.sort === 'recent' ? b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId)
    : taskSignal(a,runs.get(a.taskId),state).order - taskSignal(b,runs.get(b.taskId),state).order || rank[a.priority]-rank[b.priority] || b.updatedAt-a.updatedAt || a.taskId.localeCompare(b.taskId))
}
export function sessionsFrom(snapshot: unknown): { id: string; title: string; cwd?: string }[] {
  const s = snapshot as any
  const items = Array.isArray(s) ? s : Array.isArray(s?.items) ? s.items : Array.isArray(s?.sessions) ? s.sessions : Array.isArray(s?.ids) && s?.byId ? s.ids.map((id: string) => s.byId[id]) : []
  return items.filter(Boolean).map((item: any) => ({ id: String(item.sessionId ?? item.id ?? ''), title: String(item.title ?? item.name ?? item.summary ?? item.sessionId ?? item.id ?? '未命名会话'), cwd: typeof item.cwd === 'string' ? item.cwd : undefined })).filter((item: {id: string}) => !!item.id)
}
export function errorText(error: unknown): string {
  const e = error as any
  const known: Record<string,string> = {
    'revision-conflict': '内容已在其他位置更新。你的输入仍然保留，请先核对最新内容。',
    'csrf-refused': '宿主连接已更新。本次操作没有重发，请先核对当前状态。',
    network: '连接中断，无法确认是否已保存。请刷新核对，不要直接重复操作。',
    'invalid-response': '没有取得有效回执。请重新连接并核对结果。',
    'execution.unavailable': '暂时无法确认运行状态，请在原会话核对。',
  }
  const text = typeof e?.message === 'string' ? e.message : ''
  return known[e?.code] ?? (/[\u3400-\u9fff]/u.test(text) ? text.slice(0,500) : '操作没有完成，请核对内容后重试。')
}
