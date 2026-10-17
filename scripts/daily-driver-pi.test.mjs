/** Pi qualification owns temporary source overrides and restores both files after failures. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withPiFork } from './daily-driver-pi.mjs'

for (const fails of [false, true]) {
  test(`Pi source qualification restores canonical files when check fails=${fails}`, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'daily-driver-pi-test-'))
    const previousPath = process.env.PATH
    try {
      mkdirSync(join(temporary, 'package'))
      mkdirSync(join(temporary, 'bin'))
      writeFileSync(join(temporary, 'package/package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '1.1.0-fork1' }))
      const tarball = join(temporary, 'pi.tgz')
      execFileSync('tar', ['-czf', tarball, '-C', temporary, 'package/package.json'])
      const workspace = "overrides:\n  unrelated: '1'\npatchedDependencies:\n  '@earendil-works/pi-ai@1.1.0': patches/pi.patch\n"
      const lock = 'canonical-lock\n'
      writeFileSync(join(temporary, 'pnpm-workspace.yaml'), workspace)
      writeFileSync(join(temporary, 'pnpm-lock.yaml'), lock)
      writeFileSync(join(temporary, 'bin/pnpm'), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync('calls', args.join(' ') + '\\n')
if (args.includes('--no-frozen-lockfile')) writeFileSync('pnpm-lock.yaml', 'temporary-lock\\n')
else require('node:assert/strict').equal(readFileSync('pnpm-lock.yaml', 'utf8'), 'canonical-lock\\n')
`, { mode: 0o755 })
      process.env.PATH = join(temporary, 'bin') + ':' + previousPath
      const check = () => {
        const qualified = readFileSync(join(temporary, 'pnpm-workspace.yaml'), 'utf8')
        assert(qualified.includes('file:' + tarball))
        assert(!qualified.includes('patches/pi.patch'))
        if (fails) throw new Error('fixture-check-failed')
        return 'checked'
      }
      if (fails) assert.throws(() => withPiFork(tarball, check, temporary), /fixture-check-failed/)
      else assert.equal(withPiFork(tarball, check, temporary), 'checked')
      assert.equal(readFileSync(join(temporary, 'pnpm-workspace.yaml'), 'utf8'), workspace)
      assert.equal(readFileSync(join(temporary, 'pnpm-lock.yaml'), 'utf8'), lock)
      const calls = readFileSync(join(temporary, 'calls'), 'utf8').trim().split('\n')
      assert.equal(calls.length, 2)
      assert(calls[0].includes('--no-frozen-lockfile'))
      assert(calls[1].includes('--frozen-lockfile'))
    } finally {
      process.env.PATH = previousPath
      rmSync(temporary, { recursive: true, force: true })
    }
  })
}
