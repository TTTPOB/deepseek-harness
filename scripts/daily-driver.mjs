/** Focused source verification and immutable tarball publication from the current checkout. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { manifest, plan, root } from './daily-driver-plan.mjs'

const [command, selection, ...directories] = process.argv.slice(2)
assert(['prepare', 'verify', 'build', 'smoke', 'release'].includes(command) && selection,
  'Usage: node scripts/daily-driver.mjs prepare|verify|build|smoke|release <selection> [workspace-directory...]')
const checks = plan(selection, directories)
const run = (bin, args, options = {}) => execFileSync(bin, args, { cwd: root, stdio: 'inherit', timeout: 900_000, ...options })
const node = args => run(process.execPath, args)
const pnpm = args => run('pnpm', ['--config.verify-deps-before-run=false', ...args])
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const source = action => node(['scripts/daily-driver-source.mjs', action, ...checks.packages.map(pkg => pkg.directory)])
function prepare() { source('install') }
function verify() {
  node(['--test', 'scripts/daily-driver-source.test.mjs', 'scripts/daily-driver.test.mjs'])
  pnpm(['run', 'build:native-system'])
  pnpm(['exec', 'vitest', 'run', '--maxWorkers=2', ...checks.tests])
}
function build() {
  // Client programs consume generated Host Remote declarations.
  if (selection === 'access') {
    pnpm(['exec', 'tsc', '-b', 'packages/typert/generator/tsconfig.json', 'packages/host/frontend-static/tsconfig.json'])
    for (const directory of ['vendor/cosmokit', 'packages/host/frontend-static']) {
      pnpm(['exec', 'tsdown', '--workspace', directory, '-F', manifest(directory).name, '--env.DSH_BUILD_FACE', 'host'])
    }
  }
  source('build')
}
function smoke() {
  for (const pkg of checks.packages) {
    const metadata = JSON.parse(execFileSync('tar', ['-xOf', checks.artifact(pkg), 'package/package.json'], { encoding: 'utf8' }))
    assert.equal(metadata.name, pkg.name)
    assert.equal(metadata.version, pkg.version)
  }
  node([join('scripts', checks.smoke), ...checks.packages.map(checks.artifact)])
}
function releaseIdentity() {
  const tag = process.env.RELEASE_TAG
  assert(tag?.startsWith('daily-driver-'), 'Set RELEASE_TAG to an existing daily-driver-* tag at HEAD')
  assert.equal(git(['rev-parse', `refs/tags/${tag}^{commit}`]), git(['rev-parse', 'HEAD']), 'Release tag must select this checkout')
  const remote = execFileSync('gh', ['api', `repos/${process.env.GH_REPO}/git/ref/tags/${tag}`, '--jq', '.object.sha'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(remote, git(['rev-parse', `refs/tags/${tag}`]), 'Remote tag differs from local tag')
  const existing = spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' })
  assert.equal(existing.error, undefined)
  assert.notEqual(existing.status, 0, `Release ${tag} exists; never overwrite immutable releases`)
  return tag
}
if (command === 'release') {
  assert(process.env.GH_REPO, 'Set GH_REPO to the release repository')
  const tag = releaseIdentity()
  prepare()
  verify()
  build()
  smoke()
  const assets = checks.selected.map(checks.artifact)
  const sums = join(root, 'dist/daily-driver/SHA256SUMS')
  writeFileSync(sums, assets.map(path => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${basename(path)}\n`).join(''))
  run('gh', ['release', 'create', tag, ...assets, sums, '--verify-tag', '--title', tag, '--latest=false',
    '--notes', `Verified ${selection} source and isolated built artifacts at ${git(['rev-parse', 'HEAD'])}. Packages: ${checks.selected.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}. Installation and Host activation require separate authorization.`])
} else {
  ({ prepare, verify, build, smoke })[command]()
}
