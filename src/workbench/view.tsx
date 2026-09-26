import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MissionControlClientStore } from '../client-store.js'
import type { Approval, MissionControlStateV1, Project, Task, TaskPhase } from '../domain.js'
import type { WorkCommand } from '../workflow.js'
import { TaskExecutionPanel } from '../execution/panel.js'
import { TaskEditor, ProjectEditor, uid } from './editors.js'
import { SessionDialog } from './sessions.js'
import { AcceptanceDialog, EvidenceDialog, STATUS, dateText } from './records.js'
import { Dialog } from './dialog.js'
import { closed, EVIDENCE, errorText, NEXT, PHASE, PRIORITY, selectTasks, sessionsFrom, taskSignal, type QueueFilter, type WorkOverview } from './model.js'

const EMPTY_OVERVIEW:WorkOverview={runs:[],enabled:false}
const FILTERS:Record<QueueFilter,string>={open:'当前工作',attention:'需处理',review:'待验收',closed:'已结束',all:'全部'}
const APPROVAL:Record<Approval['status'],string>={pending:'等待你确认',approved:'计划已通过',rejected:'计划需要修改',superseded:'已被后续修改替代',expired:'已过期'}
function Icon({name}:{name:'folder'|'search'|'all'|'arrow'|'refresh'|'edit'}) {
  const paths={folder:'M2 5h5l2 2h13v13H2z',search:'M21 21l-5-5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',all:'M4 3h16l3 18H1z M2 15h6l2 3h4l2-3h6',arrow:'M4 12h16 M14 6l6 6-6 6',refresh:'M20 8a8 8 0 1 0 1 7 M20 2v6h-6',edit:'M4 16l-1 5 5-1L21 7l-4-4z M14 6l4 4'}
  return <svg className="mc-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>
}

