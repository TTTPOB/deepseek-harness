import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { manifest, plan } from './daily-driver-plan.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'daily-driver-source.mjs')

test('source commands stay frozen and never auto-install the full workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'daily-driver-argv-'))
  try {
    const log = join(temporary, 'argv.jsonl')
    await writeFile(join(temporary, 'pnpm'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`, { mode: 0o755 })
    const packages = plan('session-query').packages
    const directories = packages.map(pkg => pkg.directory)
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
    for (const args of calls) assert.equal(args[0], '--config.verify-deps-before-run=false')
    const install = calls.find(args => args.includes('install'))
    assert(install.includes('--frozen-lockfile'))
    assert(install.includes('@deepseek-ai/dsh-root'))
    assert(!install.includes('@deepseek-ai/dsh-root...'))
    for (const pkg of packages) assert(install.includes(`${pkg.name}...`))
    const compiler = calls.find(args => args.includes('tsc'))
    for (const directory of directories) assert(compiler.includes(`${directory}/tsconfig.json`))
    for (const pkg of packages) {
      const host = calls.find(args => args.includes('tsdown') && args.includes(pkg.directory))
      assert.deepEqual(host?.slice(1), ['exec', 'tsdown', '--config-loader', 'native', '--workspace',
        pkg.directory, '-F', pkg.name, '--env.DSH_BUILD_FACE', 'host'])
      assert(calls.some(args => args.includes('pack') && args.includes(pkg.directory)))
    }
    await writeFile(log, '')
    const clientDirectory = 'packages/client/connection'
    assert(manifest(clientDirectory).dsh.client)
    const client = spawnSync(process.execPath, [script, 'build', clientDirectory], {
      env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, ARGV_LOG: log },
      encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(client.signal, null)
    assert.equal(client.error, undefined)
    assert.equal(client.status, 0, client.stderr)
    const clientCalls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const generation = clientCalls.findIndex(args => args.includes('scripts/generate-typert.ts'))
    const compilation = clientCalls.findIndex(args => args.includes('tsc'))
    assert(generation >= 0 && generation < compilation)
    const bundle = clientCalls.find(args => args.includes('tsdown'))
    assert.deepEqual(bundle.slice(1), ['exec', 'tsdown', '--config-loader', 'native', '--workspace', clientDirectory])
    assert(clientCalls.at(-1).includes('pack'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
