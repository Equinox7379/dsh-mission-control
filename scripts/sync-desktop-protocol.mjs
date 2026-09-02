import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = resolve(process.env.DSH_DESKTOP_SOURCE_ROOT ?? join(pluginRoot, '..', '..', 'dsh-gui'))
const manifestPath = join(desktopRoot, 'protocol', 'corpus', 'manifest.json')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const contained = (root, path) => {
  const value = relative(root, path)
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

const git = (args) => {
  const result = spawnSync('git', ['-C', desktopRoot, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

if (git(['status', '--short', '--', 'protocol', 'tools/protocol'])) throw new Error('Desktop protocol source is dirty')
const desktopCommit = git(['rev-parse', 'HEAD'])
const manifestBytes = await readFile(manifestPath)
const fingerprint = digest(manifestBytes)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const selected = manifest.entries.filter((entry) => entry.kind === 'schema' || entry.kind === 'rpc-valid' || entry.kind === 'rpc-invalid')
if (selected.filter((entry) => entry.kind === 'schema' && entry.path.startsWith('rpc-')).length !== 9) throw new Error('expected nine RPC schemas')
if (!selected.some((entry) => entry.kind === 'rpc-valid') || !selected.some((entry) => entry.kind === 'rpc-invalid')) throw new Error('RPC corpus is incomplete')

const files = []
for (const entry of selected) {
  const source = resolve(desktopRoot, 'protocol', entry.path)
  if (!contained(join(desktopRoot, 'protocol'), source)) throw new Error(`unsafe protocol path: ${entry.path}`)
  const bytes = await readFile(source)
  if (digest(bytes) !== entry.sha256) throw new Error(`protocol source differs from manifest: ${entry.path}`)
  files.push({ path: entry.path, sha256: entry.sha256, bytes })
}

const vendorRoot = join(pluginRoot, 'protocol-vendor', fingerprint)
const markerPath = join(vendorRoot, 'source.json')
const marker = {
  protocol: manifest.protocol,
  fingerprint,
  desktopCommit,
  files: files.map(({ path, sha256 }) => ({ path, sha256 })),
}

const markerExists = await stat(markerPath).then((value) => value.isFile(), () => false)
const rootExists = await stat(vendorRoot).then((value) => value.isDirectory(), () => false)
if (rootExists && !markerExists) throw new Error(`refusing dirty partial protocol copy: ${vendorRoot}`)
if (markerExists) {
  const existing = JSON.parse(await readFile(markerPath, 'utf8'))
  if (JSON.stringify(existing) !== JSON.stringify(marker)) throw new Error('existing protocol vendor metadata differs')
  for (const file of files) if (digest(await readFile(join(vendorRoot, file.path))) !== file.sha256) throw new Error(`vendored protocol drift: ${file.path}`)
  process.stdout.write(`${fingerprint}\n`)
  process.exit(0)
}

await mkdir(vendorRoot, { recursive: true })
for (const file of files) {
  const destination = join(vendorRoot, file.path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, file.bytes, { flag: 'wx' })
}
await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
process.stdout.write(`${fingerprint}\n`)
