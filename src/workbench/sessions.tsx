import React, { useEffect, useRef, useState } from 'react'
import type { Task } from '../domain.js'
import { MissionControlClientStore } from '../client-store.js'
import { bindExistingSession, createOpenBindSession, unbindSession } from '../session-saga.js'
import { Dialog } from './dialog.js'
import { errorText, sessionsFrom } from './model.js'

export function SessionDialog({task,client,runtime,onClose,onSaved}: {
  task: Task; client: MissionControlClientStore; runtime: any; onClose():void; onSaved():void
}) {
  const [sessions,setSessions] = useState<ReturnType<typeof sessionsFrom>>([])
  const [query,setQuery] = useState('')
  const [loading,setLoading] = useState(true)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [createdId,setCreatedId] = useState(task.bindingRepair?.sessionId)
  const [createdAttempt,setCreatedAttempt] = useState(false)
  const lock = useRef(false)
  const alive = useRef(true)
  const refresh = async () => {
    setLoading(true)
    try { await runtime.sessions.refresh?.(); if(alive.current) setSessions(sessionsFrom(runtime.sessions.list.getSnapshot())) }
    catch(e) { if(alive.current) setError(errorText(e)) }
    finally { if(alive.current) setLoading(false) }
  }
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false}},[])
  const bind = async(id:string) => {
    if(lock.current)return;lock.current=true;setBusy(true);setError('')
    try {const result=await bindExistingSession(task,id,client);if(!alive.current)return;if(result.status==='bound')onSaved();else setError(errorText({message:result.message}))}
    catch(e){if(alive.current)setError(errorText(e))}
    finally{lock.current=false;if(alive.current)setBusy(false)}
  }
  const create = async()=>{
    if(lock.current||createdAttempt)return;lock.current=true;setBusy(true);setCreatedAttempt(true);setError('')
    try {
      const result=await createOpenBindSession(task,runtime.sessions,client)
      if(!alive.current)return
      if(result.status==='bound'){setCreatedId(result.sessionId);onSaved()}
      else {
        if('sessionId' in result)setCreatedId(result.sessionId)
        setError('创建或关联尚未完整确认。不会再次创建会话，请刷新列表并找回已创建的会话。')
        await refresh()
      }
    } catch(e){if(alive.current)setError('创建结果未确认。请刷新会话列表核对，不要重复创建。')}
    finally{lock.current=false;if(alive.current)setBusy(false)}
  }
  const unbind = async()=>{
    if(lock.current)return;lock.current=true;setBusy(true)
    try{if(await unbindSession(task,client))onSaved();else setError(errorText(client.getSnapshot().error))}
    catch(e){setError(errorText(e))}finally{lock.current=false;setBusy(false)}
  }
  const filtered=sessions.filter(s=>`${s.title} ${s.cwd??''} ${s.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <Dialog title="关联会话" onClose={onClose} busy={busy}>
    <div className="mc-dialog-body">
      <p className="mc-muted">选择已配置工作目录和模型的普通 DSH 会话。关联不会发送任务，也不会删除原会话。</p>
      {error&&<div className="mc-notice warn" role="alert">{error}</div>}
      {createdId&&<div className="mc-notice"><strong>可找回的会话</strong><code>{createdId}</code><button type="button" disabled={busy} onClick={()=>void bind(createdId)}>关联这个会话</button></div>}
      <div className="mc-actions"><input autoFocus aria-label="搜索会话" value={query} onChange={e=>setQuery(e.target.value)} placeholder="按会话名称或工作目录搜索"/><button type="button" onClick={()=>void refresh()} disabled={loading||busy}>刷新列表</button></div>
      {loading?<p role="status" className="mc-muted">正在读取会话…</p>:<div className="mc-session-options">{filtered.map(s=><button type="button" key={s.id} className="mc-session-option" disabled={busy} onClick={()=>void bind(s.id)} aria-label={`关联 ${s.title}`}>
        <strong>{s.title}</strong><small>{s.cwd??s.id}</small><span>{task.sessionBinding?.sessionId===s.id?'当前关联':'关联 →'}</span>
      </button>)}{!filtered.length&&<p className="mc-empty">{query?'没有匹配的会话。':'还没有可关联的会话。可以先在 DSH 中创建并配置。'}</p>}</div>}
      <details className="mc-optional"><summary>新建会话或解除关联</summary><p className="mc-muted">新建会话会调用 DSH 的创建与打开功能，但不会发送模型请求。创建后仍须核对工作目录与模型。</p>
        <div className="mc-actions"><button type="button" className="mc-secondary" disabled={busy||createdAttempt} onClick={()=>void create()}>新建并关联会话</button>
          {task.sessionBinding&&<button type="button" disabled={busy} onClick={()=>void unbind()}>只解除关联</button>}</div>
      </details>
    </div><footer className="mc-dialog-foot"><span className="mc-muted" role="status">{busy?'正在处理关联…':'任务记录和官方会话分别保存'}</span><button type="button" disabled={busy} onClick={onClose}>返回任务</button></footer>
  </Dialog>
}