type Modal = {kind:'task';task?:Task}|{kind:'project';project?:Project}|{kind:'session'|'accept'|'evidence'|'manual'|'reopen';task:Task}|{kind:'approval';approval:Approval;task:Task}|{kind:'archive';project:Project}
export function Workbench({client,runtime,opened,onClose}:{client:MissionControlClientStore;runtime:any;opened:boolean;onClose():void}) {
  const snapshot=useSyncExternalStore(client.subscribe,client.getSnapshot)
  const state=snapshot.state
  const [projectId,setProjectId]=useState('')
  const [taskId,setTaskId]=useState('')
  const [filter,setFilter]=useState<QueueFilter>('open')
  const [query,setQuery]=useState('')
  const [sort,setSort]=useState<'priority'|'recent'>('priority')
  const [archived,setArchived]=useState(false)
  const [view,setView]=useState<'list'|'detail'>('list')
  const [tab,setTab]=useState<'task'|'execution'|'records'>('task')
  const [modal,setModal]=useState<Modal>()
  const [overview,setOverview]=useState<WorkOverview>(EMPTY_OVERVIEW)
  const [overviewError,setOverviewError]=useState('')
  const [dismissedError,setDismissedError]=useState<unknown>()
  const [message,setMessage]=useState<{text:string;error?:boolean}>()
  const [busy,setBusy]=useState(false);const actionLock=useRef(false)
  const [epoch,setEpoch]=useState(0)
  const root=useRef<HTMLElement>(null);const heading=useRef<HTMLHeadingElement>(null)
  const wasOpen=useRef(false)
  const modalRef=useRef(modal);modalRef.current=modal
  const ready=snapshot.phase==='ready'
  useEffect(()=>{
    if(opened&&!wasOpen.current){if(client.getSnapshot().phase!=='ready'&&client.getSnapshot().phase!=='connecting')void client.connect();else void client.refresh()}
    wasOpen.current=opened
  },[opened,client])
  useEffect(()=>{
    if(!opened)return
    const before=document.activeElement instanceof HTMLElement?document.activeElement:undefined
    root.current?.querySelector<HTMLButtonElement>('[data-mc-close]')?.focus()
    return()=>{if(before?.isConnected)before.focus()}
  },[opened])
  useEffect(()=>{
    if(!opened||!ready)return
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{
      try{const value=await client.executionCall('execution.overview',{},controller.signal) as WorkOverview;if(!controller.signal.aborted){setOverview(value);setOverviewError('')}}
      catch(e){if(!controller.signal.aborted)setOverviewError(errorText(e))}
      if(!controller.signal.aborted)timer=setTimeout(poll,document.hidden?10000:5000)
    }
    void poll();return()=>{controller.abort();if(timer)clearTimeout(timer)}
  },[client,opened,ready,epoch])
  const projects=useMemo(()=>Object.values(state?.projects??{}).sort((a,b)=>a.status.localeCompare(b.status)||b.updatedAt-a.updatedAt||a.projectId.localeCompare(b.projectId)),[state?.projects])
  const visibleProjects=projects.filter(p=>archived||p.status==='active')
  const project=state?.projects[projectId]
  const tasks=state?selectTasks(state,overview,{projectId,query,filter,sort,archived}):[]
  const task=tasks.find(t=>t.taskId===taskId)??tasks[0]
  const summaries=new Map(overview.runs.map(r=>[r.taskId,r]))
  const signal=task?taskSignal(task,summaries.get(task.taskId),state):undefined
  const taskEvidence=state&&task?Object.values(state.evidence).filter(e=>e.taskId===task.taskId).sort((a,b)=>b.createdAt-a.createdAt):[]
  const approvals=state&&task?Object.values(state.approvals).filter(a=>a.taskId===task.taskId).sort((a,b)=>b.requestedAt-a.requestedAt):[]
  const activeApproval=task?.activeApprovalId?state?.approvals[task.activeApprovalId]:undefined
  const allTasks=state?selectTasks(state,overview,{projectId,filter:'open',archived}):[]
  const attention=state?selectTasks(state,overview,{projectId,filter:'attention',archived}).length:0
  const review=state?selectTasks(state,overview,{projectId,filter:'review',archived}).length:0
  const countFor=(id:string)=>state?Object.values(state.tasks).filter(t=>t.projectId===id&&!closed(t)).length:0
  const chooseTask=(id:string,nextTab:'task'|'execution'|'records'='task')=>{setTaskId(id);setView('detail');setTab(nextTab);requestAnimationFrame(()=>heading.current?.focus())}
  const jumpToTask=(id:string)=>{const target=state?.tasks[id];if(!target)return;setProjectId(target.projectId);setFilter('all');setQuery('');setArchived(state?.projects[target.projectId]?.status==='archived');chooseTask(id,'execution')}
  const changed=()=>setEpoch(n=>n+1)
  const act=async(work:()=>Promise<void>)=>{if(actionLock.current)return;actionLock.current=true;setBusy(true);try{await work()}catch(e){setMessage({text:errorText(e),error:true})}finally{actionLock.current=false;setBusy(false)}}
  const mutate=async(command:WorkCommand,success:string)=>{
    const result=await client.mutate(command)
    if(result.error)throw result.error
    if(result.phase!=='ready')throw {message:'没有取得保存回执，请重新连接并核对。'}
    setMessage({text:success});changed();return result
  }
  const openSession=async(id:string)=>{try{await runtime.sessions.open(id);onClose()}catch(e){setMessage({text:errorText(e),error:true});throw e}}
  const refresh=()=>act(async()=>{const r=await client.refresh();if(r.error)throw r.error;changed();setMessage({text:'已读取最新任务。未重新发送任何执行请求。'})})
  const editTask=()=>task&&setModal({kind:'task',task:structuredClone(task)})
  const sessionTitle=(id:string)=>sessionsFrom(runtime?.sessions?.list?.getSnapshot?.()).find(s=>s.id===id)?.title??'已关联 DSH 会话'
  const keydown=(event:React.KeyboardEvent<HTMLElement>)=>{
    if(event.defaultPrevented||modalRef.current||root.current?.querySelector('dialog[open]'))return
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return}
    if(event.key==='Tab'){
      const items=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href],[tabindex="0"]')??[]).filter(el=>el.getClientRects().length&&!el.closest('[hidden]'))
      const first=items[0],last=items[items.length-1]
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
    }
  }
  if(!opened)return null
  return <div data-mc-scrim="" onMouseDown={event=>{if(event.target===event.currentTarget&&!modal&&!root.current?.querySelector('dialog[open]'))onClose()}}><section ref={root} data-mc-workbench="" data-view={view} role="dialog" aria-modal="true" aria-label="任务指挥台" onKeyDown={keydown}>
    <header className="mc-top"><span className="mc-brand" aria-hidden="true">MC</span><strong>任务指挥台</strong><span className="mc-eyebrow">MISSION CONTROL</span>
      <span className="mc-connection" role="status"><i className="mc-dot"/>{ready?'已连接 DSH':snapshot.phase==='connecting'?'正在连接':'暂未连接'}</span>
      <button type="button" aria-label="刷新任务" title="刷新任务" disabled={busy||snapshot.phase==='connecting'} onClick={()=>void refresh()}><Icon name="refresh"/></button>
      <button type="button" data-mc-close aria-label="关闭指挥台" title="关闭指挥台" onClick={onClose}>×</button>
    </header>
    {(message||(snapshot.error&&snapshot.error!==dismissedError))&&<div className={`mc-toast ${(message?.error||snapshot.error)?'error':''}`} role={(message?.error||snapshot.error)?'alert':'status'}><span>{message?.text??errorText(snapshot.error)}</span><button type="button" aria-label="关闭提示" onClick={()=>{setMessage(undefined);setDismissedError(snapshot.error)}}>×</button></div>}
    {!state?<div className="mc-empty"><span className="mc-eyebrow">MISSION CONTROL</span><h2>{snapshot.phase==='connecting'?'正在读取你的任务':'任务服务暂不可用'}</h2><p>没有创建空白状态，也没有覆盖现有任务。官方会话仍由 DSH 保存。</p><button type="button" className="mc-primary" disabled={snapshot.phase==='connecting'} onClick={()=>void client.connect()}>重新连接</button></div>:<main className="mc-layout">
      <aside className="mc-sidebar"><div className="mc-between"><span>工作空间</span><button type="button" aria-label="新建项目" title="新建项目" disabled={!ready} onClick={()=>setModal({kind:'project'})}>＋</button></div>
        <div className={`mc-project-row ${!projectId?'selected':''}`}><button type="button" aria-current={!projectId?'page':undefined} onClick={()=>{setProjectId('');setTaskId('');setView('list')}}><Icon name="all"/><span className="mc-project-name">全部项目</span><small>{Object.values(state.tasks).filter(t=>!closed(t)).length}</small></button></div>
        <nav className="mc-projects" aria-label="项目">{visibleProjects.map(p=><div key={p.projectId} className={`mc-project-row ${projectId===p.projectId?'selected':''}`}><button type="button" title={p.title} aria-current={projectId===p.projectId?'page':undefined} onClick={()=>{setProjectId(p.projectId);setTaskId('');setView('list')}}><Icon name="folder"/><span className="mc-project-name">{p.title}{p.status==='archived'?'（已归档）':''}</span><small>{countFor(p.projectId)}</small></button></div>)}</nav>
        <footer><button type="button" aria-pressed={archived} onClick={()=>{setArchived(v=>!v);setProjectId('');setTaskId('')}}>{archived?'收起已归档项目':'查看已归档项目'}</button>
          <button type="button" disabled={!ready||busy} onClick={()=>void act(async()=>{const r=await client.writeExport(undefined,true);setMessage({text:`任务记录已导出：${r.path}`})})}>导出任务记录 ↗</button><small>本地任务 · {snapshot.host?.pluginVersion??'正在连接'}</small></footer>
      </aside>
      <section className="mc-queue" aria-label="任务队列"><div className="mc-queue-head"><span className="mc-eyebrow">WORK QUEUE</span>
        <div className="mc-between"><h2>{project?.title??'当前工作'}</h2><button type="button" className="mc-primary" disabled={!ready||project?.status==='archived'} onClick={()=>setModal(projects.some(p=>p.status==='active')?{kind:'task'}:{kind:'project'})}>＋ 新建任务</button></div>
        <p className="mc-subline">{allTasks.length} 项待处理工作 · {attention} 项需处理 · {review} 项待验收</p>
        {project&&<div className="mc-project-tools"><button type="button" disabled={!ready} onClick={()=>setModal({kind:'project',project:structuredClone(project)})}>编辑项目</button><button type="button" disabled={!ready} onClick={()=>setModal({kind:'archive',project:structuredClone(project)})}>{project.status==='archived'?'重新启用':'归档项目'}</button></div>}
        <label className="mc-search"><Icon name="search"/><input aria-label="搜索任务" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索任务、目标或项目"/></label>
        <div className="mc-filter" aria-label="任务筛选">{Object.entries(FILTERS).map(([k,v])=><button type="button" key={k} aria-pressed={filter===k} onClick={()=>{setFilter(k as QueueFilter);setTaskId('');setView('list')}}>{v}</button>)}</div>
        <div className="mc-between mc-sortbar"><span>{tasks.length} 项任务</span><select aria-label="任务排序" value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="priority">处理顺序</option><option value="recent">最近更新</option></select></div>
        {overview.activeTaskId&&<button type="button" className="mc-active-link" onClick={()=>jumpToTask(overview.activeTaskId!)}>当前占用：{state.tasks[overview.activeTaskId]?.title??'待核对的任务'} →</button>}
        {(overviewError||overview.notice)&&<p className="mc-footnote" role="status">{overview.notice||'运行状态暂未更新。可在任务中打开原会话核对。'}</p>}
      </div><div className="mc-task-list">{tasks.map(t=>{const s=taskSignal(t,summaries.get(t.taskId),state);return <button type="button" className="mc-task-row" aria-current={task?.taskId===t.taskId?'true':undefined} aria-label={`${t.title}，${s.label}`} key={t.taskId} onClick={()=>chooseTask(t.taskId)}>
        <span className="mc-between"><span className="mc-project-label">{state.projects[t.projectId]?.title}</span><span className={`mc-priority ${t.priority}`}>{PRIORITY[t.priority]}</span></span>
        <strong>{t.title}</strong><span className="mc-between"><span className={`mc-signal ${s.kind}`}><i className="mc-dot"/>{s.label}</span><time className="mc-muted">{dateText(t.updatedAt)}</time></span>
      </button>})}{!tasks.length&&<div className="mc-empty"><h3>{query?'没有找到匹配的任务':filter==='attention'?'暂时没有需要处理的事项':filter==='review'?'还没有待验收的结果':'这里还没有任务'}</h3><p>{query?'换个关键词，或切换到全部项目。':'新建任务只需要一个名称。计划和验收要求可以稍后补充。'}</p>{query?<button type="button" onClick={()=>setQuery('')}>清除搜索</button>:<button type="button" disabled={!ready||project?.status==='archived'} className="mc-secondary" onClick={()=>setModal(projects.some(p=>p.status==='active')?{kind:'task'}:{kind:'project'})}>开始记录工作</button>}</div>}</div>
      </section>
      <section className="mc-detail" aria-label="任务详情">{task?<>
        <header className="mc-detail-head"><div className="mc-between"><button type="button" className="mc-back" onClick={()=>{setView('list');requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>('.mc-task-row[aria-current=true]')?.focus())}}>← 返回任务列表</button><span>{state.projects[task.projectId]?.title}</span><span className={`mc-priority ${task.priority}`}>{PRIORITY[task.priority]}</span></div>
          <h1 ref={heading} tabIndex={-1}>{task.title}</h1><div className="mc-between"><span className={`mc-signal ${signal?.kind}`}><i className="mc-dot"/>{signal?.label}</span><div className="mc-actions"><button type="button" disabled={!ready} onClick={editTask}><Icon name="edit"/> 编辑</button><button type="button" disabled={!ready} onClick={()=>setModal({kind:'manual',task:structuredClone(task)})}>手工阶段</button></div></div>
          <div className="mc-tabs" role="tablist" aria-label="任务内容">{([['task','任务'],['execution','执行与结果'],['records',`验收记录 ${taskEvidence.length||''}`]] as const).map(([key,label])=><button type="button" key={key} role="tab" id={`mc-tab-${key}`} aria-controls={`mc-pane-${key}`} aria-selected={tab===key} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const list=['task','execution','records'] as const;const i=list.indexOf(tab);const next=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3;setTab(list[next]);requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>(`#mc-tab-${list[next]}`)?.focus())}}}>{label}</button>)}</div>
        </header>
        <div className="mc-detail-body" key={task.taskId}>
          {tab==='task'&&<div role="tabpanel" id="mc-pane-task" aria-labelledby="mc-tab-task">
            {task.blockedReason&&<div className="mc-notice warn"><strong>需要处理</strong><p>{task.blockedReason.message}</p></div>}
            {task.bindingRepair&&<div className="mc-notice warn"><strong>会话关联待修复</strong><p>{task.bindingRepair.reason}</p><button type="button" onClick={()=>setModal({kind:'session',task:structuredClone(task)})}>找回并关联会话</button></div>}
            <section className="mc-section"><h3>要完成什么</h3><p className="mc-prose">{task.objective||task.title}</p>{!task.objective&&<button type="button" className="mc-text-link" onClick={editTask}>补充目标与边界</button>}</section>
            <section className="mc-section"><div className="mc-between"><h3>怎样算完成</h3><button type="button" onClick={editTask}>编辑要求</button></div>{task.acceptanceCriteria.length?<ol className="mc-criteria">{task.acceptanceCriteria.map((line,i)=><li key={i}>{line}</li>)}</ol>:<p className="mc-muted">还没有单独的验收要求。普通任务可以直接核对交付结果。</p>}</section>
            <section className="mc-section"><div className="mc-between"><h3>关联会话</h3><button type="button" disabled={!ready} onClick={()=>setModal({kind:'session',task:structuredClone(task)})}>{task.sessionBinding?'更换':'选择会话'}</button></div>
              {task.sessionBinding?<div className="mc-session-line"><div><strong>{sessionTitle(task.sessionBinding.sessionId)}</strong><code>{task.sessionBinding.sessionId}</code><small>发送前会再次确认工作目录和模型。</small></div><button type="button" aria-label="打开关联会话" disabled={busy} onClick={()=>void act(()=>openSession(task.sessionBinding!.sessionId))}><Icon name="arrow"/></button></div>:<p className="mc-muted">还未关联。请选择已配置好目录、模型和权限的 DSH 会话。</p>}
            </section>
            {activeApproval&&<section className="mc-section"><div className="mc-between"><h3>{APPROVAL[activeApproval.status]}</h3><button type="button" onClick={()=>setModal({kind:'approval',approval:structuredClone(activeApproval),task:structuredClone(task)})}>{activeApproval.status==='pending'?'查看并决定':'查看计划记录'}</button></div><p className="mc-prose">{activeApproval.summary}</p></section>}
            <div className="mc-next"><div><small className="mc-muted">下一步</small><strong>{closed(task)?'查看记录，或重新打开任务':signal?.kind==='review'?'核对结果，再确认验收':signal?.kind==='attention'?'先处理待核对事项':'确认目标后交给 AI'}</strong></div>
              <button type="button" className="mc-primary" onClick={()=>setTab(closed(task)||signal?.kind==='review'?'records':'execution')}>{closed(task)?'查看记录':signal?.kind==='review'?'查看验收':'查看执行'} <Icon name="arrow"/></button></div>
            <details className="mc-optional"><summary>工作计划与前置条件{task.planMarkdown?' · 已有内容':''}</summary><pre className="mc-prose">{task.planMarkdown||'尚未填写工作计划。'}</pre>
              <div className="mc-actions"><button type="button" onClick={editTask}>编辑计划</button>{['draft','planning','awaiting-plan-approval'].includes(task.phase)&&activeApproval?.status!=='pending'&&<button type="button" disabled={busy||!ready} onClick={()=>void act(async()=>{let current=task;if(current.phase==='draft'){const r=await mutate({type:'task.transition',taskId:current.taskId,expectedEntityRevision:current.revision,phase:'planning'},'已进入规划');current=r.state!.tasks[current.taskId]}await mutate({type:'approval.request',approvalId:uid('approval'),taskId:current.taskId,expectedEntityRevision:current.revision,summary:(current.planMarkdown||current.objective||current.title).slice(0,4000)},'计划已提交，等待你确认。')})}>提交计划确认</button>}</div>
              {task.dependencies.length>0&&<><h4>前置任务</h4>{task.dependencies.map(id=><button type="button" key={id} className="mc-dependency" onClick={()=>jumpToTask(id)}>{state.tasks[id]?.title??id} · {state.tasks[id]?PHASE[state.tasks[id].phase]:'待核对'} →</button>)}</>}
              {task.requiredEvidence.length>0&&<p>要求的证据：{task.requiredEvidence.map(t=>EVIDENCE[t]).join('、')}</p>}
            </details>
          </div>}
          {tab==='execution'&&<div role="tabpanel" id="mc-pane-execution" aria-labelledby="mc-tab-execution"><TaskExecutionPanel key={task.taskId} task={task} client={client} hostReady={ready} onOpenSession={openSession} onChooseSession={()=>setModal({kind:'session',task:structuredClone(task)})} onAccept={()=>setModal({kind:'accept',task:structuredClone(task)})} onChanged={changed} onOpenTask={jumpToTask}/></div>}
          {tab==='records'&&<div role="tabpanel" id="mc-pane-records" aria-labelledby="mc-tab-records"><section className="mc-section"><div className="mc-between"><div><h3>{task.phase==='done'?'已由你验收':'交付是否合格，由你判断'}</h3><p className="mc-muted">模型返回、验证记录与人工验收是不同的事。</p></div></div><div className="mc-actions"><button type="button" className="mc-secondary" disabled={!ready} onClick={()=>setModal({kind:'evidence',task:structuredClone(task)})}>记录验证结果</button>{!closed(task)?<button type="button" className="mc-primary" disabled={!ready||!!overviewError||!overview.enabled||signal?.kind==='live'} onClick={()=>setModal({kind:'accept',task:structuredClone(task)})}>核对并验收</button>:<button type="button" disabled={!ready} onClick={()=>setModal({kind:'reopen',task:structuredClone(task)})}>重新打开任务</button>}</div></section>
            {taskEvidence.map(e=><article key={e.evidenceId} className="mc-evidence"><div className="mc-between"><strong>{e.label}</strong><span className={`mc-signal ${e.status==='pass'?'done':e.status==='fail'?'attention':'quiet'}`}>{STATUS[e.status]}</span></div><small className="mc-muted">{EVIDENCE[e.type]} · {e.producer.kind==='human'?'人工记录':e.producer.name} · {dateText(e.createdAt)}</small><p className="mc-prose">{e.summary}</p>{e.locator&&<code>{e.locator.value}</code>}</article>)}
            {!taskEvidence.length&&<div className="mc-empty"><h3>还没有验证记录</h3><p>检查实际产物后再填写。不会把模型的“完成了”自动写成通过。</p></div>}
            {approvals.length>0&&<details className="mc-optional"><summary>计划确认历史 · {approvals.length} 条</summary>{approvals.map(a=><article key={a.approvalId}><strong>{APPROVAL[a.status]}</strong><p className="mc-prose">{a.summary}</p>{a.decisionNote&&<p>{a.decisionNote}</p>}<small>{dateText(a.requestedAt)}</small></article>)}</details>}
            <details className="mc-optional"><summary>任务活动记录</summary>{state.audit.filter(e=>e.entityId===task.taskId||taskEvidence.some(x=>x.evidenceId===e.entityId)||approvals.some(x=>x.approvalId===e.entityId)).slice(-40).reverse().map(e=><p key={e.auditId}><small>{dateText(e.time)}</small>　{auditLabel(e.operation)}{/[\u3400-\u9fff]/u.test(e.summary)?`：${e.summary}`:''}</p>)}</details>
          </div>}
        </div>
      </>:<div className="mc-empty"><span className="mc-eyebrow">YOUR NEXT MOVE</span><h2>把工作放在眼前</h2><p>从左侧选择任务，或先建立一个项目。这里不会填入演示任务。</p></div>}</section>
    </main>}
    {state&&modal?.kind==='task'&&<TaskEditor client={client} state={state} task={modal.task} projectId={projectId||undefined} onClose={()=>setModal(undefined)} onSaved={id=>{const t=client.getSnapshot().state?.tasks[id];if(t)setProjectId(t.projectId);setQuery('');setFilter('all');chooseTask(id);setModal(undefined);setMessage({text:'任务已保存，尚未发送给 AI。'});changed()}}/>}
    {modal?.kind==='project'&&<ProjectEditor client={client} project={modal.project} onClose={()=>setModal(undefined)} onSaved={id=>{setProjectId(id);setModal(undefined);setMessage({text:'项目已保存。'});changed()}}/>}
    {modal?.kind==='session'&&<SessionDialog client={client} runtime={runtime} task={modal.task} onClose={()=>setModal(undefined)} onSaved={()=>{setModal(undefined);setMessage({text:'会话关联已更新，没有发送模型请求。'});changed()}}/>}
    {state&&modal?.kind==='accept'&&<AcceptanceDialog client={client} state={state} task={modal.task} onClose={()=>setModal(undefined)} onSaved={()=>{setTaskId(modal.task.taskId);setFilter('closed');setTab('records');setModal(undefined);setMessage({text:'人工验收已保存，任务已完成。'});changed()}}/>}
    {state&&modal?.kind==='evidence'&&<EvidenceDialog client={client} task={modal.task} owner={state.settings.ownerLabel} onClose={()=>setModal(undefined)} onSaved={()=>{setModal(undefined);setMessage({text:'验证记录已保存。'});changed()}}/>}
    {state&&modal&&['manual','reopen','approval','archive'].includes(modal.kind)&&<ActionDialog modal={modal} client={client} state={state} onClose={()=>setModal(undefined)} onSaved={()=>{setModal(undefined);setFilter('all');changed();setMessage({text:'更改已保存，没有启动或停止任何会话。'})}}/>}
  </section></div>
}

