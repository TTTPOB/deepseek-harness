/** Release routing and artifact selection regressions for the SQLite-only fork11 route. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const workflow = yaml.load(readFileSync(new URL('.github/workflows/daily-driver-release.yml', root), 'utf8'))
const job = workflow.jobs['bm25-session-query-fork11']
// Evaluate only the repository-owned GitHub condition subset used by these jobs.
const accepts = (name, tag, event = 'push') => Function('github', 'inputs', `return (${workflow.jobs[name].if})`)(
  { event_name: event, ref: `refs/tags/${tag}` }, { subagent_only: false },
)

test('fork11 tags select only the SQLite route, never the generic fork1 package set', () => {
  const tag = 'daily-driver-v0.1.7-rc.2-fork11'
  assert.equal(accepts('bm25-session-query-fork11', tag), true)
  assert.equal(accepts('core-packages-fork13', tag), false)
  assert.equal(accepts('core-packages-fork13', tag), false)
  assert.equal(accepts('bm25-session-query-fork11', tag, 'workflow_dispatch'), false)
  for (const suffix of ['fork1', 'fork9', 'fork10']) {
    assert.equal(accepts('bm25-session-query-fork11', `daily-driver-v0.1.7-rc.2-${suffix}`), false)
  }
  assert.equal(accepts('core-packages-fork13', 'daily-driver-v0.1.7-rc.2-fork1'), false)
})

test('fork11 builds and publishes only SQLite fork4, retaining the other packages as fixtures', () => {
  assert.equal(job.env.PACKAGES, 'packages/session-query/session-query-sqlite')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    'dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork4.tgz',
    'dist/daily-driver/SHA256SUMS',
  ])
  const publish = job.steps.find(step => step.name === 'Publish immutable session-query release').run
  assert.match(publish, /gh release create "\$tag" deepseek-ai-dsh-session-query-sqlite-0\.1\.7-rc\.2-fork4\.tgz SHA256SUMS/)
  assert(!publish.includes('*.tgz'))
  const smoke = job.steps.find(step => step.name === 'Verify isolated installed artifacts').run
  assert.match(smoke, /node scripts\/smoke-session-query-fork11\.mjs dist\/daily-driver\/deepseek-ai-dsh-session-query-sqlite-0\.1\.7-rc\.2-fork4\.tgz/)
})

test('fork11 smoke rejects missing or extra arguments before downloading fixtures', () => {
  for (const args of [[], ['one.tgz', 'extra.tgz']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/smoke-session-query-fork11.mjs', root)), ...args],
      { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage: node scripts\/smoke-session-query-fork11.mjs/)
  }
})

test('source verification selects the built current provider rather than retired artifact filenames', () => {
  const verification = yaml.load(readFileSync(new URL('.github/workflows/daily-driver-verify.yml', root), 'utf8'))
  const selection = verification.jobs.verify.steps.find(step => step.name === 'Select focused validation').run
  const manifest = JSON.parse(readFileSync(new URL('packages/session-query/session-query-sqlite/package.json', root), 'utf8'))
  const artifact = `deepseek-ai-dsh-session-query-sqlite-${manifest.version}.tgz`
  assert(selection.includes(`dist/daily-driver/${artifact}`))
  assert(selection.includes('scripts/smoke-session-query-fork12.mjs'))
  assert(!selection.includes('smoke-session-index-fork4.mjs'))
  const smoke = verification.jobs.verify.steps.find(step => step.name === 'Isolated tarball smoke')
  assert.equal(smoke.env.GH_TOKEN, '${{ github.token }}')
  const steps = verification.jobs.verify.steps
  const prepared = steps.findIndex(step => step.name === 'Install frozen target closure and build tools')
  const routing = steps.findIndex(step => step.run?.includes('node --test scripts/daily-driver-fork11.test.mjs'))
  assert(routing > prepared, 'YAML-dependent tests run after the frozen dependency preparation')
})
