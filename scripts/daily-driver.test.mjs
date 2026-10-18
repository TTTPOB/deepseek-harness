/** Check manifest-derived selection and fail-before-publication behavior without releasing. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load as parseYaml } from 'js-yaml'
import { manifest, packageManager, plan, root, selections } from './daily-driver-plan.mjs'
import { artifactClosure, stageArtifactOverrides } from './daily-driver-artifacts.mjs'

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
  const team = plan('team-model-selection', ['packages/subagent/tool-subagent'])
  assert.equal(team.selected.length, 1)
  assert.equal(team.packages.length, 4)
  assert.throws(() => plan('team-model-selection', ['packages/client/connection']))
})

test('capability groups track rc.1 owners and toolchain', async () => {
  assert.equal(packageManager, 'pnpm@11.28.5')
  assert.deepEqual(Object.keys(selections), ['session-query', 'core', 'team-model-selection', 'access'])
  assert.deepEqual(plan('core').packages.map(pkg => pkg.directory), [
    'packages/core/agent', 'packages/preset/agent-preset-registry', 'packages/subagent/subagent',
    'packages/llm/llm-pi-ai', 'packages/mcp/mcp-client', 'packages/experimental/tool-agent-team',
  ])
  assert(plan('core').tests.includes('packages/subagent/subagent/tests'))
  assert(plan('core').tests.includes('packages/experimental/tool-agent-team/tests'))
  const closure = artifactClosure(plan('core').packages)
  assert(closure.some(pkg => pkg.directory === 'packages/core/session'))
  assert(closure.some(pkg => pkg.directory === 'packages/session-query/session-query'))
  assert.equal(new Set(closure.map(pkg => pkg.name)).size, closure.length)
  const team = plan('team-model-selection')
  assert.deepEqual(team.packages.map(pkg => pkg.directory), [
    'packages/subagent/subagent', 'packages/subagent/tool-subagent',
    'packages/experimental/agent-team', 'packages/experimental/tool-agent-team',
  ])
  assert.deepEqual(team.tests, [
    'packages/subagent/subagent/tests', 'packages/subagent/tool-subagent/tests',
    'packages/experimental/agent-team/tests', 'packages/experimental/tool-agent-team/tests',
  ])
  assert(!team.packages.some(pkg => pkg.directory === 'packages/llm/llm-pi-ai'))
  const teamClosure = artifactClosure(team.packages)
  for (const pkg of team.packages) assert(teamClosure.some(candidate => candidate.name === pkg.name))
  assert.equal(new Set(teamClosure.map(pkg => pkg.name)).size, teamClosure.length)
  assert.deepEqual(plan('access').packages.map(pkg => pkg.directory), [
    'packages/client/connection', 'packages/host/frontend-static', 'packages/api/gateway',
    'packages/client/ui-plugin-manager', 'packages/client/ui-sidebar-terminal',
  ])
  assert.throws(() => plan('access', ['packages/client/ui-settings']))
  assert.throws(() => plan('core', ['packages/core/agent', 'packages/core/agent']))
  for (const selection of Object.keys(selections)) {
    for (const path of [...plan(selection).packages.map(pkg => pkg.directory), ...selections[selection].tests]) {
      await access(join(root, path))
    }
  }
})

test('release workflow exposes every capability selection in plan order', async () => {
  const workflow = parseYaml(await readFile(join(root, '.github/workflows/daily-driver-release.yml'), 'utf8'))
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.selection.options, Object.keys(selections))
})

test('consumer overrides and build permissions belong to its workspace, including an explicit Pi tarball', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-overrides-test-'))
  const previous = process.env.DSH_PI_AI_TARBALL
  try {
    const runtime = join(temporary, 'runtime')
    await mkdir(runtime)
    const asset = join(temporary, 'fixture.tgz')
    const pi = join(temporary, 'pi-fixture.tgz')
    await writeFile(asset, 'fixture')
    await writeFile(pi, 'pi-fixture')
    process.env.DSH_PI_AI_TARBALL = pi
    await stageArtifactOverrides(runtime, [{ name: 'fixture', version: 'fixture' }], [asset])
    const workspace = JSON.parse(await readFile(join(runtime, 'pnpm-workspace.yaml'), 'utf8'))
    assert.deepEqual(workspace.overrides, { fixture: 'file:./fixture.tgz', '@earendil-works/pi-ai': 'file:./pi-fixture.tgz' })
    assert.equal(workspace.allowBuilds['node-pty'], true)
    assert.equal(workspace.allowBuilds.protobufjs, false)
    assert.equal(await readFile(join(runtime, 'pi-fixture.tgz'), 'utf8'), 'pi-fixture')
  } finally {
    if (previous === undefined) delete process.env.DSH_PI_AI_TARBALL
    else process.env.DSH_PI_AI_TARBALL = previous
    await rm(temporary, { recursive: true, force: true })
  }
})

test('smokes reject incomplete artifact sets before installation', () => {
  for (const script of ['smoke-session-query.mjs', 'smoke-core-packages.mjs', 'smoke-team-model-selection.mjs', 'smoke-access-navigation.mjs', 'smoke-subagent.mjs']) {
    const args = script === 'smoke-session-query.mjs'
      ? ['query.tgz', 'jsonl.tgz', 'sqlite.tgz']
      : script === 'smoke-team-model-selection.mjs'
        ? ['subagent.tgz', 'tool-subagent.tgz', 'agent-team.tgz', 'tool-agent-team.tgz']
        : []
    const result = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Usage: node scripts\/smoke-/)
  }
})

test('core release refuses missing Pi qualification before contacting GitHub', () => {
  const result = spawnSync(process.execPath, ['scripts/daily-driver.mjs', 'release', 'core'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, DSH_PI_AI_TARBALL: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Core release requires DSH_PI_AI_TARBALL/)
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
          GH_REPO: 'fixture/repository', RELEASE_TAG: 'daily-driver-test', DSH_PI_AI_TARBALL: '/unused/fixture-pi.tgz' },
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
