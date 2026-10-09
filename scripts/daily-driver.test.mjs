/** Check manifest-derived selection and fail-before-publication behavior without releasing. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { manifest, plan, root } from './daily-driver-plan.mjs'

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

test('smokes reject incomplete artifact sets before installation', () => {
  for (const script of ['smoke-session-query.mjs', 'smoke-core-packages.mjs', 'smoke-access-navigation.mjs', 'smoke-subagent.mjs']) {
    const args = script === 'smoke-session-query.mjs' ? ['query.tgz', 'jsonl.tgz', 'sqlite.tgz'] : []
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Usage: node scripts\/smoke-/)
  }
})

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
