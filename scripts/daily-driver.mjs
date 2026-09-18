/** Fixed-baseline package checks and an isolated installation-wide override smoke. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseVersion = '0.1.5-rc.2'
const forkVersion = `${baseVersion}-fork1`
const piVersion = '0.85.1-fork1'
const base = 'fb2c4b9e698e30edb738bca4cf0618587db7d203'
const packageNames = [
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
]
const piPackageName = '@earendil-works/pi-ai'

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 600_000, ...options })
}

async function manifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function verify() {
  assert.equal((await manifest(join(root, 'apps/cli/package.json'))).version, baseVersion)
  for (const path of [
    'packages/subagent/subagent/package.json',
    'packages/llm/llm-pi-ai/package.json',
    'packages/mcp/mcp-client/package.json',
  ]) {
    assert.equal((await manifest(join(root, path))).version, forkVersion)
  }
  const mcp = await manifest(join(root, 'packages/mcp/mcp-client/package.json'))
  assert.equal(mcp.dependencies['@modelcontextprotocol/client'], '^2.0.0')
  assert.equal(mcp.dependencies['@modelcontextprotocol/core'], '^2.0.0')
  const llm = await manifest(join(root, 'packages/llm/llm-pi-ai/package.json'))
  assert.equal(llm.dependencies[piPackageName], piVersion)
  run('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
  const paths = run('git', ['diff', '--name-only', base], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean)
  const allowed = [
    'packages/subagent/subagent/',
    'packages/llm/llm-pi-ai/',
    'packages/mcp/mcp-client/',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'THIRD_PARTY_NOTICES.md',
    '.agents/notes/implemented/process/2026-09-12-pinned-daily-driver',
    'docs/cookbook/installing-and-maintaining-daily-driver',
    'docs/config-catalog.md',
    '.github/workflows/daily-driver-release.yml',
    'scripts/daily-driver.mjs',
  ]
  for (const path of paths) assert(allowed.some(prefix => path.startsWith(prefix)), `Unexpected fork change: ${path}`)
  console.log(`daily-driver: fixed ${baseVersion} baseline with ${forkVersion} overrides; ${paths.length} allowed changed paths`)
}

async function smoke(subagentTarball, llmTarball, mcpTarball, piTarball) {
  const tarballs = [subagentTarball, llmTarball, mcpTarball, piTarball]
  assert(tarballs.every(Boolean), 'Pass subagent, llm-pi-ai, mcp-client, and pi-ai tarballs')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-daily-driver-'))
  const runtime = join(temporary, 'runtime')
  const overrides = Object.fromEntries([...packageNames, piPackageName].map((name, index) => [name, `file:${resolve(tarballs[index])}`]))
  try {
    await mkdir(runtime)
    await writeFile(join(runtime, 'package.json'), JSON.stringify({
      name: 'dsh-daily-driver-runtime',
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.7.0',
      dependencies: { '@deepseek-ai/dsh': baseVersion, ...overrides },
    }, null, 2) + '\n')
    const overrideLines = Object.entries(overrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), `packages:\n  - .\noverrides:\n${overrideLines.join('\n')}\n`)
    run('corepack', ['pnpm@11.7.0', 'install', '--ignore-scripts'], { cwd: runtime })
    const runtimeRequire = createRequire(join(runtime, 'package.json'))
    const dshManifestPath = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
    const dshRequire = createRequire(dshManifestPath)
    const baseRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-base/package.json'))
    const subagentEntry = baseRequire.resolve(packageNames[0])
    const llmEntry = baseRequire.resolve(packageNames[1])
    const mcpEntry = dshRequire.resolve(packageNames[2])
    for (const entry of [subagentEntry, llmEntry, mcpEntry]) {
      assert.equal((await manifest(resolve(dirname(entry), '../package.json'))).version, forkVersion)
    }
    await import(pathToFileURL(subagentEntry).href)
    await import(pathToFileURL(llmEntry).href)
    const mcp = await import(pathToFileURL(mcpEntry).href)
    assert.equal(mcp.name, 'mcp-client')
    assert((await readFile(subagentEntry, 'utf8')).includes('settlement will automatically notify the parent'))
    assert((await readFile(llmEntry, 'utf8')).includes('toolCallParsing: "final"'))
    const resolverPath = join(dirname(llmEntry), 'smoke-resolve.mjs')
    await writeFile(resolverPath, 'export const resolveModule = name => import.meta.resolve(name)\n')
    const { resolveModule } = await import(pathToFileURL(resolverPath).href)
    const piEntry = fileURLToPath(resolveModule(piPackageName))
    const piManifestPath = resolve(dirname(piEntry), '../package.json')
    assert.equal((await manifest(piManifestPath)).version, piVersion)
    const piResponses = resolve(dirname(piManifestPath), 'dist/api/openai-responses.js')
    assert((await readFile(piResponses, 'utf8')).includes('params.instructions'))
    const entries = await readdir(join(runtime, 'node_modules/.pnpm'))
    for (const name of ['dsh-subagent', 'dsh-llm-pi-ai', 'dsh-mcp-client']) {
      assert(entries.some(entry => entry.includes(name) && entry.includes('file+')), `Missing tarball resolution for ${name}`)
    }
    await writeFile(join(dirname(resolve(subagentTarball)), 'runtime-package.json'), await readFile(join(runtime, 'package.json')))
    await writeFile(join(dirname(resolve(subagentTarball)), 'runtime-pnpm-workspace.yaml'), await readFile(join(runtime, 'pnpm-workspace.yaml')))
    await writeFile(join(dirname(resolve(subagentTarball)), 'runtime-pnpm-lock.yaml'), await readFile(join(runtime, 'pnpm-lock.yaml')))
    console.log(`daily-driver: isolated ${baseVersion} installation resolved all four fork overrides`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[2] === 'verify') await verify()
else if (process.argv[2] === 'smoke') await smoke(...process.argv.slice(3, 7))
else throw new Error('Usage: node scripts/daily-driver.mjs verify | smoke <subagent.tgz> <llm.tgz> <mcp.tgz> <pi.tgz>')
