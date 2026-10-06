/** Verify SQLite fork4 with unchanged query fork1 and JSONL fork3 Release fixtures. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [sqlite, ...extra] = process.argv.slice(2)
assert(sqlite && extra.length === 0,
  'Usage: node scripts/smoke-session-query-fork11.mjs <session-query-sqlite-fork4.tgz>')
const fixtures = await mkdtemp(join(tmpdir(), 'dsh-fork11-fixtures-'))
try {
  const paths = []
  for (const [tag, name] of [
    ['daily-driver-v0.1.7-rc.2-fork9', 'deepseek-ai-dsh-session-query-0.1.7-rc.2-fork1.tgz'],
    ['daily-driver-v0.1.7-rc.2-fork10', 'deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork3.tgz'],
  ]) {
    const directory = join(fixtures, tag)
    execFileSync('gh', ['release', 'download', tag, '--repo', 'TTTPOB/deepseek-harness',
      '--pattern', name, '--pattern', 'SHA256SUMS', '--dir', directory], { stdio: 'inherit', timeout: 120_000 })
    const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8')
    const expected = sums.split('\n').find(line => line.trim().endsWith(`  ${name}`))?.split(/\s+/)[0]
    assert.match(expected ?? '', /^[a-f0-9]{64}$/)
    const path = join(directory, name)
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected, name)
    paths.push(path)
  }
  execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'smoke-session-query-fork9.mjs'),
    ...paths, resolve(sqlite)], {
    stdio: 'inherit', timeout: 900_000,
    env: { ...process.env, DSH_SMOKE_JSONL_VERSION: '0.1.7-rc.2-fork3', DSH_SMOKE_SQLITE_VERSION: '0.1.7-rc.2-fork4' },
  })
} finally {
  await rm(fixtures, { recursive: true, force: true })
}
