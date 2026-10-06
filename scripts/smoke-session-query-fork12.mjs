/** Verify paired browsing artifacts with the unchanged JSONL fork3 release fixture. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [query, sqlite, tools, ...extra] = process.argv.slice(2)
assert(query && sqlite && !extra.length,
  'Usage: node scripts/smoke-session-query-fork12.mjs <query-fork2.tgz> <sqlite-fork5.tgz> [session-tools-0.1.3.tgz]')
const fixtures = await mkdtemp(join(tmpdir(), 'dsh-fork12-fixtures-'))
try {
  const name = 'deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork3.tgz'
  execFileSync('gh', ['release', 'download', 'daily-driver-v0.1.7-rc.2-fork10',
    '--repo', 'TTTPOB/deepseek-harness', '--pattern', name, '--dir', fixtures],
  { stdio: 'inherit', timeout: 120_000 })
  execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'smoke-session-query-fork9.mjs'),
    resolve(query), join(fixtures, name), resolve(sqlite)], {
    stdio: 'inherit', timeout: 900_000,
    env: { ...process.env, DSH_SMOKE_QUERY_VERSION: '0.1.7-rc.2-fork2',
      DSH_SMOKE_JSONL_VERSION: '0.1.7-rc.2-fork3', DSH_SMOKE_SQLITE_VERSION: '0.1.7-rc.2-fork5',
      ...tools ? { DSH_SMOKE_SESSION_TOOLS: resolve(tools) } : {} },
  })
} finally {
  await rm(fixtures, { recursive: true, force: true })
}
