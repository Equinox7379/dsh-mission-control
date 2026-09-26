import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const libDir = requiredAbsolutePath('DSH_MC_LIB_DIR')
const stageDir = requiredAbsolutePath('DSH_MC_PACK_STAGE')
const destinationDir = requiredAbsolutePath('DSH_MC_PACK_DEST')
function requiredAbsolutePath(name) {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return resolve(value)
}
await mkdir(dirname(stageDir), { recursive: true })
await mkdir(stageDir) // Existing directories are never reused or cleared.
await mkdir(destinationDir, { recursive: true })
await cp(libDir, join(stageDir, 'lib'), { recursive: true, dereference: true })
// Protocol schemas/fixtures stay in the source repository. Runtime contracts
// are compiled into lib; development corpus is not an installation dependency.
for (const file of ['cordis.patch.yml', 'README.md', 'LICENSE']) await cp(join(root, file), join(stageDir, file))
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
delete packageJson.devDependencies
await writeFile(join(stageDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('run this script through npm so npm_execpath is available')
const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [npmCli, 'pack', '--pack-destination', destinationDir], { cwd: stageDir, env: process.env, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code, signal) => { if (signal) reject(new Error(`npm pack terminated by ${signal}`)); else resolveExit(code ?? 1) })
})
if (exitCode !== 0) process.exitCode = exitCode
