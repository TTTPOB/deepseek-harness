import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load as parse } from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = parse(await readFile(join(root, '.github/workflows/daily-driver-release.yml'), 'utf8'))
const job = workflow.jobs['mobile-ui-fork7']
const tag = 'refs/tags/daily-driver-v0.1.7-rc.2-fork7'

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
