/** Qualify the Pi serializer fork through pnpm, then restore the canonical source installation. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { root } from './daily-driver-plan.mjs'

/** Run a source check with one explicit Pi fork without retaining local lockfile paths. */
export function withPiFork(tarball, check, directory = root) {
  const source = resolve(tarball)
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', source, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(manifest.name, '@earendil-works/pi-ai')
  assert.match(manifest.version, /^1\.1\.0-fork\d+$/)
  const workspacePath = join(directory, 'pnpm-workspace.yaml')
  const lockPath = join(directory, 'pnpm-lock.yaml')
  const workspace = readFileSync(workspacePath, 'utf8')
  const lock = readFileSync(lockPath, 'utf8')
  assert(/^overrides:\s*$/m.test(workspace), 'Source workspace must declare overrides')
  assert(!/^  ['"]?@earendil-works\/pi-ai['"]?:/m.test(workspace), 'Remove an existing source Pi override before qualification')
  const qualified = workspace.replace(/^overrides:\s*$/m,
    `overrides:\n  '@earendil-works/pi-ai': ${JSON.stringify('file:' + source)}`)
    .replace(/^  ['"]?@earendil-works\/pi-ai@1\.1\.0['"]?:[^\n]*\n/m, '')
  const install = frozen => execFileSync('pnpm', [
    '--config.verify-deps-before-run=false', '--filter', '@deepseek-ai/dsh-root',
    '--filter', '@deepseek-ai/dsh-llm-pi-ai...', 'install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile',
  ], { cwd: directory, stdio: 'inherit', timeout: 600_000 })
  try {
    writeFileSync(workspacePath, qualified)
    install(false)
    return check()
  } finally {
    writeFileSync(workspacePath, workspace)
    writeFileSync(lockPath, lock)
    install(true)
  }
}
