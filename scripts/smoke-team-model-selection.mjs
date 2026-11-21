/** Verify team-model-selection tarballs in an isolated official CLI installation. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
import { stageArtifactOverrides } from './daily-driver-artifacts.mjs'

const USAGE = 'Usage: node scripts/smoke-team-model-selection.mjs <subagent.tgz> <tool-subagent.tgz> <tool-subagent-control.tgz> <client-ui-settings-subagent.tgz> <tool-cordis.tgz>'
const expected = plan('team-model-selection').packages
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, expected.length, USAGE)
for (const path of tarballs) assert(existsSync(path), `${USAGE} (missing ${path})`)
for (const [index, pkg] of expected.entries()) {
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', tarballs[index], 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(metadata.name, pkg.name)
  assert.equal(metadata.version, pkg.version)
}

const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
const runtime = await mkdtemp(join(tmpdir(), 'dsh-team-model-selection-'))
const run = (args, cwd = runtime) => execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), ...args], { cwd, stdio: 'inherit', timeout: 600_000 })

try {
  await stageArtifactOverrides(runtime, expected, tarballs)
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'team-model-selection-smoke', private: true, type: 'module', packageManager,
    dependencies: {
      '@deepseek-ai/dsh': officialVersion,
      '@deepseek-ai/dsh-app-boot': officialVersion,
      '@deepseek-ai/dsh-llm': officialVersion,
      '@deepseek-ai/dsh-session': officialVersion,
      '@deepseek-ai/dsh-scope': officialVersion,
      ...Object.fromEntries(expected.map((pkg, index) => [pkg.name, 'file:./' + basename(tarballs[index])])),
    },
  }))
  run(['install', '--ignore-scripts', '--config.enable-global-virtual-store=false'])
  const project = createRequire(join(runtime, 'package.json'))
  const load = async name => import(pathToFileURL(project.resolve(name)).href)

  // The official Host and the overridden tarballs share one pnpm peer graph.
  for (const pkg of expected) {
    const manifest = await realpath(project.resolve(`${pkg.name}/package.json`))
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(metadata.name, pkg.name)
    assert.equal(metadata.version, pkg.version)
    assert.match(manifest, /file\+/, `${pkg.name} must resolve from its staged tarball`)
    const api = await load(pkg.name)
    assert(typeof api.default === 'function' || typeof api.apply === 'function', `${pkg.name} has no Loadable entry`)
    if (metadata.dsh?.client) {
      const entry = metadata.exports['./client']
      const client = typeof entry === 'string' ? entry : entry.browser ?? entry.default
      let registered
      runInNewContext(await readFile(join(dirname(manifest), client), 'utf8'), {
        window: { __ModuleLoader__: { load(value) { registered = value } } },
      })
      assert.equal(registered.id, pkg.name)
      assert.equal(typeof registered.factory, 'function', 'the packed browser entry registers a loadable module')
    }
  }
  console.log('Subagent artifacts resolve from the staged tarballs and the client module registers.')
} finally {
  await rm(runtime, { recursive: true, force: true })
}
