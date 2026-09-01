import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const buildDir = process.env.DSH_MC_CLIENT_BUILD_DIR ? resolvePath(process.env.DSH_MC_CLIENT_BUILD_DIR) : join(root, '.client-build')
const outputDir = process.env.DSH_MC_LIB_DIR ? resolvePath(process.env.DSH_MC_LIB_DIR) : join(root, 'lib')
const sources = new Map()
async function collect(dir, rel = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name); const key = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) await collect(abs, key)
    else if (entry.name.endsWith('.js')) sources.set(key, (await readFile(abs, 'utf8')).replace(/\n?\/\/# sourceMappingURL=.*$/u, ''))
  }
}
await collect(buildDir)
const requireRe = /require\("(\.[^"]+\.js)"\)/g
const resolve = (parent, child) => posix.normalize(posix.join(posix.dirname(parent), child))
const visited = new Set(); const order = []
function visit(file) {
  if (visited.has(file)) return
  visited.add(file); const source = sources.get(file); if (!source) throw new Error(`missing client module: ${file}`)
  for (const match of source.matchAll(requireRe)) visit(resolve(file, match[1]))
  order.push(file)
}
visit('client.js')
const modules = order.map((file) => {
  const source = sources.get(file).replace(requireRe, (_match, child) => `require("./${resolve(file, child)}")`)
  return `__modules[${JSON.stringify(file)}]=function(require,module,exports){\n${source}\n};`
}).join('\n')
const output = `window.__ModuleLoader__.load({id:"dsh-mission-control",factory:(require)=>{var __modules={};${modules}\nvar __cache={};function __localRequire(id){if(id[0]!==".")return require(id);id=id.slice(2);if(__cache[id])return __cache[id].exports;var module={exports:{}};__cache[id]=module;__modules[id](__localRequire,module,module.exports);return module.exports}var module={exports:{}};__modules["client.js"](__localRequire,module,module.exports);return module.exports}});\n`
await mkdir(outputDir, { recursive: true })
await writeFile(join(outputDir, 'client.js'), output)
await rm(buildDir, { recursive: true, force: true })
