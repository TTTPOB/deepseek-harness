/** The browsing release selects its paired query artifacts and independent consumer only. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const workflow = yaml.load(readFileSync(new URL('.github/workflows/daily-driver-release.yml', root), 'utf8'))
const accepts = (name, tag) => Function('github', 'inputs', `return (${workflow.jobs[name].if})`)(
  { event_name: 'push', ref: `refs/tags/${tag}` }, { subagent_only: false },
)
test('fork12 selects the browsing route without triggering generic releases', () => {
  const tag = 'daily-driver-v0.1.7-rc.2-fork12'
  assert(accepts('session-browsing-fork12', tag))
  assert.equal(accepts('core-packages-fork13', tag), false)
  assert.equal(accepts('core-packages-fork13', tag), false)
  assert.equal(accepts('session-browsing-fork12', 'daily-driver-v0.1.7-rc.2-fork11'), false)
  const job = workflow.jobs['session-browsing-fork12']
  assert.equal(job.env.PACKAGES, 'packages/session-query/session-query packages/session-query/session-query-sqlite')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    'dist/daily-driver/deepseek-ai-dsh-session-query-0.1.7-rc.2-fork2.tgz',
    'dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork5.tgz',
    'dist/daily-driver/SHA256SUMS',
  ])
  const publish = job.steps.find(step => step.name === 'Publish immutable session-query release').run
  assert(!publish.includes('*.tgz'))
})
test('fork12 smoke refuses incomplete arguments before downloading fixtures', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/smoke-session-query-fork12.mjs', root))],
    { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: node scripts\/smoke-session-query-fork12.mjs/)
})
