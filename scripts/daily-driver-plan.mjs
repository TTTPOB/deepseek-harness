/** Current capability checks; package versions belong to their manifests. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const manifest = directory => JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
export const officialVersion = manifest('apps/cli').version
export const packageManager = manifest('.').packageManager
export const selections = {
  'session-query': {
    packages: ['packages/session-query/session-query', 'packages/session/session-persistence-jsonl', 'packages/session-query/session-query-sqlite', 'packages/core/session'],
    tests: ['packages/core/session/tests', 'packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts', 'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts', 'packages/session-query/session-query/tests', 'packages/session-query/session-query-sqlite/tests', 'packages/session-query/tool-session-query/tests'],
    smoke: 'smoke-session-query.mjs',
  },
  core: {
    packages: ['packages/core/agent', 'packages/preset/agent-preset-registry', 'packages/llm/llm-pi-ai', 'packages/mcp/mcp-client'],
    tests: ['packages/core/agent/tests', 'packages/preset/agent-preset-registry/tests', 'packages/llm/llm-pi-ai/tests', 'packages/mcp/mcp-client/tests'],
    smoke: 'smoke-core-packages.mjs',
  },
  access: {
    packages: ['packages/client/connection', 'packages/host/frontend-static', 'packages/api/gateway', 'packages/client/ui-settings', 'packages/client/ui-plugin-manager', 'packages/client/ui-sidebar-terminal'],
    tests: ['packages/client/connection/tests', 'packages/host/frontend-static/tests', 'packages/api/gateway/tests', 'packages/client/ui-settings/tests', 'packages/client/ui-plugin-manager/tests', 'packages/client/ui-sidebar-terminal/tests', 'packages/client/ui-settings-models/tests/apply.client.spec.ts', 'packages/client/ui-theme/tests/apply.client.spec.ts'],
    smoke: 'smoke-access-navigation.mjs',
  },
  subagent: {
    packages: ['packages/subagent/subagent'],
    tests: ['packages/subagent/subagent/tests/continuation.spec.ts'],
    smoke: 'smoke-subagent.mjs',
  },
}
export function plan(selection, directories = []) {
  const checks = selections[selection]
  assert(checks, `Unknown selection ${selection}; choose ${Object.keys(selections).join(', ')}`)
  const selected = directories.length ? directories : checks.packages
  assert(new Set(selected).size === selected.length, 'Duplicate package selection')
  for (const directory of selected) assert(checks.packages.includes(directory), `${directory} is not checked by ${selection}`)
  const packages = checks.packages.map(directory => ({ directory, ...manifest(directory) }))
  const artifact = pkg => join(root, 'dist/daily-driver', `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`)
  return { ...checks, packages, selected: packages.filter(pkg => selected.includes(pkg.directory)), artifact }
}
