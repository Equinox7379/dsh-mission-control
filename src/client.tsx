import React, { useSyncExternalStore } from 'react'
import { installBrowserBridge } from './bridge.js'
import { MissionControlClientStore } from './client-store.js'
import { Workbench } from './workbench/view.js'
import { WORKBENCH_CSS } from './workbench/styles.js'

export const inject = ['slots', 'sessions', 'workspaces', 'conversation']

class Boundary extends React.Component<React.PropsWithChildren<{onClose():void}>,{failed:boolean}> {
  state={failed:false}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed
    ? <section data-mc-workbench="" role="dialog" aria-modal="true" aria-label="任务指挥台显示异常"><div className="mc-empty"><h2>任务指挥台暂时无法显示</h2><p>没有重置任务，也没有停止官方会话。请关闭后重新打开。</p><button type="button" onClick={()=>{this.setState({failed:false});this.props.onClose()}}>关闭指挥台</button></div></section>
    : this.props.children}
}

/** A separate lifecycle per installation. No demo data, global styles, or execution on open. */
export function apply(ctx:any):void {
  const client=new MissionControlClientStore()
  let opened=false
  const listeners=new Set<()=>void>()
  const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
  const setOpen=(next:boolean)=>{if(opened===next)return;opened=next;listeners.forEach(listener=>listener())}
  const Launcher=()=> <button type="button" className="mc-launch" onClick={()=>setOpen(true)}>任务指挥台</button>
  const Overlay=()=>{const isOpen=useSyncExternalStore(subscribe,()=>opened);return <Boundary onClose={()=>setOpen(false)}><Workbench client={client} runtime={ctx} opened={isOpen} onClose={()=>setOpen(false)}/></Boundary>}
  ctx.effect(()=>{
    const style=document.createElement('style');style.dataset.plugin='dsh-mission-control';style.textContent=WORKBENCH_CSS;document.head.appendChild(style)
    return()=>style.remove()
  })
  ctx.effect(()=>{
    const bridge=installBrowserBridge(ctx,{setOpen})
    return()=>{bridge.dispose();setOpen(false);client.close();listeners.clear()}
  })
  ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'mission-control',order:20},Launcher))
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'mission-control-header',order:20},Launcher))
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'mission-control-overlay',order:20},Overlay))
}
