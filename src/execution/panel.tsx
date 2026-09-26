import React, { useEffect, useRef, useState } from 'react'
import type { Task } from '../domain.js'
import { MissionControlClientStore } from '../client-store.js'
import type { ExecutionPreview, ExecutionRun, ExecutionView } from './types.js'
import { Dialog } from '../workbench/dialog.js'
import { closed, errorText } from '../workbench/model.js'
import { uid } from '../workbench/editors.js'

const LABEL:Record<ExecutionRun['status'],string>={dispatching:'请求已登记',accepted:'DSH 已接收',running:'主助手正在处理',stopping:'正在停止主助手',completed:'本轮已结束',failed:'本轮未完成',cancelled:'本轮已取消',interrupted:'本轮被中断',unconfirmed:'执行结果未确认',detached:'会话另有操作'}
const LIVE=new Set(['dispatching','accepted','running','stopping'])
const MEMBER:Record<string,string>={running:'运行中',idle:'空闲',inactive:'未启动',provisioning:'创建中',failed:'创建失败'}

export function TaskExecutionPanel({task,client,hostReady,readOnly=false,onOpenSession,onChooseSession,onAccept,onChanged,onView,onOpenTask}: {
  task:Task;client:MissionControlClientStore;hostReady:boolean;readOnly?:boolean
  onOpenSession(id:string):Promise<void>;onChooseSession?():void;onAccept?():void;onChanged?():void;onView?(view:ExecutionView):void;onOpenTask?(taskId:string):void
}) {
  const [view,setView]=useState<ExecutionView>()
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  const [preview,setPreview]=useState<ExecutionPreview>()
  const [confirm,setConfirm]=useState<'stop'|'release'|'local-uncertain'>()
  const [checked,setChecked]=useState(false)
  const [pendingIntent,setPendingIntent]=useState<string>()
  const pendingRef=useRef<string>()
  const lock=useRef(false);const alive=useRef(true);const statusSequence=useRef(0)
  const callbacks=useRef({onChanged,onView});callbacks.current={onChanged,onView}
  const publish=(next:ExecutionView)=>{if(!alive.current)return;setView(next);setLoading(false);callbacks.current.onView?.(next)
    if(pendingRef.current&&next.run?.intentId===pendingRef.current){pendingRef.current=undefined;setPendingIntent(undefined)}}
  const refresh=async(signal?:AbortSignal)=>{
    const sequence=++statusSequence.current
    const next=await client.executionCall('execution.status',{taskId:task.taskId},signal) as ExecutionView
    if(!signal?.aborted&&sequence===statusSequence.current)publish(next)
    return next
  }
  useEffect(()=>{
    alive.current=true
    if(!hostReady){setLoading(false);return()=>{alive.current=false}}
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
    const poll=async()=>{
      try{await refresh(controller.signal)}catch(e){if(!controller.signal.aborted){setError(errorText(e));setLoading(false)}}
      if(!controller.signal.aborted)timer=setTimeout(poll,document.hidden?8000:4000)
    }
    void poll()
    return()=>{alive.current=false;controller.abort();if(timer)clearTimeout(timer);++statusSequence.current}
  },[client,task.taskId,task.sessionBinding?.sessionId,hostReady])
  useEffect(()=>setPreview(undefined),[task.revision,task.sessionBinding?.sessionId])
  const action=async(work:()=>Promise<void>)=>{
    if(lock.current)return
    lock.current=true;setBusy(true);setError('')
    try{await work()}catch(e){if(alive.current)setError(errorText(e))}
    finally{lock.current=false;if(alive.current)setBusy(false)}
  }
  const prepare=()=>action(async()=>{
    const next=await client.executionCall('execution.preview',{taskId:task.taskId}) as ExecutionPreview
    if(alive.current)setPreview(next)
  })
  const start=()=>action(async()=>{
    if(!preview||pendingRef.current)return
    const intent=uid('intent');pendingRef.current=intent;setPendingIntent(intent)
    const selected=preview;setPreview(undefined)
    try{
      const run=await client.executionCall('execution.start',{previewId:selected.previewId,intentId:intent}) as ExecutionRun
      if(run.intentId!==intent)throw {code:'invalid-response',message:'运行回执不匹配，请核对原会话。'}
      publish({enabled:true,...view,run})
      callbacks.current.onChanged?.()
    }catch(e){if(alive.current)setError('无法确认这次请求是否已被接收。不会自动重发，请查询本次启动或打开原会话核对。')}
  })
  const confirmAction=()=>action(async()=>{
    if(!checked)return
    if(confirm==='local-uncertain'){
      const current=await refresh()
      if(current.run&&!current.run.releasedAt&&['dispatching','accepted','running','stopping','unconfirmed','detached'].includes(current.run.status))throw {message:'指挥台已有尚未结束或需要核对的记录，请先处理该记录。'}
      pendingRef.current=undefined;setPendingIntent(undefined);setConfirm(undefined);setChecked(false)
      setError('已解除本界面的等待，没有发送任何任务。下一次执行仍需重新预览并确认。');return
    }
    if(!view?.run)return
    const run=await client.executionCall(confirm==='stop'?'execution.stop':'execution.acknowledge',{
      taskId:task.taskId,runId:view.run.runId,...(confirm==='release'?{confirmed:true}:{})
    }) as ExecutionRun
    publish({...view,run});setConfirm(undefined);setChecked(false);callbacks.current.onChanged?.()
  })
  const run=view?.run;const team=view?.team
  const active=!!run&&!run.releasedAt&&LIVE.has(run.status)
  const unresolved=!!run&&!run.releasedAt&&['unconfirmed','detached'].includes(run.status)
  const blocked=busy||readOnly||!hostReady||view?.enabled===false||active||unresolved||!!pendingIntent||!!team?.busy||team?.state==='unavailable'
  const otherBusy=!!view?.activeTaskId&&view.activeTaskId!==task.taskId
  const showTeam=team&&(team.state==='unavailable'||team.busy||team.pendingMessages>0||team.members.some(m=>m.role==='teammate'))
  return <section className="mc-execution" data-testid="mc-execution">
    <div className="mc-between"><h3>{run?LABEL[run.status]:'还没有发起执行'}</h3><button type="button" className="mc-secondary" disabled={busy||!hostReady} onClick={()=>void action(async()=>{await refresh()})}>查询运行状态</button></div>
    {loading&&<p className="mc-muted" role="status">正在读取本次运行…</p>}
    {(error||view?.notice)&&<div className="mc-notice warn" role="alert">{error||view?.notice}</div>}
    {otherBusy&&<div className="mc-notice">指挥台另有运行或未确认的请求，请先核对原任务。{onOpenTask&&<button type="button" onClick={()=>onOpenTask(view!.activeTaskId!)}>查看当前占用的任务 →</button>}</div>}
    {!task.sessionBinding&&<div className="mc-empty"><h3>先关联一个会话</h3><p>执行沿用会话的工作目录、模型和权限。不会根据项目名称猜测目录。</p>{onChooseSession&&<button type="button" className="mc-primary" onClick={onChooseSession}>选择关联会话</button>}</div>}
    {run&&<>
      <p className="mc-run-activity" role="status">{run.activity}</p>
      {run.reason&&<p className="mc-muted">{run.reason}</p>}
      {run.taskRevision!==task.revision&&!closed(task)&&<div className="mc-notice">任务内容在这次发送后有更新。下方是上一次发送的结果，不代表新的要求已经完成。</div>}
      <dl className="mc-metadata"><dt>工作目录</dt><dd>{run.cwd}</dd><dt>模型</dt><dd>{run.model}</dd><dt>关联会话</dt><dd><code>{run.sessionId}</code></dd></dl>
      {run.output&&<section className="mc-section"><h3>模型返回的结果</h3><p className="mc-muted">这是模型输出，尚未替你验证交付。</p><pre className="mc-prose">{run.output}</pre></section>}
      <details className="mc-optional"><summary>工具活动：{run.toolCalls} 次调用，{run.toolErrors} 次错误</summary>
        <p className="mc-muted">仅显示本轮观察摘要，完整内容以官方会话为准。</p>
        {run.tools.map(t=><p key={t.callId}>{t.name} · {t.status==='requested'?'已请求':t.status==='error'?'返回错误':'已返回'}</p>)}
      </details>
    </>}
    {showTeam&&<section className="mc-section" data-testid="mc-execution-team"><h3>会话团队</h3><p className="mc-muted">{team.state==='unavailable'?'团队状态暂时无法确认，暂不发送或验收。':team.busy?'队友或团队消息仍在处理中，主助手结束不等于团队结束。':'团队目前空闲，交付仍需你核对。'}</p>
      <ul className="mc-team-list">{team.members.map(m=><li key={m.id}><span>{m.role==='lead'?'主助手':m.name}</span><span>{MEMBER[m.status]??'待核对'}{m.queued?` · ${m.queued} 条待处理`:''}</span></li>)}</ul>
      {team.pendingMessages>0&&<p>{team.pendingMessages} 条团队消息待投递。</p>}
      <button type="button" onClick={()=>void action(()=>onOpenSession(team.sessionId))}>在原会话查看团队 →</button>
    </section>}
    <div className="mc-actions">
      {!closed(task)&&task.sessionBinding&&<button type="button" className="mc-primary" disabled={blocked||otherBusy} onClick={()=>void prepare()}>{run?'准备下一次执行':'预览并发送任务'}</button>}
      {(run?.sessionId||task.sessionBinding?.sessionId)&&<button type="button" className="mc-secondary" disabled={busy} onClick={()=>void action(()=>onOpenSession(run?.sessionId??task.sessionBinding!.sessionId))}>打开对应会话 →</button>}
      {active&&<button type="button" className="mc-danger" disabled={busy||!!run?.stopRequestedAt} onClick={()=>{setConfirm('stop');setChecked(false)}}>停止主助手本轮</button>}
      {unresolved&&<button type="button" disabled={busy} onClick={()=>{setConfirm('release');setChecked(false)}}>核对后解除占用</button>}
      {pendingIntent&&!active&&!unresolved&&<button type="button" disabled={busy} onClick={()=>{setConfirm('local-uncertain');setChecked(false)}}>我已在原会话核对</button>}
      {run?.status==='completed'&&!closed(task)&&onAccept&&<button type="button" disabled={blocked} onClick={onAccept}>核对交付并验收</button>}
    </div>
    <p className="mc-footnote">关闭指挥台不会停止会话。停止仅针对本插件仍能确认归属的主助手消息或回合，队友与外部后台程序可能继续工作。</p>
    {preview&&<Dialog title="确认这次发送" onClose={()=>setPreview(undefined)} busy={busy}>
      <div className="mc-dialog-body"><p className="mc-muted">确认后会产生真实模型调用，沿用该会话的模型、工具和权限。</p>
        <dl className="mc-metadata"><dt>会话</dt><dd><code>{preview.sessionId}</code></dd><dt>工作目录</dt><dd>{preview.cwd}</dd><dt>模型</dt><dd>{preview.model}</dd></dl>
        <h3>将发送的完整内容</h3><pre className="mc-prompt">{preview.prompt}</pre><p className="mc-muted">{preview.warning}</p>
      </div><footer className="mc-dialog-foot"><button type="button" onClick={()=>setPreview(undefined)} disabled={busy}>返回修改</button><button type="button" className="mc-primary" disabled={busy||blocked||otherBusy} onClick={()=>void start()}>确认发送一次</button></footer>
    </Dialog>}
    {confirm&&<Dialog title={confirm==='stop'?'停止主助手本轮':'核对未确认的执行'} onClose={()=>setConfirm(undefined)} busy={busy}>
      <div className="mc-dialog-body"><p>{confirm==='stop'?'仅请求停止本插件发送、且仍能确认归属的主助手消息或回合。不会承诺停止整个团队。':'请先查看原会话与团队，确认没有需要等待的请求或工作。解除占用不会取消任务、补发指令或把结果标记为成功。'}</p>
        <label className="mc-check"><input autoFocus type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>{confirm==='stop'?'我知道队友可能继续工作。':'我已核对原会话和团队状态。'}</label>
        {error&&<div role="alert" className="mc-notice warn">{error}</div>}
      </div><footer className="mc-dialog-foot"><button type="button" disabled={busy} onClick={()=>setConfirm(undefined)}>返回</button><button type="button" className={confirm==='stop'?'mc-danger mc-secondary':'mc-primary'} disabled={busy||!checked} onClick={()=>void confirmAction()}>{confirm==='stop'?'确认请求停止':'确认解除占用'}</button></footer>
    </Dialog>}
  </section>
}
