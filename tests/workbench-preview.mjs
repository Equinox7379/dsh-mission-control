import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
export const previewReactVersion = require('react/package.json').version
if (previewReactVersion !== '18.3.1' || require('react-dom/package.json').version !== previewReactVersion) {
  throw new Error('Workbench preview requires matching React and React DOM 18.3.1')
}

/** Synthetic host only; the screen is the actual built lib/client.js plugin. */
export async function previewHtml(scenario = '') {
  const modules={}
  for(const [id,location]of [['domain.js','../src/domain.ts'],['workflow.js','../src/workflow.ts'],['fixture.js','./fixtures/workbench.tsx']]) {
    const result=ts.transpileModule(await readFile(new URL(location,import.meta.url),'utf8'),{fileName:location,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true},reportDiagnostics:true})
    const errors=(result.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error)
    if(errors.length)throw new Error(errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('\n'))
    modules[id]=result.outputText
  }
  const factory=Object.entries(modules).map(([id,code])=>`M[${JSON.stringify(id)}]=function(require,module,exports){${code}\n};`).join('\n')
  const fixture=`(()=>{const M={},C={};${factory}\nfunction require(id){if(id==='react')return window.React;id=id.replace(/^\.\\//,'');if(C[id])return C[id].exports;const m=C[id]={exports:{}};M[id](require,m,m.exports);return m.exports}require('./fixture.js')})();`
  const react = (await Promise.all(['react', 'react-dom'].map(name => readFile(
    join(dirname(require.resolve(`${name}/package.json`)), 'umd', `${name}.production.min.js`), 'utf8',
  )))).join('\n')
  const production=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  const safe=s=>s.replace(/<\/script/gi,'<\\/script')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mission Control · 隔离交互预览</title><style>html,body{margin:0;background:#0b0f12;color:#ddd;font-family:system-ui}#host-sentinel{position:fixed;bottom:0;font-size:10px;padding:2px;color:#66737c}#host-button{margin:40px;background:rgb(20,30,40);color:rgb(220,230,240);border:1px solid #66737c;padding:8px}</style><button id="host-button">宿主页面按钮</button><div id="host-sentinel">合成数据 · 无真实模型 · React ${previewReactVersion} 模拟宿主，非生产认证</div><div id="app"></div><script>${safe(react)}</script><script>window.__fixtureSearch=${JSON.stringify(scenario)};if(!crypto.randomUUID)crypto.randomUUID=()=>"10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(+c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>+c/4).toString(16));window.__ModuleLoader__={load(module){window.__mcProduction=module}};</script><script>${safe(production)}</script><script>${safe(fixture)}</script></html>`
}
