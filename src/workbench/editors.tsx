import React, { useMemo, useRef, useState } from 'react'
import type { EvidenceType, MissionControlStateV1, Priority, Project, Task } from '../domain.js'
import { MissionControlClientStore } from '../client-store.js'
import { Dialog } from './dialog.js'
import { EVIDENCE, errorText, PRIORITY } from './model.js'

export const uid = (kind: string) => `${kind}-${crypto.randomUUID()}`
const lines = (text: string) => text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)

type EditProps = { client: MissionControlClientStore; state: MissionControlStateV1; onClose(): void; onSaved(id: string): void }
export function TaskEditor({ client, state, task, projectId, onClose, onSaved }: EditProps & { task?: Task; projectId?: string }) {
  const [identity] = useState(() => task?.taskId ?? uid('task'))
  const [revision, setRevision] = useState(task?.revision ?? 0)
  const [title, setTitle] = useState(task?.title ?? '')
  const [project, setProject] = useState(task?.projectId ?? projectId ?? Object.values(state.projects).find(p => p.status === 'active')?.projectId ?? '')
  const [objective, setObjective] = useState(task?.objective ?? '')
  const [criteria, setCriteria] = useState(task?.acceptanceCriteria.join('\n') ?? '')
  const [plan, setPlan] = useState(task?.planMarkdown ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'normal')
  const [dependencies, setDependencies] = useState(task?.dependencies ?? [])
  const [requiredEvidence, setRequiredEvidence] = useState<EvidenceType[]>(task?.requiredEvidence ?? [])
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [showLatest, setShowLatest] = useState(false)
  const initial = useRef(JSON.stringify([title, project, objective, criteria, plan, priority, dependencies, requiredEvidence]))
  const dirty = initial.current !== JSON.stringify([title, project, objective, criteria, plan, priority, dependencies, requiredEvidence])
  const latest = state.tasks[identity]
  const projects = Object.values(state.projects).filter(p => p.status === 'active' || p.projectId === project)
  const availableDependencies = useMemo(() => Object.values(state.tasks).filter(t => t.taskId !== identity), [state.tasks, identity])
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current || conflict || uncertain || !title.trim() || !project) return
    lock.current = true; setBusy(true); setError('')
    try {
      const fields = { title: title.trim(), objective, acceptanceCriteria: lines(criteria), priority }
      const result = await client.mutate(task
        ? { type: 'task.update', taskId: identity, expectedEntityRevision: revision, ...fields, planMarkdown: plan, dependencies, requiredEvidence }
        : { type: 'task.create', taskId: identity, projectId: project, ...fields })
      if (result.error) {
        setError(errorText(result.error)); setConflict(result.error.code === 'revision-conflict')
        setUncertain(['network','invalid-response','csrf-refused'].includes(result.error.code))
      } else if (result.phase === 'ready' && result.state?.tasks[identity]) onSaved(identity)
      else { setError('没有取得保存回执。输入仍在，请重新连接并核对。'); setUncertain(true) }
    } catch (e) { setError(errorText(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const inspect = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      const result = await client.refresh()
      if (result.error || result.phase !== 'ready') { setError(errorText(result.error)); return }
      const stored = result.state?.tasks[identity]
      const matches = stored && stored.title === title.trim() && stored.objective === objective.trim()
        && JSON.stringify(stored.acceptanceCriteria) === JSON.stringify(lines(criteria)) && stored.priority === priority
        && (!task || ((stored.planMarkdown ?? '') === plan.trim() && JSON.stringify(stored.dependencies) === JSON.stringify(dependencies)
          && JSON.stringify(stored.requiredEvidence) === JSON.stringify(requiredEvidence)))
      if (matches) { onSaved(identity); return }
      setUncertain(false)
      if (stored) { setConflict(true); setShowLatest(true); setError('已读取当前内容。请核对差异后再决定是否保存你的输入。') }
      else { setConflict(false); setError('当前任务记录中尚未发现这次新建。没有自动再次保存。') }
    } catch (e) { setError(errorText(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <Dialog title={task ? '编辑任务' : '新建任务'} onClose={onClose} busy={busy} dirty={dirty}>
    <form onSubmit={save}>
      <div className="mc-dialog-body">
        <p className="mc-muted">先记下要做的事。保存任务不会调用模型。</p>
        {error && <div className="mc-notice warn" role="alert">{error}
          {uncertain && <button type="button" onClick={() => void inspect()} disabled={busy}>读取当前保存状态</button>}
          {conflict && <button type="button" onClick={() => setShowLatest(true)}>核对最新内容</button>}
        </div>}
        {showLatest && latest && <div className="mc-notice">
          <strong>当前已保存内容</strong><p>{latest.title}</p><pre className="mc-prose">{latest.objective || '尚未填写目标'}</pre>
          <p className="mc-muted">{latest.acceptanceCriteria.length} 条验收要求；计划 {latest.planMarkdown ? '已有内容' : '未填写'}。你的输入未被替换。</p>
          <details><summary>展开当前计划与验收要求</summary><pre className="mc-prose">{latest.acceptanceCriteria.join('\n')}\n{latest.planMarkdown}</pre></details>
          <button type="button" onClick={() => { setRevision(latest.revision); setConflict(false); setShowLatest(false); setError('已采用当前版本作为保存起点。请确认你的输入后再点保存。') }}>我已核对，允许保存这些更改</button>
        </div>}
        <div className="mc-form-grid">
          <label className="mc-field wide">任务名称<input autoFocus required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：检查导出的附件是否齐全" /></label>
          {!task && <label className="mc-field">所属项目<select required value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.projectId} value={p.projectId}>{p.title}</option>)}</select></label>}
          <label className="mc-field">优先级<select value={priority} onChange={e => setPriority(e.target.value as Priority)}>{Object.entries(PRIORITY).map(([key,label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label className="mc-field wide">要完成什么 <span className="mc-muted">可稍后补充</span><textarea value={objective} onChange={e => setObjective(e.target.value)} maxLength={32768} rows={task ? 5 : 3} placeholder="写下目标和不能改变的边界。" /></label>
          {task ? <label className="mc-field wide">怎样算完成 <span className="mc-muted">每行一条，可留空</span><textarea value={criteria} onChange={e => setCriteria(e.target.value)} rows={3} placeholder="可以检查、可以判断的结果。" /></label> : <details className="mc-optional wide"><summary>补充验收要求（可选）</summary><label className="mc-field wide">怎样算完成 <span className="mc-muted">每行一条，可留空</span><textarea value={criteria} onChange={e => setCriteria(e.target.value)} rows={3} placeholder="可以检查、可以判断的结果。" /></label></details>}
        </div>
        {task && <details className="mc-optional"><summary>复杂任务：计划、前置任务与证据要求</summary>
          <label className="mc-field">工作计划<textarea value={plan} onChange={e => setPlan(e.target.value)} maxLength={65536} rows={7} /></label>
          <fieldset className="mc-field"><legend>前置任务</legend><div className="mc-check-list">{availableDependencies.map(t => <label key={t.taskId}><input type="checkbox" checked={dependencies.includes(t.taskId)} onChange={e => setDependencies(e.target.checked ? [...dependencies,t.taskId] : dependencies.filter(id => id !== t.taskId))} />{t.title}</label>)}</div></fieldset>
          <fieldset className="mc-field"><legend>验收时需要的证据</legend><div className="mc-check-list">{Object.entries(EVIDENCE).map(([key,label]) => <label key={key}><input type="checkbox" checked={requiredEvidence.includes(key as EvidenceType)} onChange={e => setRequiredEvidence(e.target.checked ? [...requiredEvidence,key as EvidenceType] : requiredEvidence.filter(value => value !== key))} />{label}</label>)}</div></fieldset>
        </details>}
      </div>
      <footer className="mc-dialog-foot"><span className="mc-muted" role="status">{busy ? '正在保存…' : '只保存任务，不发送给 AI'}</span><button className="mc-primary" type="submit" disabled={busy || conflict || uncertain || !title.trim() || !project}>{task ? '保存更改' : '创建任务'}</button></footer>
    </form>
  </Dialog>
}

export function ProjectEditor({ client, project, onClose, onSaved }: Omit<EditProps, 'state'> & { project?: Project }) {
  const [id] = useState(() => project?.projectId ?? uid('project'))
  const [title, setTitle] = useState(project?.title ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [busy,setBusy] = useState(false)
  const lock = useRef(false)
  const [error,setError] = useState('')
  const [uncertain,setUncertain] = useState(false)
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (lock.current || uncertain) return
    lock.current = true; setBusy(true)
    try {
      const result = await client.mutate(project ? { type:'project.update',projectId:id,expectedEntityRevision:project.revision,title,description } : { type:'project.create',projectId:id,title,description })
      if (result.error) { setError(errorText(result.error)); setUncertain(true) }
      else if (result.phase === 'ready' && result.state?.projects[id]) onSaved(id)
      else {setError('保存状态未确认，请先读取当前内容。');setUncertain(true)}
    } catch(e) {setError(errorText(e))}
    finally {lock.current=false;setBusy(false)}
  }
  return <Dialog title={project ? '编辑项目' : '新建项目'} onClose={onClose} busy={busy} dirty={title !== (project?.title ?? '') || description !== (project?.description ?? '')}>
    <form onSubmit={save}><div className="mc-dialog-body">
      {error && <div className="mc-notice warn" role="alert">{error}{uncertain && <button type="button" onClick={async()=>{const next=await client.refresh();if(next.error)return setError(errorText(next.error));const saved=next.state?.projects[id];if(saved && saved.title===title.trim() && saved.description===description.trim())onSaved(id);else setError('已刷新。请关闭后重新打开项目核对，不会自动覆盖其他更改。')}}>读取当前内容</button>}</div>}
      <label className="mc-field">项目名称<input autoFocus required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="这组任务属于什么工作？" /></label>
      <label className="mc-field">说明 <span className="mc-muted">可留空</span><textarea rows={4} maxLength={16384} value={description} onChange={e=>setDescription(e.target.value)} /></label>
      <p className="mc-muted">实际工作目录和模型来自你关联的 DSH 会话，不由项目名称决定。</p>
    </div><footer className="mc-dialog-foot"><span role="status">{busy?'正在保存…':''}</span><button className="mc-primary" disabled={busy||uncertain||!title.trim()}>{project?'保存项目':'创建项目'}</button></footer></form>
  </Dialog>
}
