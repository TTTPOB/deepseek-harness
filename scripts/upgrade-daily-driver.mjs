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
  ['dsh-progressive-tools', 'dsh-progressive-tools-0.3.0.tgz'],
  ['dsh-workspace-envrc', 'dsh-workspace-envrc-0.2.0.tgz'],
  ['dsh-workspace-overlay', 'dsh-workspace-overlay-0.2.0.tgz'],
  ['@firecrawl/dsh-firecrawl', 'firecrawl-dsh-firecrawl-0.1.0-fork1.tgz'],
  ['@earendil-works/pi-ai@0.85.1-fork1', 'earendil-works-pi-ai-0.85.1-fork1.tgz'],
]
const ordinary = new Set(['dsh-progressive-tools', 'dsh-workspace-envrc', 'dsh-workspace-overlay', '@firecrawl/dsh-firecrawl'])
const managedOverrides = new Set([...names.map(([name]) => name), '@deepseek-ai/dsh-web-app', ...ordinary])
const sharedIds = new Set(['progressive-tools', 'workspace-registry', 'workspace-mcp-manager', 'workspace-agent-integration', 'workspace-envrc', 'workspace-envrc-integration', 'web-fetch-firecrawl', 'mcp-panel', 'preset-standard-ptc'])
const obsoleteRows = new Set(['web-search-firecrawl', 'tool-web'])
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

function pnpm(args, options = {}) {
  try {
    return command('corepack', ['pnpm@11.24.0', '--config.manage-package-manager-versions=false', '--pm-on-fail=ignore', ...args], {
      ...options,
      env: { ...process.env, ...options.env, COREPACK_ENABLE_PROJECT_SPEC: '0' },
    })
  } catch (error) {
    if (error.message.includes('spawnSync corepack ENOENT')) throw new Error('Corepack is required to run pnpm 11.24.0; install or enable Corepack and retry')
    throw error
  }
}

