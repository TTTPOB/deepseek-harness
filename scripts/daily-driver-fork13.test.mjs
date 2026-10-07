/** Core publication is independent of personal plugin assets. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const workflow = yaml.load(readFileSync(new URL('.github/workflows/daily-driver-release.yml', root), 'utf8'))
const job = workflow.jobs['core-packages-fork13']
const accepts = tag => Function('github', 'inputs', `return (${job.if})`)({ event_name: 'push', ref: `refs/tags/${tag}` }, { subagent_only: false })

test('fork13 publishes only the four selected core packages', () => {
  assert.equal(accepts('daily-driver-v0.1.7-rc.2-fork13'), true)
  assert.equal(accepts('daily-driver-v0.1.7-rc.2-fork12'), false)
  assert.equal(accepts('daily-driver-v0.1.7-rc.2-fork1'), false)
  assert.equal(job.env.PACKAGES, 'packages/core/agent packages/preset/agent-preset-registry packages/llm/llm-pi-ai packages/mcp/mcp-client')
  const publish = job.steps.find(step => step.name === 'Publish immutable core assets').run
  assert(publish.includes('--verify-tag'))
  assert(publish.includes('gh release view'))
  assert(!publish.includes('*.tgz'))
  for (const name of ['agent', 'agent-preset-registry', 'llm-pi-ai', 'mcp-client']) assert(publish.includes(`deepseek-ai-dsh-${name}-0.1.7-rc.2-fork1.tgz`))
})

test('core publication does not require or ship personal plugins', () => {
  const inputs = workflow.on.workflow_dispatch.inputs
  assert(!Object.hasOwn(inputs, 'firecrawl_tarball_url'))
  assert(!Object.hasOwn(inputs, 'overlay_ref'))
  assert(!Object.hasOwn(inputs, 'envrc_ref'))
  assert(!Object.hasOwn(workflow.jobs, 'build'))
  assert(!Object.hasOwn(workflow.jobs, 'publish'))
  const commands = job.steps.map(step => step.run ?? '').join('\n')
  for (const name of ['firecrawl', 'dsh-progressive-tools', 'dsh-workspace-overlay', 'dsh-workspace-envrc']) assert(!commands.includes(name))
})

test('core smoke rejects an incomplete artifact set before installing', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/smoke-core-packages-fork13.mjs', root))], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: node scripts\/smoke-core-packages-fork13.mjs/)
})