const auditLabel=(operation:string)=>({ 'task.create':'创建任务','task.update':'更新任务内容','task.transition':'调整手工阶段','task.bind-session':'关联会话','task.unbind-session':'解除关联','task.binding-repair':'记录关联问题','task.accept':'人工验收','task.reopen':'重新打开','approval.request':'提交计划','approval.decide':'处理计划确认','evidence.append':'添加验证记录','run.create':'创建手工运行记录','run.update':'更新手工运行记录' }[operation]??'任务记录')

function ActionDialog({modal,client,state,onClose,onSaved}:{modal:Modal;client:MissionControlClientStore;state:MissionControlStateV1;onClose():void;onSaved():void}){
  const [note,setNote]=useState('');const [checked,setChecked]=useState(false);const [busy,setBusy]=useState(false);const lock=useRef(false);const [error,setError]=useState('')
  const [phase,setPhase]=useState<TaskPhase>(()=>'task'in modal?(NEXT[modal.task.phase][0]??modal.task.phase):'draft')
  const title=modal.kind==='manual'?'调整手工阶段':modal.kind==='reopen'?'重新打开任务':modal.kind==='approval'?'确认工作计划':modal.kind==='archive'?(modal.project.status==='archived'?'重新启用项目':'归档项目'):'任务操作'
  const send=async(command:WorkCommand)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const r=await client.mutate(command);if(r.error)setError(errorText(r.error));else if(r.phase==='ready')onSaved()}catch(e){setError(errorText(e))}finally{lock.current=false;setBusy(false)}}
  const stale='task'in modal&&state.tasks[modal.task.taskId]?.revision!==modal.task.revision
  return <Dialog title={title} onClose={onClose} busy={busy} dirty={!!note}><div className="mc-dialog-body">
    {stale&&<div className="mc-notice warn">任务已更新，请返回重新核对。</div>}{error&&<div className="mc-notice warn" role="alert">{error}</div>}
    {modal.kind==='manual'&&<><p className="mc-muted">这只修改任务记录，不会控制真实 AI。发起和停止运行请到“执行与结果”。</p><label className="mc-field">下一手工阶段<select value={phase} onChange={e=>setPhase(e.target.value as TaskPhase)}>{NEXT[modal.task.phase].map(p=><option key={p} value={p}>{PHASE[p]}</option>)}</select></label>{phase==='blocked'&&<label className="mc-field">需要处理的问题<textarea required value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>}{!NEXT[modal.task.phase].length&&<p>任务已结束。需要继续时，请在验收记录中重新打开。</p>}</>}
    {modal.kind==='approval'&&<><strong>{APPROVAL[modal.approval.status]}</strong><pre className="mc-prose">{modal.approval.summary}</pre><label className="mc-field">确认意见 <span className="mc-muted">可留空</span><textarea rows={3} maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label><p className="mc-muted">通过计划不会自动发送任务。</p></>}
    {modal.kind==='reopen'&&<p>保留原会话、计划、证据和验收历史，将任务重新放回工作队列。不会自动继续或重发上一轮。</p>}
    {modal.kind==='archive'&&<p>{modal.project.status==='archived'?'重新显示这个项目及其已有任务。':'项目会从默认导航收起，任务和记录不会删除。正在运行或待核对的任务仍可从当前工作中找到。'}</p>}
    {modal.kind!=='approval'&&<label className="mc-check"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>我了解这只改变任务或项目记录。</label>}
  </div><footer className="mc-dialog-foot"><button type="button" onClick={onClose} disabled={busy}>返回</button>
    {modal.kind==='manual'&&<button type="button" className="mc-primary" disabled={busy||stale||!checked||!NEXT[modal.task.phase].includes(phase)||(phase==='blocked'&&!note.trim())} onClick={()=>void send({type:'task.transition',taskId:modal.task.taskId,expectedEntityRevision:modal.task.revision,phase,...(phase==='blocked'?{blockedReason:{code:'owner-blocked',message:note.trim()}}:{})})}>保存阶段</button>}
    {modal.kind==='reopen'&&<button type="button" className="mc-primary" disabled={busy||stale||!checked} onClick={()=>void send({type:'task.reopen',taskId:modal.task.taskId,expectedEntityRevision:modal.task.revision,confirmed:true,actorRole:'owner'})}>重新打开，不发送</button>}
    {modal.kind==='archive'&&<button type="button" className="mc-primary" disabled={busy||!checked} onClick={()=>void send({type:modal.project.status==='archived'?'project.restore':'project.archive',projectId:modal.project.projectId,expectedEntityRevision:modal.project.revision})}>确认{modal.project.status==='archived'?'启用':'归档'}</button>}
    {modal.kind==='approval'&&modal.approval.status==='pending'&&<><button type="button" className="mc-danger" disabled={busy||stale} onClick={()=>void send({type:'approval.decide',approvalId:modal.approval.approvalId,expectedEntityRevision:modal.approval.revision,decision:'rejected',actorRole:'owner',note})}>退回修改</button><button type="button" className="mc-primary" disabled={busy||stale} onClick={()=>void send({type:'approval.decide',approvalId:modal.approval.approvalId,expectedEntityRevision:modal.approval.revision,decision:'approved',actorRole:'owner',note})}>通过计划</button></>}
  </footer></Dialog>
}
