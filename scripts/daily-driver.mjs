/** Fixed-baseline release checks and an isolated official-install smoke. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.1.5-rc.1'
const base = '183f08e9c6dde7e36cd2318eaee70b0da08fb35e'
const packageName = '@deepseek-ai/dsh-llm-pi-ai'
const piUrl = 'https://github.com/TTTPOB/pi/releases/download/pi-ai-v0.85.1-dsh.1/earendil-works-pi-ai-0.85.1-dsh.1.tgz'

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 600_000, ...options })
}

async function manifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function verify() {
  assert.equal((await manifest(join(root, 'apps/cli/package.json'))).version, version)
  assert.equal((await manifest(join(root, 'packages/llm/llm-pi-ai/package.json'))).dependencies['@earendil-works/pi-ai'], piUrl)
  run('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
  const paths = [
    ...run('git', ['diff', '--name-only', base], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n'),
    ...run('git', ['ls-files', '--others', '--exclude-standard', '--exclude=website/.vitepress/.temp/**'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n'),
  ].filter(Boolean)
  const allowed = [
    'packages/llm/llm-pi-ai/', 'pnpm-lock.yaml', 'docs/config-catalog.', 'docs/module-graph.',
    'docs/cookbook/installing-and-maintaining-daily-driver.',
    '.agents/notes/implemented/process/2026-09-12-pinned-daily-driver.',
    '.github/workflows/daily-driver-release.yml', 'scripts/daily-driver.mjs',
  ]
  for (const path of paths) assert(allowed.some(prefix => path.startsWith(prefix)), `Unexpected fork change: ${path}`)
  console.log(`daily-driver: fixed ${version}; ${paths.length} allowed changed paths`)
}

async function smoke(tarball) {
  assert(tarball, 'Pass the packed adapter tarball')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-daily-driver-'))
  const home = join(temporary, 'home')
  const runtime = join(temporary, 'runtime')
  const shim = join(temporary, 'bin')
  const previousHome = process.env.DSH_HOME
  const originalFetch = globalThis.fetch
  let ctx
  try {
    await Promise.all([mkdir(runtime), mkdir(shim)])
    // Pin transitive DSH packages too: the official CLI uses caret ranges.
    const overrides = { '@deepseek-ai/dsh': version }
    for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        let pkg
        try { pkg = await manifest(join(root, 'packages', group.name, entry.name, 'package.json')) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if (pkg.name?.startsWith('@deepseek-ai/dsh-')) overrides[pkg.name] = version
      }
    }
    for (const entry of await readdir(join(root, 'apps'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkg = await manifest(join(root, 'apps', entry.name, 'package.json'))
      if (pkg.name?.startsWith('@deepseek-ai/dsh')) overrides[pkg.name] = version
    }
    await writeFile(join(runtime, 'package.json'), JSON.stringify({
      name: 'dsh-daily-driver-runtime', private: true, type: 'module', packageManager: 'pnpm@10.13.1',
      scripts: { web: 'dsh web' },
      dependencies: { '@deepseek-ai/dsh': version }, pnpm: { overrides },
    }, null, 2) + '\n')
    await writeFile(join(shim, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@10.13.1 "$@"\n', { mode: 0o755 })
    const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', PATH: `${shim}:${process.env.PATH}` }
    run('corepack', ['pnpm@10.13.1', 'install', '--ignore-scripts'], { cwd: runtime, env })
    for (const entry of await readdir(join(runtime, 'node_modules/.pnpm'))) {
      if (!entry.startsWith('@deepseek-ai+dsh')) continue
      assert(entry.split('@')[2].split('_')[0] === version, `Runtime version drift: ${entry}`)
    }
    const runtimeRequire = createRequire(join(runtime, 'package.json'))
    const cliManifestPath = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
    const cliManifest = await manifest(cliManifestPath)
    assert.equal(cliManifest.version, version)
    const cli = resolve(dirname(cliManifestPath), cliManifest.bin.dsh)
    const launch = args => run(process.execPath, [cli, ...args], { cwd: runtime, env })
    launch(['plugin', '--profile', 'web', 'add', resolve(tarball)])
    launch(['web', '--help'])
    const config = run(process.execPath, [cli, '--profile', 'web', '--dump-config'], {
      cwd: runtime, env, encoding: 'utf8', stdio: 'pipe',
    })
    assert(config.includes(packageName))
    const profile = join(home, 'profiles/web')
    const profileManifest = await manifest(join(profile, 'package.json'))
    assert(!profileManifest.dependencies['@deepseek-ai/dsh-session'])
    assert(!profileManifest.dependencies['@deepseek-ai/dsh-token-meter'])
    const profileRequire = createRequire(join(profile, 'cordis.yml'))
    const adapterEntry = profileRequire.resolve(packageName)
    assert(adapterEntry.startsWith(join(profile, 'node_modules')))
    for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-token-meter']) {
      assert.equal((await manifest(profileRequire.resolve(`${name}/package.json`))).version, version)
    }
    // Pi exposes import-only conditions, so CommonJS require.resolve cannot resolve it.
    const resolverPath = join(profile, 'smoke-resolve.mjs')
    await writeFile(resolverPath, 'export const resolveModule = name => import.meta.resolve(name)\n')
    const { resolveModule } = await import(pathToFileURL(resolverPath).href)
    const piEntry = fileURLToPath(resolveModule('@earendil-works/pi-ai'))
    const piManifest = await manifest(resolve(dirname(piEntry), '../package.json'))
    assert.equal(piManifest.version, '0.85.1-dsh.1')
    assert((await readFile(adapterEntry, 'utf8')).includes('toolCallParsing: "final"'))

    process.env.DSH_HOME = home
    const { Context } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis')).href)
    const { default: LlmRuntime } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-llm')).href)
    const adapter = await import(pathToFileURL(adapterEntry).href)
    const { getBuiltinModels } = await import(resolveModule('@earendil-works/pi-ai/providers/all'))
    const builtin = getBuiltinModels('deepseek')[0]
    assert(builtin)
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://pi.dev/api/models/providers/deepseek') {
        return new Response(JSON.stringify({ [builtin.id]: { ...builtin, name: 'Daily-driver smoke model' } }))
      }
      return originalFetch(input, init)
    }
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(adapter, { providers: { deepseek: { models: [{ id: builtin.id }] } } })
    await ctx.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' })
    assert.equal((await ctx.llm.listModels('deepseek'))[0].name, 'Daily-driver smoke model')
    // These files reproduce the tested official runtime outside a source checkout.
    await writeFile(join(dirname(resolve(tarball)), 'runtime-package.json'), await readFile(join(runtime, 'package.json')))
    await writeFile(join(dirname(resolve(tarball)), 'runtime-pnpm-lock.yaml'), await readFile(join(runtime, 'pnpm-lock.yaml')))
    console.log(`daily-driver: official ${version} Host + one adapter override passed`)
  } finally {
    await ctx?.fiber.dispose()
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[2] === 'verify') await verify()
else if (process.argv[2] === 'smoke') await smoke(process.argv[3])
else throw new Error('Usage: node scripts/daily-driver.mjs verify | smoke <adapter.tgz>')