function options(argv) {
  const result = { mode: 'preview' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--apply') result.mode = 'apply'
    else if (flag === '--dry-run') result.mode = 'preview'
    else if (flag === '--rollback') { result.mode = 'rollback'; result.backup = argv[++i] }
    else if (['--home', '--global-dir', '--global-bin-dir', '--artifacts', '--profile'].includes(flag)) result[flag.slice(2)] = argv[++i]
    else throw new Error(`Unknown option: ${flag}`)
    if (flag === '--rollback' && !result.backup) throw new Error('Missing value for --rollback')
    if (flag !== '--apply' && flag !== '--dry-run' && flag !== '--rollback' && !result[flag.slice(2)]) throw new Error(`Missing value for ${flag}`)
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

function mergeShared(homePatch, template, profilePatch) {
  const home = structuredClone(homePatch)
  const profile = structuredClone(profilePatch)
  const existing = new Map()
  for (const row of home) for (const item of row.insert ?? []) {
    if (existing.has(item.id)) throw new Error(`Duplicate home insert id ${item.id}`)
    existing.set(item.id, item)
  }
  const priorHome = new Set(existing.keys())
  const additions = []
  for (const row of template) for (const item of row.insert ?? []) {
    if (!sharedIds.has(item.id)) continue
    if (!existing.has(item.id)) {
      const copy = structuredClone(item)
      additions.push(copy)
      existing.set(copy.id, copy)
    }
  }
  for (let index = profile.length - 1; index >= 0; index--) {
    const row = profile[index]
    if (row.insert) {
      row.insert = row.insert.filter(item => {
        if (!sharedIds.has(item.id)) return true
        const destination = existing.get(item.id)
        if (destination && destination !== item) destination.config = priorHome.has(item.id) ? { ...object(item.config ?? {}, `profile ${item.id}`), ...object(destination.config ?? {}, `shared ${item.id}`) } : { ...object(destination.config ?? {}, `shared ${item.id}`), ...object(item.config ?? {}, `profile ${item.id}`) }
        return false
      })
      if (!row.insert.length) profile.splice(index, 1)
    } else if (sharedIds.has(row.id)) {
      const destination = existing.get(row.id)
      if (row.config) destination.config = priorHome.has(row.id) ? { ...object(row.config, `profile ${row.id}`), ...object(destination.config ?? {}, `shared ${row.id}`) } : { ...object(destination.config ?? {}, `shared ${row.id}`), ...object(row.config, `profile ${row.id}`) }
      if (row.disabled !== undefined && (!priorHome.has(row.id) || destination.disabled === undefined)) destination.disabled = row.disabled
      profile.splice(index, 1)
    }
  }
  if (additions.length) home.push({ insert: additions })
  return { home, profile }
}

async function main() {
  const args = options(process.argv.slice(2))
  const home = resolve(args.home ?? join(homedir(), '.dsh'))
  const globalDir = resolve(args['global-dir'] ?? pnpm(['--ignore-workspace', 'root', '-g']).split('\n').at(-1))
  const artifacts = resolve(args.artifacts ?? join(repository, basename(dirname(repository)) === '.worktrees' ? '../../artifacts/daily-driver-v0.1.7-rc.2-fork1' : '../artifacts/daily-driver-v0.1.7-rc.2-fork1'))
  const profileName = args.profile ?? 'web'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profileName)) throw new Error('Invalid --profile name')
  const profile = join(home, 'profiles', profileName)
  const workspacePath = join(globalDir, 'pnpm-workspace.yaml')
  const profilePath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const settingsPath = join(home, 'settings.yaml')
  const homePatchPath = join(home, 'cordis.patch.yml')
  const pnpmVersion = pnpm(['--version'])
  if (args.mode === 'rollback') {
    const backup = resolve(args.backup)
    const metadata = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))
    if (metadata.home !== home || metadata.globalDir !== globalDir || (metadata.profileName ?? 'web') !== profileName) throw new Error('Backup target differs from --home or --global-dir')
    await restore(backup, { home, globalDir, profile, workspacePath, settingsPath, homePatchPath, oldVersion: metadata.oldVersion, bin: args['global-bin-dir'] })
    console.log(`Restored backup ${backup}; restart the original Host yourself.`)
    return
  }
  const yaml = codec(await yamlFor(globalDir))
  const globalConfig = object(yaml.load((await optional(workspacePath)) ?? '{}'), 'global workspace')
  if (!existsSync(profilePath)) throw new Error(`Profile ${profileName} does not exist: ${profilePath}`)
  const profileConfig = JSON.parse(await readFile(profilePath, 'utf8'))
  const patch = rows(yaml.load((await optional(patchPath)) ?? '[]'), 'profile patch')
  const homePatchText = await optional(homePatchPath)
  const homePatch = rows(yaml.load(homePatchText ?? '[]'), 'home patch')
  const template = rows(yaml.load(await readFile(join(repository, 'configs/personal/cordis.patch.yml'), 'utf8')), 'shared template')
  const settingsText = await optional(settingsPath)
  const settings = settingsText === null ? {} : object(yaml.load(settingsText), 'settings')
  const currentVersion = await currentGlobalVersion(globalDir)
  for (const [, filename] of names) if (!existsSync(join(artifacts, filename))) throw new Error(`Missing tarball ${join(artifacts, filename)}`)
  const { target, descriptions } = profileName === 'web' ? migrate(settings, patch) : { target: structuredClone(patch), descriptions: [] }
  const shared = mergeShared(homePatch, template, target)
  const backup = join(home, 'backups', `daily-driver-${new Date().toISOString().replaceAll(':', '-')}`)
  console.log(`Mode: ${args.mode}; pnpm: ${pnpmVersion}; old DSH: ${currentVersion}; target DSH: 0.1.7-rc.2`)
  console.log(`Global: ${globalDir}; home: ${home}; artifacts: ${artifacts}; backup: ${backup}`)
  console.log(`Overrides: 6; profile ${profileName} rows: ${patch.length} -> ${shared.profile.length}; home rows: ${homePatch.length} -> ${shared.home.length}; settings sections: ${descriptions.length}`)
  for (const description of descriptions) console.log(`  ${description}`)
  console.log('Shared plugins install as ordinary profile dependencies; global patch owns shared rows. Web bundles remain base/web-app; other profile bundles remain unchanged.')
  if (args.mode !== 'apply') return
  if (existsSync(backup)) throw new Error(`Backup exists: ${backup}`)
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
  await mkdir(backup, { mode: 0o700 })
  await cp(profile, join(backup, 'profile'), { recursive: true })
  if (homePatchText !== null) await cp(homePatchPath, join(backup, 'cordis.patch.yml'))
  if (existsSync(workspacePath)) await cp(workspacePath, join(backup, 'pnpm-workspace.yaml'))
  if (settingsText !== null) await cp(settingsPath, join(backup, 'settings.yaml'))
  for (const directory of ['sessions', 'storages']) {
    if (existsSync(join(home, directory))) await cp(join(home, directory), join(backup, directory), { recursive: true })
  }
  await writeFile(join(backup, 'backup.json'), JSON.stringify({ home, globalDir, oldVersion: currentVersion, profileName, hadHomePatch: homePatchText !== null, hadWorkspace: existsSync(workspacePath), hadSettings: settingsText !== null }, null, 2) + '\n')
  try {
    const overrides = Object.fromEntries(names.filter(([name]) => !ordinary.has(name)).map(([name, filename]) => [name, `file:${join(artifacts, filename)}`]))
    globalConfig.overrides = { ...object(globalConfig.overrides ?? {}, 'global overrides') }
    for (const key of managedOverrides) if (!Object.hasOwn(overrides, key)) delete globalConfig.overrides[key]
    Object.assign(globalConfig.overrides, overrides)
    globalConfig.blockExoticSubdeps = false
    await writeFile(workspacePath, yaml.dump(globalConfig))
    const installArgs = ['--config.enable-global-virtual-store=false', '--ignore-workspace', 'add', '-g', '@deepseek-ai/dsh@0.1.7-rc.2']
    if (args['global-dir']) installArgs.unshift(`--config.global-dir=${dirname(globalDir)}`)
    if (args['global-bin-dir']) installArgs.unshift(`--config.global-bin-dir=${resolve(args['global-bin-dir'])}`)
    pnpm(installArgs, { stdio: 'inherit' })
    profileConfig.dependencies = { ...profileConfig.dependencies }
    for (const key of [...managedOverrides, '@earendil-works/pi-ai']) delete profileConfig.dependencies[key]
    for (const [name, filename] of names) if (ordinary.has(name)) profileConfig.dependencies[name] = `file:${join(artifacts, filename)}`
    profileConfig.dependencies['dsh-mcp-panel'] = '0.6.19'
    if (profileName === 'web') profileConfig.dsh = { ...profileConfig.dsh, profile: { ...profileConfig.dsh?.profile, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    await writeFile(profilePath, JSON.stringify(profileConfig, null, 2) + '\n')
    await writeFile(patchPath, yaml.dump(shared.profile))
    await writeFile(homePatchPath, yaml.dump(shared.home))
    pnpm(['--config.auto-install-peers=false', '--ignore-workspace', '--dir', profile, 'install', '--no-frozen-lockfile'], { stdio: 'inherit' })
    if (profileName === 'web' && settingsText !== null) await rename(settingsPath, join(backup, 'settings.archived.yaml'))
    console.log(`Installed and migrated ${profileName}. Rollback: node scripts/upgrade-daily-driver.mjs --rollback ${backup}${args.home ? ` --home ${home}` : ''}${args['global-dir'] ? ` --global-dir ${globalDir}` : ''}${args['global-bin-dir'] ? ` --global-bin-dir ${resolve(args['global-bin-dir'])}` : ''}`)
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
  if (paths.globalDir) installArgs.unshift(`--config.global-dir=${dirname(paths.globalDir)}`)
  if (paths.bin) installArgs.unshift(`--config.global-bin-dir=${resolve(paths.bin)}`)
  pnpm(installArgs, { stdio: 'inherit' })
  await rm(paths.profile, { recursive: true, force: true })
  await cp(join(backup, 'profile'), paths.profile, { recursive: true })
  if (metadata.hadHomePatch) await cp(join(backup, 'cordis.patch.yml'), paths.homePatchPath)
  else await rm(paths.homePatchPath, { force: true })
  if (metadata.hadSettings) await cp(join(backup, 'settings.yaml'), paths.settingsPath)
  else await rm(paths.settingsPath, { force: true })
}

main().catch(error => { console.error(`Upgrade daily driver: ${error.message}`); process.exitCode = 1 })
