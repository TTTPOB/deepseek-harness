/** Check manifest-derived selection and fail-before-publication behavior without releasing. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { manifest, packageManager, plan, root, selections } from './daily-driver-plan.mjs'

test('artifact names follow individual manifests and a subset does not shrink the smoke closure', () => {
  const checks = plan('session-query', ['packages/session-query/session-query-sqlite'])
  assert.equal(checks.selected.length, 1)
  assert.equal(checks.packages.length, 4)
  for (const pkg of checks.packages) {
    assert.equal(pkg.version, manifest(pkg.directory).version)
    assert(checks.artifact(pkg).endsWith(`${pkg.version}.tgz`))
  }
  const release = plan('session-query', ['packages/core/session', 'packages/session-query/session-query', 'packages/session-query/session-query-sqlite'])
  assert.deepEqual(new Set(release.selected.map(pkg => pkg.directory)), new Set([
    'packages/core/session', 'packages/session-query/session-query', 'packages/session-query/session-query-sqlite',
  ]))
  assert(release.tests.includes('packages/core/session/tests'))
  assert.throws(() => plan('core', ['packages/client/connection']))
  assert.throws(() => plan('retired-batch'))
})

test('capability groups track rc.1 owners and toolchain', async () => {
  assert.equal(packageManager, 'pnpm@11.28.5')
  assert.deepEqual(Object.keys(selections), ['session-query', 'core', 'access'])
  assert.deepEqual(plan('core').packages.map(pkg => pkg.directory), [
    'packages/core/agent', 'packages/preset/agent-preset-registry', 'packages/subagent/subagent',
    'packages/llm/llm-pi-ai', 'packages/mcp/mcp-client',
  ])
  assert(plan('core').tests.includes('packages/subagent/subagent/tests'))
  assert.deepEqual(plan('access').packages.map(pkg => pkg.directory), [
    'packages/client/connection', 'packages/host/frontend-static', 'packages/api/gateway',
    'packages/client/ui-plugin-manager', 'packages/client/ui-sidebar-terminal',
  ])
  assert.throws(() => plan('access', ['packages/client/ui-settings']))
  assert.throws(() => plan('core', ['packages/core/agent', 'packages/core/agent']))
  const workflow = await readFile(join(root, '.github/workflows/daily-driver-release.yml'), 'utf8')
  assert(workflow.includes('options: [session-query, core, access]'))
  const core = await readFile(join(root, 'scripts/smoke-core-packages.mjs'), 'utf8')
  assert(!core.includes('workspace.overrides'))
  assert(core.includes('await checkSubagentManager('))
  const subagent = await readFile(join(root, 'scripts/smoke-subagent.mjs'), 'utf8')
  assert(subagent.includes('lib/types/manager.js'))
  assert(subagent.includes('lib/types/activation.js'))
  assert(!/lib\/types\/continuation[^'"\s]*\.js/.test(subagent))
  for (const selection of Object.keys(selections)) {
    for (const path of [...plan(selection).packages.map(pkg => pkg.directory), ...selections[selection].tests]) {
      await access(join(root, path))
    }
  }
})

test('smokes reject incomplete artifact sets before installation', () => {
  for (const script of ['smoke-session-query.mjs', 'smoke-core-packages.mjs', 'smoke-access-navigation.mjs', 'smoke-subagent.mjs']) {
    const args = script === 'smoke-session-query.mjs' ? ['query.tgz', 'jsonl.tgz', 'sqlite.tgz'] : []
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Usage: node scripts\/smoke-/)
  }
})

for (const regression of ['none', 'premature-hold', 'leaked-hold', 'accepted-sibling']) {
  test(`manager smoke detects ${regression}`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-manager-test-'))
    try {
      const { checkSubagentManager } = await import('./smoke-subagent.mjs')
      await mkdir(join(temporary, 'lib/types'), { recursive: true })
      await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
      await writeFile(join(temporary, 'lib/types/activation.js'), 'export class ChildLock {}\n')
      await writeFile(join(temporary, 'lib/types/manager.js'), `
const regression = ${JSON.stringify(regression)}
const failure = code => Object.assign(new Error('belongs to another parent session'), { code })
export class SubagentManager {
  holdOwnership(parent, target) {
    const activation = this.resident.get(parent.id)
    activation.ownedChildren.add(target)
    return () => activation.ownedChildren.delete(target)
  }
  settlementState(activation) { return activation.ownedChildren.size ? 'wait' : 'ready' }
  async sendMessage(parent, target) {
    if (regression === 'premature-hold') this.holdOwnership(parent, target)()
    const resident = this.resident.get(target)
    const header = resident?.handle.agent.session.header
      ?? (await this.ctx.get('sessionQuery').observeSession(target)).header
    if (header.parentSession !== parent.id) {
      if (regression === 'accepted-sibling') return 'unexpected-message'
      throw failure('UNAUTHORIZED')
    }
    const release = this.holdOwnership(parent, target)
    if (regression !== 'leaked-hold') release()
    throw failure('NOT_RESUMABLE')
  }
}
`)
      if (regression === 'none') await checkSubagentManager(temporary)
      else await assert.rejects(checkSubagentManager(temporary), error => error instanceof assert.AssertionError)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
}

for (const scenario of ['existing-release', 'failed-prepare']) {
  test(`${scenario} never creates or edits a release`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-release-test-'))
    try {
      const log = join(temporary, 'commands')
      for (const [name, body] of [
        ['git', 'echo fixture'],
        ['gh', `printf '%s\\n' "$*" >> "$COMMAND_LOG"\nif [ "$1" = api ]; then echo fixture; exit 0; fi\nif [ "$1 $2" = 'release view' ]; then exit ${scenario === 'existing-release' ? 0 : 1}; fi\nexit 0`],
        ['pnpm', 'echo prepare-failed >&2; exit 7'],
      ]) await writeFile(join(temporary, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      const result = spawnSync(process.execPath, ['scripts/daily-driver.mjs', 'release', 'core'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, COMMAND_LOG: log,
          GH_REPO: 'fixture/repository', RELEASE_TAG: 'daily-driver-test' },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, scenario === 'existing-release' ? /never overwrite/ : /prepare-failed/)
      const commands = await readFile(log, 'utf8')
      assert(!commands.includes('release create'))
      assert(!commands.includes('release edit'))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
