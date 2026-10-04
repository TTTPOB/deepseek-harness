import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as parse } from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = parse(await readFile(join(root, '.github/workflows/daily-driver-release.yml'), 'utf8'))
const job = workflow.jobs['mobile-ui-fork8']
const tag = 'refs/tags/daily-driver-v0.1.7-rc.2-fork8'

test('UI release selects its own tag and only the two changed packages', () => {
  assert.equal(job.if, `github.event_name == 'push' && github.ref == '${tag}'`)
  for (const name of ['build', 'publish']) assert(workflow.jobs[name].if.includes(`github.ref != '${tag}'`))
  assert.equal(job.env.PACKAGES, 'packages/client/ui-plugin-manager packages/client/ui-sidebar-terminal')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    'dist/daily-driver/deepseek-ai-dsh-client-ui-plugin-manager-0.1.7-rc.2-fork2.tgz',
    'dist/daily-driver/deepseek-ai-dsh-client-ui-sidebar-terminal-0.1.7-rc.2-fork2.tgz',
    'dist/daily-driver/SHA256SUMS',
  ])
})

test('installed-artifact acceptance precedes immutable publication and receives the paired fixtures', () => {
  const smokeIndex = job.steps.findIndex(step => step.name === 'Verify official compatibility and cold Web Loader with paired UI artifacts')
  const publishIndex = job.steps.findIndex(step => step.name === 'Publish immutable UI release')
  assert(smokeIndex >= 0 && publishIndex > smokeIndex)
  const command = job.steps[smokeIndex].run.split('\n').filter(line => !line.trim().startsWith('(cd')).join(' ').replaceAll('\\', '')
  assert.deepEqual(command.trim().split(/\s+/), [
    'node', 'scripts/smoke-access-navigation-fork6.mjs',
    'dist/fixtures/deepseek-ai-dsh-client-connection-0.1.7-rc.2-fork2.tgz',
    'dist/fixtures/deepseek-ai-dsh-host-frontend-static-0.1.7-rc.2-fork2.tgz',
    'dist/fixtures/deepseek-ai-dsh-api-gateway-0.1.7-rc.2-fork2.tgz',
    'dist/fixtures/deepseek-ai-dsh-client-ui-settings-0.1.7-rc.2-fork1.tgz',
    'dist/daily-driver/deepseek-ai-dsh-client-ui-plugin-manager-0.1.7-rc.2-fork2.tgz',
    'dist/daily-driver/deepseek-ai-dsh-client-ui-sidebar-terminal-0.1.7-rc.2-fork2.tgz',
  ])
  for (const step of job.steps.filter(step => step.run)) {
    const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' })
    assert.equal(result.status, 0, `${step.name ?? 'shell step'}: ${result.stderr}`)
  }
})

test('release identity accepts both lightweight and annotated immutable tags', async () => {
  const scratch = join(root, 'dist', 'smoke')
  await mkdir(scratch, { recursive: true })
  const identity = job.steps.find(step => step.name === 'Verify UI release identity').run
  for (const annotated of [false, true]) {
    const fixture = await mkdtemp(join(scratch, 'ui-tag-identity-'))
    try {
      for (const path of [...job.env.PACKAGES.split(' '), 'apps/cli', 'packages/bundle/web-app']) {
        await mkdir(join(fixture, path), { recursive: true })
        const metadata = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'))
        await writeFile(join(fixture, path, 'package.json'), JSON.stringify({ version: metadata.version }))
      }
      const git = args => {
        const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8', timeout: 30_000 })
        assert.equal(result.status, 0, result.stderr)
      }
      git(['init', '-q'])
      git(['add', '.'])
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'])
      git(['tag', 'daily-driver-v0.1.7-rc.2-fork6'])
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag',
        ...(annotated ? ['-a', '-m', 'Fixture'] : []), 'daily-driver-v0.1.7-rc.2-fork8'])
      const result = spawnSync('bash', ['-c', identity], {
        cwd: fixture, env: { ...process.env, PACKAGES: job.env.PACKAGES,
          GITHUB_REF_NAME: 'daily-driver-v0.1.7-rc.2-fork8' }, encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})
