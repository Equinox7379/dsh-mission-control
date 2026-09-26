import React from 'react'
import { applyCommand,createInitialState } from './domain.js'
import { applyWorkCommand } from './workflow.js'

const params=new URLSearchParams((window as any).__fixtureSearch ?? location.search)
let state=createInitialState()
const projectTitles=['DSH 工作环境','个人知识库','灰湾货运站','会计临界点','课程研究','旅行场景','视觉素材','归档的旧项目']
const objectives=['让日常任务更容易找到、开始和验收。保留已有会话能力与历史数据，把执行过程与人工判断分开。','核对实际结果，保留原有资料。记录可复查的依据，无法确认的部分不标记完成。']
function command(c:any){state=applyCommand(state,state.revision,c)}
if(params.get('scenario')!=='empty'){
  projectTitles.forEach((title,i)=>command({type:'project.create',projectId:`project-${i}`,title}))
  for(let i=0;i<64;i++){
    let title=['核对附件保全后的恢复范围','修复窄窗口中的工具栏布局','确认上一次请求是否已被接收','检查队友仍在处理的场景资源','重做任务指挥台的日常工作路径','整理沿海货运站的灯光与材质','为会计案例补全数据来源与计算依据'][i]??`${['整理项目资料','检查输出文件','核对场景资源','补充验证记录'][i%4]} · 第 ${i+1} 项`
    if(i===9)title='检查超长任务标题在较窄桌面窗口中的换行、完整详情、键盘焦点与所有操作是否可达，不能只在少量演示卡片中工作'
    command({type:'task.create',taskId:`task-${i}`,projectId:`project-${i<7?0:1+i%6}`,title,objective:objectives[i%2],acceptanceCriteria:i<10?['打开工作台即可看到优先事项和待处理结果。','新建、编辑、关联会话与执行确认形成完整路径。','旧任务数据可读取，模型回合结束不会自动验收。']:[],priority:i===0?'critical':i<7?'high':i%4===0?'low':'normal'})
    if(i<7)command({type:'task.bind-session',taskId:`task-${i}`,expectedEntityRevision:state.tasks[`task-${i}`].revision,sessionId:`session-${i}`})
  }
  command({type:'task.transition',taskId:'task-0',expectedEntityRevision:state.tasks['task-0'].revision,phase:'blocked',blockedReason:{code:'fixture',message:'核对恢复包中的附件和原始会话是否对应，尚未进行生产恢复。'}})
  command({type:'task.update',taskId:'task-4',expectedEntityRevision:state.tasks['task-4'].revision,planMarkdown:'先分离任务浏览与编辑，再调整执行确认和验收记录。所有演示使用合成数据。'})
  command({type:'evidence.append',taskId:'task-4',evidenceId:'evidence-demo',evidenceType:'browser',status:'pass',label:'隔离页面交互检查',summary:'使用合成任务检查桌面与窄窗交互。这不是生产 Desktop 或真实模型验收。',producer:{kind:'human',name:'隔离测试'},redacted:true})
}
const runs:any={};const teams:any={};const sendCalls:any[]=[];const stopCalls:any[]=[];const sessions:any[]=[]
for(let i=0;i<12;i++)sessions.push({id:`session-${i}`,title:['DSH 环境维护','界面布局修订','长任务核对','场景资源检查','任务指挥台改版'][i]??`已配置的测试会话 ${i}`,cwd:`D:\\SyntheticWork\\project-${i}`})
for(const [i,status]of [[1,'failed'],[2,'unconfirmed'],[3,'completed'],[4,'completed']] as const){const task=state.tasks[`task-${i}`];if(!task)continue;runs[task.taskId]={runId:`execution-${i}`,intentId:`intent-${i}`,taskId:task.taskId,projectId:task.projectId,taskRevision:task.revision,sessionId:`session-${i}`,cwd:'D:\\SyntheticWork\\mission-control',model:'已配置的会话模型（隔离模拟）',requestId:`mc-run-${i}`,status,createdAt:Date.now()-300000,updatedAt:Date.now()-10000,baseSeq:-1,cursor:4,activity:status==='failed'?'该回合返回错误，请到原会话核对。':status==='unconfirmed'?'启动结果尚未确认，未自动重发。':'主助手本轮已结束。',output:i===4?'已调整任务入口、编辑窗口与验收路径。请核对实际页面和交付文件后再验收。':'',tools:[],toolCalls:3,toolErrors:status==='failed'?1:0}}
if(state.tasks['task-3'])teams['session-3']={sessionId:'session-3',state:'live',busy:true,pendingMessages:1,members:[{id:'lead',name:'主助手',role:'lead',status:'idle',queued:0},{id:'teammate',name:'资源整理',role:'teammate',status:'running',queued:1}]}
const listeners=new Set<()=>void>();let snap:any={phase:params.get('scenario')==='error'?'error':'ready',state,host:{pluginVersion:'0.3.0-rc.1',storage:'ready'},...(params.get('scenario')==='error'?{error:{code:'network',message:'隔离测试连接失败'}}:{})}
const publish=()=>{snap={...snap,state};listeners.forEach(f=>f())}
const active=()=>Object.values(runs).find((r:any)=>(!r.releasedAt&&['dispatching','accepted','running','stopping','unconfirmed','detached'].includes(r.status))||teams[r.sessionId]?.busy||teams[r.sessionId]?.state==='unavailable') as any
const previewMap=new Map();let opened=true
const client:any={
 getSnapshot:()=>snap,subscribe:(f:any)=>{listeners.add(f);return()=>listeners.delete(f)},
 async connect(){if(params.get('scenario')==='error')return snap;snap={...snap,phase:'ready'};publish();return snap},
 async refresh(){publish();return snap},
 async mutate(c:any){try{if(['task.accept','task.reopen','task.bind-session','task.unbind-session'].includes(c.type)){const r=runs[c.taskId];if(r&&!r.releasedAt&&['running','unconfirmed','dispatching','accepted','stopping','detached'].includes(r.status))throw {code:'execution.still-active',message:'该任务仍有运行或未确认记录，请先核对。'};if(teams[r?.sessionId]?.busy)throw {message:'团队仍忙，暂不能验收。'}}state=applyWorkCommand(state,state.revision,c);snap={...snap,error:undefined};publish();return snap}catch(error){snap={...snap,error};publish();return snap}},
 async executionCall(method:string,args:any){
  if(method==='execution.overview')return{enabled:true,activeTaskId:active()?.taskId,runs:Object.values(runs).map((r:any)=>({...r,teamBusy:teams[r.sessionId]?.busy}))}
  if(method==='execution.status')return{enabled:true,run:runs[args.taskId],team:teams[runs[args.taskId]?.sessionId],activeTaskId:active()?.taskId}
  if(method==='execution.preview'){const t=state.tasks[args.taskId];if(!t.sessionBinding)throw {message:'请选择会话。'};const p={previewId:'preview-'+crypto.randomUUID(),expiresAt:Date.now()+120000,taskId:t.taskId,taskRevision:t.revision,sessionId:t.sessionBinding.sessionId,cwd:'D:\\SyntheticWork\\mission-control',model:'已配置的会话模型（隔离模拟）',prompt:`目标：${t.objective||t.title}\n\n验收要求：\n${t.acceptanceCriteria.join('\n')}`,warning:'预览使用合成会话。本页面不会调用真实模型。'};previewMap.set(p.previewId,p);return p}
  if(method==='execution.start'){const previous=Object.values(runs).find((r:any)=>r.intentId===args.intentId);if(previous)return previous;if(active())throw {message:'请先处理已有运行。'};const p:any=previewMap.get(args.previewId);const run={...p,runId:'execution-'+crypto.randomUUID(),intentId:args.intentId,status:'running',activity:'隔离模拟正在处理',createdAt:Date.now(),updatedAt:Date.now(),output:'',tools:[],toolCalls:0,toolErrors:0};runs[p.taskId]=run;sendCalls.push(args);return run}
  if(method==='execution.stop'){stopCalls.push(args);return runs[args.taskId]={...runs[args.taskId],status:'cancelled',activity:'已取消本轮合成请求'}}
  if(method==='execution.acknowledge'){if(teams[runs[args.taskId]?.sessionId]?.busy)throw {message:'团队仍在运行。'};return runs[args.taskId]={...runs[args.taskId],releasedAt:Date.now(),activity:'已核对并解除占用，没有重发'}}
  throw new Error('Unsupported fixture method '+method)
 },async writeExport(){return {path:'D:\\SyntheticExport\\任务记录.md',sha256:'fixture-only'}}
}
const runtime={sessions:{list:{getSnapshot:()=>sessions},refresh:async()=>{},open:async(id:string)=>{(window as any).lastOpenedSession=id},create:async()=>{const s={id:'session-'+crypto.randomUUID(),title:'新建的合成会话',cwd:'D:\\SyntheticWork'};sessions.push(s);return s}}}

