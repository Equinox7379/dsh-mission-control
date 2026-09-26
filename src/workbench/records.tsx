import React, { useRef, useState } from 'react'
import type { Evidence, EvidenceStatus, EvidenceType, MissionControlStateV1, Task } from '../domain.js'
import { MissionControlClientStore } from '../client-store.js'
import { Dialog } from './dialog.js'
import { EVIDENCE, errorText } from './model.js'
import { uid } from './editors.js'

export const STATUS:Record<EvidenceStatus,string>={pass:'通过',fail:'未通过',warning:'需留意',info:'说明','not-reproduced':'未复现'}
export const dateText=(time:number)=>new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(time)
export function EvidenceDialog({task,client,owner,onClose,onSaved}:{task:Task;client:MissionControlClientStore;owner:string;onClose():void;onSaved():void}){
  const [id]=useState(()=>uid('evidence'))
  const [type,setType]=useState<EvidenceType>('manual-acceptance')
  const [status,setStatus]=useState<EvidenceStatus>('info')
  const [label,setLabel]=useState('')
  const [summary,setSummary]=useState('')
  const [locator,setLocator]=useState('')
  const [kind,setKind]=useState<NonNullable<Evidence['locator']>['kind']>('external-reference')
  const [busy,setBusy]=useState(false);const lock=useRef(false)
  const [error,setError]=useState('');const [uncertain,setUncertain]=useState(false)
  const save=async(e:React.FormEvent)=>{e.preventDefault();if(lock.current||uncertain)return;lock.current=true;setBusy(true)
    try{const r=await client.mutate({type:'evidence.append',evidenceId:id,taskId:task.taskId,evidenceType:type,status,label:label.trim()||EVIDENCE[type],summary,producer:{kind:'human',name:owner},redacted:true,...(locator.trim()?{locator:{kind,value:locator.trim()}}:{})})
      if(r.error){setError(errorText(r.error));setUncertain(['network','csrf-refused','invalid-response'].includes(r.error.code))}else if(r.phase==='ready'&&r.state?.evidence[id])onSaved()
    }catch(e){setError(errorText(e))}finally{lock.current=false;setBusy(false)}}
  return <Dialog title="记录验证结果" onClose={onClose} busy={busy} dirty={!!(label||summary||locator)}><form onSubmit={save}><div className="mc-dialog-body">
    <p className="mc-muted">记录你实际检查过的内容。添加“通过”记录不会自动验收任务。</p>
    {error&&<div className="mc-notice warn" role="alert">{error}{uncertain&&<button type="button" onClick={async()=>{const r=await client.refresh();if(r.error)return setError(errorText(r.error));if(r.state?.evidence[id])onSaved();else{setUncertain(false);setError('当前未发现这条记录。没有自动再次保存。')}}}>核对已保存记录</button>}</div>}
    <div className="mc-form-grid"><label className="mc-field">记录类型<select value={type} onChange={e=>setType(e.target.value as EvidenceType)}>{Object.entries(EVIDENCE).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label className="mc-field">结果<select value={status} onChange={e=>setStatus(e.target.value as EvidenceStatus)}>{Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label className="mc-field wide">简短标题<input autoFocus value={label} maxLength={200} onChange={e=>setLabel(e.target.value)} placeholder="例如：旧任务数据读取验证"/></label>
      <label className="mc-field wide">检查了什么、得到什么结果<textarea required value={summary} maxLength={8000} rows={5} onChange={e=>setSummary(e.target.value)}/></label>
      <label className="mc-field">引用类型<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="external-reference">链接或其他引用</option><option value="local-path">本地文件路径</option><option value="commit">提交</option><option value="workflow-run">构建记录</option><option value="session-range">会话片段</option></select></label>
      <label className="mc-field">引用位置 <span className="mc-muted">可留空</span><input value={locator} maxLength={4096} onChange={e=>setLocator(e.target.value)}/></label>
    </div></div><footer className="mc-dialog-foot"><span className="mc-muted">只记录，不执行引用中的命令</span><button className="mc-primary" disabled={busy||uncertain||!summary.trim()}>{busy?'正在保存…':'保存记录'}</button></footer></form></Dialog>
}

export function AcceptanceDialog({task,client,state,onClose,onSaved}:{task:Task;client:MissionControlClientStore;state:MissionControlStateV1;onClose():void;onSaved():void}){
  const [id]=useState(()=>uid('evidence'));const [note,setNote]=useState('');const [confirmed,setConfirmed]=useState(false)
  const [busy,setBusy]=useState(false);const lock=useRef(false);const [error,setError]=useState('');const [uncertain,setUncertain]=useState(false)
  const current=state.tasks[task.taskId];const stale=current?.revision!==task.revision
  const save=async(e:React.FormEvent)=>{e.preventDefault();if(lock.current||stale||uncertain||!confirmed)return;lock.current=true;setBusy(true)
    try{const r=await client.mutate({type:'task.accept',taskId:task.taskId,expectedEntityRevision:task.revision,evidenceId:id,note,confirmed:true,actorRole:'owner'})
      if(r.error){setError(errorText(r.error));setUncertain(['network','csrf-refused','invalid-response'].includes(r.error.code))}else if(r.phase==='ready'&&r.state?.tasks[task.taskId]?.phase==='done')onSaved()
    }catch(e){setError(errorText(e))}finally{lock.current=false;setBusy(false)}}
  return <Dialog title="人工验收" onClose={onClose} busy={busy} dirty={!!note}><form onSubmit={save}><div className="mc-dialog-body">
    <h3>{task.title}</h3><p className="mc-muted">AI 结束一轮不等于交付合格。这一步由你确认实际结果，保存后任务进入“已验收”，并保留验收记录。</p>
    {task.acceptanceCriteria.length>0&&<ol className="mc-criteria">{task.acceptanceCriteria.map((text,i)=><li key={i}>{text}</li>)}</ol>}
    {stale&&<div className="mc-notice warn" role="alert">任务内容刚刚更新。请返回任务核对后再验收，本窗口不会采用旧要求提交。</div>}
    {error&&<div className="mc-notice warn" role="alert">{error}{uncertain&&<button type="button" onClick={async()=>{const r=await client.refresh();if(r.error)return setError(errorText(r.error));if(r.state?.tasks[task.taskId]?.phase==='done'&&r.state?.evidence[id])onSaved();else{setUncertain(false);setError('已读取当前状态。未自动再次提交验收。')}}}>核对验收是否已保存</button>}</div>}
    <label className="mc-field">我核对过的结果<textarea autoFocus required maxLength={2000} rows={5} value={note} onChange={e=>setNote(e.target.value)} placeholder="简要说明哪些结果已达到要求。"/></label>
    <label className="mc-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对实际交付，不只是模型的完成声明。</label>
    <p className="mc-muted">任务或团队仍忙、运行结果未确认、前置任务未验收时，服务端会拒绝此次验收。</p>
  </div><footer className="mc-dialog-foot"><button type="button" onClick={onClose} disabled={busy}>返回核对</button><button className="mc-primary" disabled={busy||stale||uncertain||!confirmed||!note.trim()}>{busy?'正在保存验收…':'确认验收通过'}</button></footer></form></Dialog>
}
