/** Fixed-baseline checks and an isolated project dependency-closure smoke. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseVersion = '0.1.7-rc.2'
const forkVersion = `${baseVersion}-fork1`
const piVersion = '0.85.1-fork1'
const base = '477b4f420553e8a52c2fbccc464d7561b239c443'
const forks = [
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-web-app',
]
const plugins = [
  'dsh-progressive-tools',
  'dsh-workspace-overlay',
  'dsh-workspace-envrc',
  '@firecrawl/dsh-firecrawl',
]
const names = [...forks, '@earendil-works/pi-ai', ...plugins]
const pluginVersions = ['0.3.0', '0.2.0', '0.2.0', '0.1.0-fork1']

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 600_000, ...options })
}

async function manifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function packageManifestPath(anchor, name) {
  for (const directory of anchor.resolve.paths(name)) {
    const path = join(directory, name, 'package.json')
    if (existsSync(path)) return path
  }
  throw new Error(`Cannot locate installed ${name} manifest from its dependency anchor`)
}

async function verify() {
  assert.equal((await manifest(join(root, 'apps/cli/package.json'))).version, baseVersion)
  for (const name of forks) {
    const packagePath = name === '@deepseek-ai/dsh-web-app' ? 'bundle/web-app'
      : name === '@deepseek-ai/dsh-agent-preset-registry' ? 'preset/agent-preset-registry'
      : name === '@deepseek-ai/dsh-agent' ? 'core/agent'
      : name === '@deepseek-ai/dsh-llm-pi-ai' ? 'llm/llm-pi-ai'
      : name === '@deepseek-ai/dsh-mcp-client' ? 'mcp/mcp-client' : 'subagent/subagent'
    assert.equal((await manifest(join(root, 'packages', packagePath, 'package.json'))).version, forkVersion, name)
  }
  const web = await manifest(join(root, 'packages/bundle/web-app/package.json'))
  const llm = await manifest(join(root, 'packages/llm/llm-pi-ai/package.json'))
  assert.equal(llm.dependencies['@earendil-works/pi-ai'], piVersion)
  for (const [index, name] of plugins.entries()) {
    assert.equal(web.dependencies[name], index === 3 ? '0.1.0' : pluginVersions[index], name)
  }
  assert.equal(web.dependencies['dsh-mcp-panel'], '0.6.19')
  assert(web.dsh.bundle.patch.includes('./personal-web.patch.yml'))
  assert(web.dsh.bundle.patch.includes('./presets/standard-ptc.patch.yml'))
  run('git', ['merge-base', '--is-ancestor', base, 'HEAD'])
  const paths = run('git', ['diff', '--name-only', base], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean)
  const allowed = [
    'packages/subagent/subagent/', 'packages/llm/llm-pi-ai/', 'packages/mcp/mcp-client/',
    'packages/core/agent/', 'packages/preset/agent-preset-registry/', 'packages/bundle/web-app/',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'THIRD_PARTY_NOTICES.md',
    '.agents/notes/implemented/', 'docs/cookbook/installing-and-maintaining-daily-driver',
    'docs/config-catalog', '.github/workflows/daily-driver-release.yml', 'scripts/daily-driver.mjs',
  ]
  for (const path of paths) assert(allowed.some(prefix => path.startsWith(prefix)), `Unexpected fork change: ${path}`)
  console.log(`daily-driver: fixed ${baseVersion} baseline, ${paths.length} allowed changed paths`)
}

async function smoke(tarballs) {
  assert.equal(tarballs.length, names.length, `Pass ${names.length} tarballs in names order`)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-daily-driver-'))
  const runtime = join(temporary, 'runtime')
  const overrides = Object.fromEntries(names.map((name, index) => [name, `file:./${basename(tarballs[index])}`]))
  try {
    await mkdir(runtime)
    for (const tarball of tarballs) await copyFile(resolve(tarball), join(runtime, basename(tarball)))
    await writeFile(join(runtime, 'package.json'), JSON.stringify({
      name: 'dsh-daily-driver-runtime', private: true, type: 'module', packageManager: 'pnpm@11.24.0',
      dependencies: { '@deepseek-ai/dsh': baseVersion },
    }, null, 2) + '\n')
    const overrideLines = Object.entries(overrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), `packages:\n  - .\nblockExoticSubdeps: false\noverrides:\n${overrideLines.join('\n')}\n`)
    assert.equal(run('pnpm', ['--version'], { cwd: runtime, encoding: 'utf8', stdio: 'pipe' }).trim(), '11.24.0')
    run('pnpm', ['install', '--ignore-scripts'], { cwd: runtime })
    const runtimeRequire = createRequire(join(runtime, 'package.json'))
    const cliPath = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
    assert.equal((await manifest(cliPath)).version, baseVersion)
    const cliRequire = createRequire(cliPath)
    const webPath = cliRequire.resolve('@deepseek-ai/dsh-web-app/package.json')
    const webRequire = createRequire(webPath)
    const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
    const { evaluatePluginCompatibility } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
    assert.equal((await manifest(webPath)).version, forkVersion)
    for (const [index, name] of names.entries()) {
      const anchor = name === '@earendil-works/pi-ai' ? createRequire(baseRequire.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
        : plugins.includes(name) || name === '@deepseek-ai/dsh-agent-preset-registry' ? webRequire
        : name === '@deepseek-ai/dsh-subagent' || name === '@deepseek-ai/dsh-llm-pi-ai' || name === '@deepseek-ai/dsh-agent' ? baseRequire : cliRequire
      const path = packageManifestPath(anchor, name)
      const packageMeta = await manifest(path)
      assert.equal(packageMeta.version, index < forks.length ? forkVersion : index === forks.length ? piVersion : pluginVersions[index - forks.length - 1], name)
      if (name !== '@earendil-works/pi-ai') {
        assert.equal(evaluatePluginCompatibility(packageMeta, {}, baseVersion), undefined, `Incompatible dsh peers: ${name}`)
      }
      if (plugins.includes(name)) {
        const entries = name === 'dsh-workspace-overlay' ? [name, `${name}/mcp/manager`, `${name}/integration-plugin`]
          : name === 'dsh-workspace-envrc' ? [name, `${name}/integration-plugin`]
          : name === '@firecrawl/dsh-firecrawl' ? [`${name}/fetch`] : [name]
        for (const specifier of entries) await import(pathToFileURL(anchor.resolve(specifier)).href)
      }
    }
    const panelMeta = await manifest(packageManifestPath(webRequire, 'dsh-mcp-panel'))
    assert.equal(panelMeta.version, '0.6.19')
    assert.equal(evaluatePluginCompatibility(panelMeta, {}, baseVersion), undefined, 'Incompatible dsh peers: dsh-mcp-panel')
    await import(pathToFileURL(webRequire.resolve('dsh-mcp-panel')).href)
    const patch = await readFile(join(dirname(webPath), 'personal-web.patch.yml'), 'utf8')
    for (const id of ['progressive-tools', 'workspace-registry', 'workspace-envrc', 'web-fetch-firecrawl', 'mcp-panel']) {
      assert(patch.includes(`id: ${id}`), id)
    }
    const entries = await readdir(join(runtime, 'node_modules/.pnpm'))
    for (const name of forks) assert(entries.some(entry => entry.includes(name.split('/').at(-1)) && entry.includes('file+')), name)
    await writeFile(join(dirname(resolve(tarballs[0])), 'runtime-package.json'), await readFile(join(runtime, 'package.json')))
    await writeFile(join(dirname(resolve(tarballs[0])), 'runtime-pnpm-workspace.yaml'), await readFile(join(runtime, 'pnpm-workspace.yaml')))
    await writeFile(join(dirname(resolve(tarballs[0])), 'runtime-pnpm-lock.yaml'), await readFile(join(runtime, 'pnpm-lock.yaml')))
    console.log(`daily-driver: project install of official ${baseVersion} CLI resolves Web plugin dependencies; global profile and Loader remain untested`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[2] === 'verify') await verify()
else if (process.argv[2] === 'smoke') await smoke(process.argv.slice(3))
else throw new Error(`Usage: node scripts/daily-driver.mjs verify | smoke ${names.join(' ')}`)
