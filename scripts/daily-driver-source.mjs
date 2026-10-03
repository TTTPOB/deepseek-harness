/** Frozen source installation and focused Host builds for explicitly selected workspace packages. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [command, ...directories] = process.argv.slice(2)
assert(['install', 'build'].includes(command) && directories.length,
  'Usage: node scripts/daily-driver-source.mjs install|build <workspace-directory>...')
const targets = directories.map(directory => {
  const path = relative(root, resolve(root, directory)).replaceAll('\\', '/')
  assert(/^(packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/[^/]+)$/.test(path),
    `Expected a workspace package directory: ${directory}`)
  return { path, ...JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) }
})
const run = args => execFileSync('pnpm', ['--config.verify-deps-before-run=false', ...args], { cwd: root, stdio: 'inherit', timeout: 600_000 })
if (command === 'install') {
  // Select the root importer, not its workspace dependency closure.
  const names = ['@deepseek-ai/dsh-typert-generator', '@deepseek-ai/node-addon-system-workspace', ...targets.map(target => target.name)]
  run(['--filter', '@deepseek-ai/dsh-root', ...names.flatMap(name => ['--filter', `${name}...`]),
    'install', '--frozen-lockfile'])
} else {
  run(['exec', 'tsc', '-b', 'packages/typert/generator/tsconfig.json',
    ...targets.map(target => `${target.path}/tsconfig.json`)])
  mkdirSync(join(root, 'dist/daily-driver'), { recursive: true })
  for (const target of targets) {
    run(['exec', 'tsdown', '--workspace', target.path, '-F', target.name, '--env.DSH_BUILD_FACE', 'host'])
    run(['--dir', target.path, 'pack', '--pack-destination', join(root, 'dist/daily-driver')])
  }
}