// Test-only HTTP transport. Production client/registration/React components are unmodified.
const httpCalls:any[]=[]
window.fetch=async(input:any,options:any={})=>{
  if(String(input).endsWith('/health'))return Response.json({ok:params.get('scenario')!=='error',pluginVersion:'0.3.0-rc.1',protocolFingerprint:'fixture-fp',certifiedDsh:'0.1.7-rc.2',storage:'ready'},{status:params.get('scenario')==='error'?503:200})
  const request=JSON.parse(options.body);httpCalls.push(request)
  try{
    let result:any
    if(request.method==='system.handshake')result={csrf:'c'.repeat(43),protocolFingerprint:'fixture-fp'}
    else if(request.method==='state.snapshot')result=state
    else if(request.method==='export.write')result={path:'D:\\SyntheticExport\\MissionControl-export.json',sha256:'fixture-only'}
    else if(request.method.startsWith('execution.'))result=await client.executionCall(request.method,request.args)
    else{
      if(request.expectedStateRevision!==state.revision)throw {code:'revision-conflict',message:'任务已经从另一处更新。'}
      const reply=await client.mutate({type:request.method,...request.args});if(reply.error)throw reply.error;result=state
    }
    return Response.json({v:1,requestId:request.requestId,ok:true,result})
  }catch(error:any){return Response.json({v:1,requestId:request.requestId,ok:false,error:{code:error.code??'fixture-error',message:error.message??'合成服务出错'}},{status:error.code==='revision-conflict'?409:400})}
}
const disposers:any[]=[];const slots:any[]=[]
const ctx:any={...runtime,workspaces:{list:{getSnapshot:()=>[]}},conversation:{},effect:(fn:any)=>{const cleanup=fn();if(typeof cleanup==='function')disposers.push(cleanup)},slots:{inject:(_name:string,fn:any)=>fn(),register:(descriptor:any,component:any)=>{slots.push({descriptor,component});return()=>{}}}}
const plugin=(window as any).__mcProduction.factory((id:string)=>{
 if(id==='react')return (window as any).React
 if(id==='react/jsx-runtime')return {jsx:(type:any,props:any,key:any)=>React.createElement(type,{...props,key}),jsxs:(type:any,props:any,key:any)=>React.createElement(type,{...props,key}),Fragment:React.Fragment}
 throw new Error('Unexpected production external '+id)
})
plugin.apply(ctx)
const Launcher=slots.find((s:any)=>s.descriptor.id==='mission-control').component
const Overlay=slots.find((s:any)=>s.descriptor.id==='mission-control-overlay').component
const dom=(window as any).ReactDOM.createRoot(document.getElementById('app'))
const open=()=>document.querySelector<HTMLButtonElement>('.mc-launch')?.click()
function PreviewApp(){React.useEffect(()=>{open()},[]);return <><Launcher/><Overlay/></>}
dom.render(<PreviewApp/>)
;(window as any).fixture={runtime,runs,teams,sendCalls,stopCalls,httpCalls,slots,get state(){return state},open,
 dispose(){for(const d of disposers.reverse())d()},
 clearActivity(){for(const r of Object.values(runs)as any[])r.releasedAt=Date.now();for(const t of Object.values(teams)as any[])t.busy=false},
 complete(taskId:string){runs[taskId]={...runs[taskId],status:'completed',activity:'合成回合结束',output:'隔离模拟的结果，仍需人工核对。'}},
 conflict(taskId:string){command({type:'task.update',taskId,expectedEntityRevision:state.tasks[taskId].revision,objective:'其他位置刚保存的新目标'});publish()}}
