import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { plan } from './daily-driver-plan.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'daily-driver-source.mjs')
test('source commands stay frozen and never auto-install the full workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-argv-'))
  try {
    const log = join(temporary, 'argv.jsonl')
    await writeFile(join(temporary, 'pnpm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o755 })
    const directories = plan('session-query').packages.map(pkg => pkg.directory)
    for (const command of ['install', 'build']) {
      const result = spawnSync(process.execPath, [script, command, ...directories], {
        env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, ARGV_LOG: log },
        encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(result.signal, null)
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
    }
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 2 + directories.length * 2)
    for (const args of calls) assert.equal(args[0], '--config.verify-deps-before-run=false')
    assert(calls[0].includes('--frozen-lockfile'))
    assert(calls[0].includes('@deepseek-ai/dsh-session-query-sqlite...'))
    assert(calls[0].includes('@deepseek-ai/dsh-root'))
    assert(!calls[0].includes('@deepseek-ai/dsh-root...'))
    assert(calls[0].includes('@deepseek-ai/dsh-session...'))
    assert(calls[1].includes('packages/core/session/tsconfig.json'))
    const host = calls.find(args => args.includes('tsdown') && args.includes('packages/core/session'))
    assert.deepEqual(host?.slice(1), ['exec', 'tsdown', '--workspace',
      'packages/core/session', '-F', '@deepseek-ai/dsh-session', '--env.DSH_BUILD_FACE', 'host'])
    assert(calls.some(args => args.includes('pack') && args.includes('packages/core/session')))
    await writeFile(log, '')
    const client = spawnSync(process.execPath, [script, 'build', 'packages/client/connection'], {
      env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, ARGV_LOG: log },
      encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(client.status, 0, client.stderr)
    const clientCalls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(clientCalls.length, 3)
    assert.deepEqual(clientCalls[1].slice(1), ['exec', 'tsdown', '--workspace',
      'packages/client/connection'])
    assert(clientCalls[2].includes('pack'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
