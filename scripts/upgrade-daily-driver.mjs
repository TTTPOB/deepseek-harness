#!/usr/bin/env node
/** Preview, install, or restore the personal Linux/WSL global Web distribution. */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const names = [
  ['@deepseek-ai/dsh-agent', 'deepseek-ai-dsh-agent-0.1.7-rc.2-fork1.tgz'],
  ['@deepseek-ai/dsh-agent-preset-registry', 'deepseek-ai-dsh-agent-preset-registry-0.1.7-rc.2-fork1.tgz'],
  ['@deepseek-ai/dsh-llm-pi-ai', 'deepseek-ai-dsh-llm-pi-ai-0.1.7-rc.2-fork1.tgz'],
  ['@deepseek-ai/dsh-mcp-client', 'deepseek-ai-dsh-mcp-client-0.1.7-rc.2-fork1.tgz'],
  ['@deepseek-ai/dsh-subagent', 'deepseek-ai-dsh-subagent-0.1.7-rc.2-fork1.tgz'],
  ['@deepseek-ai/dsh-web-app', 'deepseek-ai-dsh-web-app-0.1.7-rc.2-fork1.tgz'],
  ['dsh-progressive-tools', 'dsh-progressive-tools-0.3.0.tgz'],
  ['dsh-workspace-envrc', 'dsh-workspace-envrc-0.2.0.tgz'],
  ['dsh-workspace-overlay', 'dsh-workspace-overlay-0.2.0.tgz'],
  ['@firecrawl/dsh-firecrawl', 'firecrawl-dsh-firecrawl-0.1.0-fork1.tgz'],
  ['@earendil-works/pi-ai@0.85.1-fork1', 'earendil-works-pi-ai-0.85.1-fork1.tgz'],
]
const obsoleteRows = new Set(['web-search-firecrawl', 'web-fetch-http', 'web-fetch-firecrawl', 'tool-web', 'progressive-tools'])
const supportedSections = new Set(['agent-presets', 'subagent-model-selection', 'ui-onboarding', 'ui-developer-tools', 'shell', 'llm-pi-ai', 'llm-deepseek', 'agent-default-model', 'agent-loop', 'ui-conversation', 'ui-settings', 'ui-settings-general', 'ui-settings-models', 'ui-settings-shell', 'web', 'mcp-client', 'agent-preset-registry', 'subagent-model-selection-settings'])
const renamed = {
  'agent-presets': 'agent-preset-registry',
  'subagent-model-selection': 'subagent-model-selection-settings',
  'ui-onboarding': 'ui-settings-general',
  'ui-developer-tools': 'ui-settings',
  shell: 'bash-sandbox',
}

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options })
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`)
  return result.stdout?.trim() ?? ''
}

function options(argv) {
  const result = { mode: 'preview' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--apply') result.mode = 'apply'
    else if (flag === '--rollback') { result.mode = 'rollback'; result.backup = argv[++i] }
    else if (['--home', '--global-dir', '--global-bin-dir', '--artifacts'].includes(flag)) result[flag.slice(2)] = argv[++i]
    else throw new Error(`Unknown option: ${flag}`)
    if (flag === '--rollback' && !result.backup) throw new Error('Missing value for --rollback')
    if (flag !== '--apply' && flag !== '--rollback' && !result[flag.slice(2)]) throw new Error(`Missing value for ${flag}`)
  }
  return result
}

async function yamlFor(globalDir) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(globalDir, { withFileTypes: true }))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = join(globalDir, entry.name, 'node_modules/@deepseek-ai/dsh/package.json')
    if (!existsSync(manifest)) continue
    const require = createRequire(realpathSync(manifest))
    return require(require.resolve('js-yaml'))
  }
  throw new Error(`Cannot locate installed DSH owning package under ${globalDir}`)
}

function codec(yaml) {
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: value => ({ __dshExpression: value }),
    instanceOf: Object,
    predicate: value => Object.keys(value).length === 1 && typeof value.__dshExpression === 'string',
    represent: value => value.__dshExpression,
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([expression])
  return { load: text => yaml.load(text, { schema }), dump: value => yaml.dump(value, { schema, lineWidth: -1 }) }
}

async function optional(path) { return existsSync(path) ? readFile(path, 'utf8') : null }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`)
  return value
}
function rows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a row list`)
  return value
}

function migrate(settings, patch) {
  const target = rows(structuredClone(patch), 'web patch').filter(row => !obsoleteRows.has(row.id))
  const descriptions = []
  for (const [section, original] of Object.entries(object(settings, 'settings'))) {
    if (!supportedSections.has(section)) throw new Error(`Unsupported settings section ${section}; inspect its backup before upgrading`)
    const id = renamed[section] ?? section
    const row = target.find(item => item.id === id)
    if (row && (row.disabled !== undefined || row.name !== undefined)) throw new Error(`Unsupported patch row metadata for settings section ${section}`)
    if (target.some(item => item.insert?.some?.(inserted => inserted.id === id))) throw new Error(`Settings section ${section} conflicts with inserted patch row`)
    let config = structuredClone(object(original, `settings section ${section}`))
    if (section === 'agent-presets') {
      config = { ...config, default: 'standard-ptc', selectedDefault: config.default }
    }
    if (row) row.config = { ...object(row.config ?? {}, `patch row ${id}`), ...config }
    else target.push({ id, config })
    descriptions.push(`${section} -> ${id}`)
  }
  return { target, descriptions, removed: patch.length - target.length + descriptions.filter(x => !patch.some(row => row.id === x.split(' -> ')[1])).length }
}

async function main() {
  const args = options(process.argv.slice(2))
  const home = resolve(args.home ?? join(homedir(), '.dsh'))
  const globalDir = resolve(args['global-dir'] ?? command('pnpm', ['root', '-g']).split('\n').at(-1))
  const artifacts = resolve(args.artifacts ?? join(repository, basename(dirname(repository)) === '.worktrees' ? '../../artifacts/daily-driver-v0.1.7-rc.2-fork1' : '../artifacts/daily-driver-v0.1.7-rc.2-fork1'))
  const profile = join(home, 'profiles/web')
  const workspacePath = join(globalDir, 'pnpm-workspace.yaml')
  const profilePath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const settingsPath = join(home, 'settings.yaml')
  if (args.mode === 'rollback') {
    const backup = resolve(args.backup)
    const metadata = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))
    if (metadata.home !== home || metadata.globalDir !== globalDir) throw new Error('Backup target differs from --home or --global-dir')
    await restore(backup, { home, globalDir, profile, workspacePath, settingsPath, oldVersion: metadata.oldVersion, bin: args['global-bin-dir'] })
    console.log(`Restored backup ${backup}; restart the original Host yourself.`)
    return
  }
  const yaml = codec(await yamlFor(globalDir))
  const globalConfig = object(yaml.load((await optional(workspacePath)) ?? '{}'), 'global workspace')
  const profileConfig = JSON.parse(await readFile(profilePath, 'utf8'))
  const patch = rows(yaml.load((await optional(patchPath)) ?? '[]'), 'web patch')
  const settingsText = await optional(settingsPath)
  const settings = settingsText === null ? {} : object(yaml.load(settingsText), 'settings')
  const currentVersion = await currentGlobalVersion(globalDir)
  for (const [, filename] of names) if (!existsSync(join(artifacts, filename))) throw new Error(`Missing tarball ${join(artifacts, filename)}`)
  const { target, descriptions } = migrate(settings, patch)
  const backup = join(home, 'backups', `daily-driver-${new Date().toISOString().replaceAll(':', '-')}`)
  console.log(`Mode: ${args.mode}; old DSH: ${currentVersion}; target DSH: 0.1.7-rc.2`)
  console.log(`Global: ${globalDir}; home: ${home}; artifacts: ${artifacts}; backup: ${backup}`)
  console.log(`Overrides: ${names.length}; Web rows: ${patch.length} -> ${target.length}; settings sections: ${descriptions.length}`)
  for (const description of descriptions) console.log(`  ${description}`)
  console.log('Web profile: dependencies={} and bundles=[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]; other profiles and home cordis.patch stay untouched.')
  if (args.mode !== 'apply') return
  if (existsSync(backup)) throw new Error(`Backup exists: ${backup}`)
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
  await mkdir(backup, { mode: 0o700 })
  await cp(profile, join(backup, 'web'), { recursive: true })
  if (existsSync(workspacePath)) await cp(workspacePath, join(backup, 'pnpm-workspace.yaml'))
  if (settingsText !== null) await cp(settingsPath, join(backup, 'settings.yaml'))
  for (const directory of ['sessions', 'storages']) {
    if (existsSync(join(home, directory))) await cp(join(home, directory), join(backup, directory), { recursive: true })
  }
  await writeFile(join(backup, 'backup.json'), JSON.stringify({ home, globalDir, oldVersion: currentVersion, hadWorkspace: existsSync(workspacePath), hadSettings: settingsText !== null }, null, 2) + '\n')
  try {
    const overrides = Object.fromEntries(names.map(([name, filename]) => [name, `file:${join(artifacts, filename)}`]))
    globalConfig.overrides = { ...object(globalConfig.overrides ?? {}, 'global overrides'), ...overrides }
    globalConfig.blockExoticSubdeps = false
    await writeFile(workspacePath, yaml.dump(globalConfig))
    const installArgs = ['--config.enable-global-virtual-store=false', '--ignore-workspace', 'add', '-g', '@deepseek-ai/dsh@0.1.7-rc.2']
    if (args['global-dir']) installArgs.unshift(`--global-dir=${globalDir}`)
    if (args['global-bin-dir']) installArgs.unshift(`--global-bin-dir=${resolve(args['global-bin-dir'])}`)
    command('pnpm', installArgs, { stdio: 'inherit' })
    await rm(profile, { recursive: true })
    await mkdir(profile, { recursive: true })
    profileConfig.dependencies = {}
    profileConfig.dsh = { ...profileConfig.dsh, profile: { ...profileConfig.dsh?.profile, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    await writeFile(profilePath, JSON.stringify(profileConfig, null, 2) + '\n')
    await writeFile(patchPath, yaml.dump(target))
    if (settingsText !== null) await rename(settingsPath, join(backup, 'settings.archived.yaml'))
    console.log(`Installed and migrated Web. Rollback: node scripts/upgrade-daily-driver.mjs --rollback ${backup}${args.home ? ` --home ${home}` : ''}${args['global-dir'] ? ` --global-dir ${globalDir}` : ''}${args['global-bin-dir'] ? ` --global-bin-dir ${resolve(args['global-bin-dir'])}` : ''}`)
  } catch (error) {
    console.error(`Upgrade failed: ${error.message}\nRestore with: node scripts/upgrade-daily-driver.mjs --rollback ${backup} --home ${home} --global-dir ${globalDir}`)
    throw error
  }
}

async function currentGlobalVersion(globalDir) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(globalDir, { withFileTypes: true }))
  const versions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(globalDir, entry.name, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (manifest.dependencies?.['@deepseek-ai/dsh']) versions.push(manifest.dependencies['@deepseek-ai/dsh'])
  }
  if (versions.length !== 1) throw new Error(`Expected one global DSH project, found ${versions.length}`)
  return versions[0]
}

async function restore(backup, paths) {
  const metadata = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))
  const workspaceBackup = join(backup, 'pnpm-workspace.yaml')
  if (metadata.hadWorkspace) await cp(workspaceBackup, paths.workspacePath)
  else await rm(paths.workspacePath, { force: true })
  const installArgs = ['--config.enable-global-virtual-store=false', '--ignore-workspace', 'add', '-g', `@deepseek-ai/dsh@${paths.oldVersion}`]
  if (paths.globalDir) installArgs.unshift(`--global-dir=${paths.globalDir}`)
  if (paths.bin) installArgs.unshift(`--global-bin-dir=${resolve(paths.bin)}`)
  command('pnpm', installArgs, { stdio: 'inherit' })
  await rm(paths.profile, { recursive: true, force: true })
  await cp(join(backup, 'web'), paths.profile, { recursive: true })
  if (metadata.hadSettings) await cp(join(backup, 'settings.yaml'), paths.settingsPath)
  else await rm(paths.settingsPath, { force: true })
}

main().catch(error => { console.error(`Upgrade daily driver: ${error.message}`); process.exitCode = 1 })
