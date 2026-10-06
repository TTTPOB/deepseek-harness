/** Build the independent consumer with the exact query artifacts supplied by the release. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [sourceArg, artifactsArg, ...extra] = process.argv.slice(2)
assert(sourceArg && artifactsArg && !extra.length,
  'Usage: node scripts/prepare-session-tools-fork12.mjs <session-tools-source> <artifact-directory>')
const source = resolve(sourceArg)
const artifacts = resolve(artifactsArg)
const manifestPath = join(source, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.equal(manifest.version, '0.1.3')
const workspacePath = join(source, 'pnpm-workspace.yaml')
const workspace = readFileSync(workspacePath, 'utf8')
assert(!/^overrides:/m.test(workspace), 'Release source must not retain development overrides')
writeFileSync(workspacePath, workspace + `blockExoticSubdeps: false\noverrides:\n  '@deepseek-ai/dsh-session-query': 'file:${join(artifacts, 'deepseek-ai-dsh-session-query-0.1.7-rc.2-fork2.tgz')}'\n  '@deepseek-ai/dsh-session-query-sqlite': 'file:${join(artifacts, 'deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork5.tgz')}'\n`)
const run = args => execFileSync('pnpm', ['--config.verify-deps-before-run=false', ...args], {
  cwd: source, stdio: 'inherit', timeout: 600_000,
})
run(['install', '--no-frozen-lockfile'])
run(['check'])
run(['pack', '--pack-destination', artifacts])
