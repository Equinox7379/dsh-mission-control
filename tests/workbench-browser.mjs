import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { previewHtml, previewReactVersion } from './workbench-preview.mjs'

const root=process.env.DSH_MC_TEST_TMP
assert.ok(root&&isAbsolute(root),'DSH_MC_TEST_TMP must be an explicit isolated absolute directory')
assert.notEqual(resolve(root),resolve(homedir()),'Never use the user home as a test root')
if(process.env.DSH_HOME)assert.ok(!resolve(root).startsWith(resolve(process.env.DSH_HOME)),'Do not test in DSH_HOME')
await mkdir(root,{recursive:true});const output=await mkdtemp(join(root,'workbench-'))
const browser=await chromium.launch({headless:true,...(process.env.DSH_MC_BROWSER_EXECUTABLE?{executablePath:process.env.DSH_MC_BROWSER_EXECUTABLE}:{})})
const results=[]
async function run(name,work,viewport={width:1440,height:900},scenario=''){
 const page=await browser.newPage({viewport,deviceScaleFactor:1});const errors=[];page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message))
 try{await page.setContent(await previewHtml(scenario));await page.getByRole('dialog',{name:'任务指挥台',exact:true}).waitFor();await page.waitForTimeout(80);await work(page);assert.deepEqual(errors,[]);results.push({name,passed:true})}
 catch(e){await page.screenshot({path:join(output,'failure.png')});results.push({name,passed:false,error:e.message});throw e}
 finally{await page.close()}
}
const refresh=async p=>{await p.getByRole('button',{name:'刷新任务',exact:true}).click();await p.waitForTimeout(80)}
const task=async(p,title)=>{await p.locator('.mc-task-row').filter({hasText:title}).first().click()}
const noOverflow=async p=>{
 const bad=await p.locator('[data-mc-workbench]').evaluate(root=>Array.from(root.querySelectorAll('.mc-detail,.mc-queue,.mc-dialog,input,select,textarea,button')).filter(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0).filter(e=>{const r=e.getBoundingClientRect();const scroller=e.closest('.mc-projects');return !scroller&&(r.left< -1||r.right>innerWidth+1)}).map(e=>({tag:e.tagName,text:e.textContent.slice(0,50)})))
 assert.deepEqual(bad,[],'controls exceed viewport')
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
}
try{
 await run('actual module registration, 64 task selection and scoped host style',async p=>{
   assert.equal(await p.locator('.mc-task-row').count(),64)
   assert.equal(await p.locator('.mc-task-row[aria-current=true]').count(),1)
   assert.match(await p.locator('.mc-detail h1').innerText(),/核对附件/)
   assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
   assert.deepEqual(await p.evaluate(()=>fixture.slots.map(x=>x.descriptor.id)),['mission-control','mission-control-header','mission-control-overlay'])
   assert.equal(await p.locator('#host-button').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(20, 30, 40)')
   await noOverflow(p);await p.screenshot({path:join(output,'mission-control-desktop.png')})
 })
 await run('empty state creates project and task without a model call',async p=>{
   assert.equal(await p.locator('.mc-task-row').count(),0)
   await p.getByRole('button',{name:'新建项目',exact:true}).click();await p.getByLabel('项目名称',{exact:true}).fill('空状态新项目');await p.getByRole('button',{name:'创建项目',exact:true}).click()
   await p.getByRole('button',{name:'＋ 新建任务',exact:true}).click();await p.getByLabel('任务名称',{exact:true}).fill('第一次要完成的事');await p.getByRole('button',{name:'创建任务',exact:true}).click()
   await p.locator('.mc-detail h1').filter({hasText:'第一次要完成的事'}).waitFor();assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
   assert.equal(await p.evaluate(()=>Object.keys(fixture.state.projects).length),1)
 },undefined,'scenario=empty')
 await run('conflicting edit preserves draft and requires explicit rebase',async p=>{
   await task(p,'核对附件');await p.getByRole('button',{name:'编辑',exact:true}).click();await p.getByLabel('要完成什么').fill('这是我的未保存草稿')
   await p.evaluate(()=>fixture.conflict('task-0'));await p.getByRole('button',{name:'保存更改',exact:true}).click()
   assert.equal(await p.getByLabel('要完成什么').inputValue(),'这是我的未保存草稿')
   await p.getByRole('button',{name:'核对最新内容',exact:true}).click();await p.getByRole('button',{name:'我已核对，允许保存这些更改',exact:true}).click()
   await p.getByRole('button',{name:'保存更改',exact:true}).click();assert.equal(await p.evaluate(()=>fixture.state.tasks['task-0'].objective),'这是我的未保存草稿')
 })
 await run('dirty modal Escape keeps input and restores focus on explicit close',async p=>{
   await p.getByRole('button',{name:'＋ 新建任务',exact:true}).click();await p.getByLabel('任务名称',{exact:true}).fill('尚未保存')
   await p.keyboard.press('Escape');await p.locator('dialog[open] .mc-notice').filter({hasText:'尚有未保存的输入'}).waitFor();assert.equal(await p.getByLabel('任务名称',{exact:true}).inputValue(),'尚未保存')
   await p.getByRole('button',{name:'继续编辑',exact:true}).click();await p.screenshot({path:join(output,'mission-control-editor.png')})
   await p.keyboard.press('Escape');await p.getByRole('button',{name:'放弃输入并关闭',exact:true}).click()
   assert.equal(await p.locator('dialog[open]').count(),0);assert.equal(await p.evaluate(()=>document.activeElement.textContent),'＋ 新建任务')
 })
 await run('session bind, preview and double confirmation dispatch exactly once',async p=>{
   await p.evaluate(()=>fixture.clearActivity());await refresh(p);await task(p,'为会计案例')
   await p.getByRole('button',{name:'更换',exact:true}).click();await p.locator('.mc-session-option').filter({hasText:'任务指挥台改版'}).click()
   await p.getByRole('tab',{name:'执行与结果',exact:true}).click();await p.getByRole('button',{name:'预览并发送任务',exact:true}).click()
   const dialog=p.getByRole('dialog',{name:'确认这次发送',exact:true});await dialog.waitFor();assert.match(await dialog.innerText(),/SyntheticWork/)
   await dialog.getByRole('button',{name:'确认发送一次',exact:true}).evaluate(b=>{b.click();b.click()})
   await p.getByText('主助手正在处理',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>fixture.sendCalls.length),1)
   await p.getByRole('button',{name:'关闭指挥台',exact:true}).click();await p.evaluate(()=>fixture.open());await p.waitForTimeout(80)
   assert.equal(await p.evaluate(()=>fixture.sendCalls.length),1);assert.equal(await p.evaluate(()=>fixture.stopCalls.length),0)
   await p.getByRole('tab',{name:'执行与结果',exact:true}).click();await p.getByRole('button',{name:'停止主助手本轮',exact:true}).click()
   await p.getByRole('dialog',{name:'停止主助手本轮',exact:true}).waitFor();assert.match(await p.locator('dialog[open]').innerText(),/队友/)
 })
 await run('unconfirmed start is queryable and manual release never resends',async p=>{
   await task(p,'确认上一次请求');await p.getByRole('tab',{name:'执行与结果',exact:true}).click()
   await p.getByRole('button',{name:'查询运行状态',exact:true}).click();assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
   await p.screenshot({path:join(output,'mission-control-unconfirmed.png')})
   await p.getByRole('button',{name:'核对后解除占用',exact:true}).click();await p.locator('dialog[open] input[type=checkbox]').check()
   await p.locator('dialog[open]').getByRole('button',{name:'确认解除占用',exact:true}).click()
   assert.ok(await p.evaluate(()=>fixture.runs['task-2'].releasedAt));assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
 })
 await run('busy Team remains visible after Lead completes and prevents acceptance',async p=>{
   await task(p,'检查队友仍在');await p.getByRole('tab',{name:'执行与结果',exact:true}).click();await p.getByText('主助手结束不等于团队结束。',{exact:false}).waitFor()
   await p.getByRole('tab',{name:'验收记录',exact:false}).click();assert.equal(await p.getByRole('button',{name:'核对并验收',exact:true}).isDisabled(),true)
 })
 await run('completed round stays a task until explicit human acceptance then may reopen',async p=>{
   await p.evaluate(()=>fixture.clearActivity());await refresh(p);await task(p,'重做任务指挥台')
   assert.notEqual(await p.evaluate(()=>fixture.state.tasks['task-4'].phase),'done')
   await p.getByRole('tab',{name:'验收记录',exact:false}).click();await p.getByRole('button',{name:'核对并验收',exact:true}).click()
   await p.getByLabel('我核对过的结果',{exact:true}).fill('已核对真实文件，达到本次合成验收要求。')
   await p.locator('dialog[open] input[type=checkbox]').check();await p.getByRole('button',{name:'确认验收通过',exact:true}).click()
   assert.equal(await p.evaluate(()=>fixture.state.tasks['task-4'].phase),'done');assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
   await p.getByRole('button',{name:'重新打开任务',exact:true}).click();await p.locator('dialog[open] input[type=checkbox]').check();await p.getByRole('button',{name:'重新打开，不发送',exact:true}).click()
   assert.equal(await p.evaluate(()=>fixture.state.tasks['task-4'].phase),'draft')
 })
 for(const width of [960,700,390])await run(`narrow ${width}px long title, detail, keyboard and dialog remain reachable`,async p=>{
   await p.getByLabel('搜索任务',{exact:true}).fill('超长任务标题');await p.locator('.mc-task-row').click();await noOverflow(p)
   const tab=p.getByRole('tab',{name:'任务',exact:true});await tab.focus();await p.keyboard.press('ArrowRight');assert.equal(await p.getByRole('tab',{name:'执行与结果',exact:true}).getAttribute('aria-selected'),'true')
   await p.getByRole('button',{name:'编辑',exact:true}).click();await noOverflow(p);await p.locator('dialog[open]').getByRole('button',{name:'关闭编辑任务',exact:true}).click()
   await p.screenshot({path:join(output,`mission-control-${width}.png`)})
   if(width<=840){await p.getByRole('button',{name:'← 返回任务列表',exact:true}).click();assert.equal(await p.locator('.mc-task-row').first().isVisible(),true)}
 },{width,height:820})
 await run('narrow execution can open the occupying task without a hidden queue',async p=>{
   await p.getByLabel('搜索任务',{exact:true}).fill('超长任务标题');await p.locator('.mc-task-row').click()
   await p.getByRole('tab',{name:'执行与结果',exact:true}).click()
   await p.getByRole('button',{name:'查看当前占用的任务 →',exact:true}).click()
   assert.match(await p.locator('.mc-detail h1').innerText(),/确认上一次请求/);assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
 },{width:700,height:820})
 await run('connection error does not create empty persisted data and can be retried',async p=>{
   await p.getByText('任务服务暂不可用',{exact:true}).waitFor();const count=await p.evaluate(()=>Object.keys(fixture.state.tasks).length)
   await p.getByRole('button',{name:'重新连接',exact:true}).click();assert.equal(await p.evaluate(()=>Object.keys(fixture.state.tasks).length),count);assert.equal(await p.evaluate(()=>fixture.sendCalls.length),0)
   await p.screenshot({path:join(output,'mission-control-error.png')})
 },undefined,'scenario=error')
 await run('plugin disposal removes scoped style and never stops the official session',async p=>{
   await p.evaluate(()=>fixture.dispose());assert.equal(await p.locator('style[data-plugin="dsh-mission-control"]').count(),0);assert.equal(await p.evaluate(()=>fixture.stopCalls.length),0)
 })
}finally{
 await writeFile(join(output,'results.json'),JSON.stringify({runtime:`Chromium offline synthetic host, React ${previewReactVersion}; real built plugin client`,results},null,2))
 console.log(JSON.stringify({output,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2));await browser.close()
}
