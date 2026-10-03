import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'daily-driver-source.mjs')
test('source commands stay frozen and never auto-install the full workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-argv-'))
  try {
    const log = join(temporary, 'argv.jsonl')
    await writeFile(join(temporary, 'pnpm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o755 })
    for (const command of ['install', 'build']) {
      const result = spawnSync(process.execPath, [script, command, 'packages/session-query/session-query-sqlite'], {
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, ARGV_LOG: log },
        encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(result.signal, null)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 4)
    for (const args of calls) assert.equal(args[0], '--config.verify-deps-before-run=false')
    assert(calls[0].includes('--frozen-lockfile'))
    assert(calls[0].includes('@deepseek-ai/dsh-session-query-sqlite...'))
    assert(calls[0].includes('@deepseek-ai/dsh-root'))
    assert(!calls[0].includes('@deepseek-ai/dsh-root...'))
    assert.deepEqual(calls[2].slice(1), ['exec', 'tsdown', '--workspace',
      'packages/session-query/session-query-sqlite', '-F', '@deepseek-ai/dsh-session-query-sqlite',
      '--env.DSH_BUILD_FACE', 'host'])
    assert(calls[3].includes('pack'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
