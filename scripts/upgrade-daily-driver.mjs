#!/usr/bin/env node
/** One-time legacy settings/patch migration; package updates belong to dsh-config. */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
    else if (['--home', '--global-dir', '--profile'].includes(flag)) result[flag.slice(2)] = argv[++i]
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
  const profileName = args.profile ?? 'web'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profileName)) throw new Error('Invalid --profile name')
  const profile = join(home, 'profiles', profileName)
  const patchPath = join(profile, 'cordis.patch.yml')
  const settingsPath = join(home, 'settings.yaml')
  const homePatchPath = join(home, 'cordis.patch.yml')
  if (args.mode === 'rollback') {
    const backup = resolve(args.backup)
    const metadata = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))
    if (metadata.home !== home || metadata.globalDir !== globalDir || (metadata.profileName ?? 'web') !== profileName) throw new Error('Backup target differs from --home or --global-dir')
    await restore(backup, { patchPath, settingsPath, homePatchPath })
    console.log(`Restored configuration backup ${backup}; packages and Host were not changed.`)
    return
  }
  const yaml = codec(await yamlFor(globalDir))
  if (!existsSync(patchPath)) throw new Error(`Profile ${profileName} patch does not exist: ${patchPath}`)
  const patch = rows(yaml.load((await optional(patchPath)) ?? '[]'), 'profile patch')
  const homePatchText = await optional(homePatchPath)
  const homePatch = rows(yaml.load(homePatchText ?? '[]'), 'home patch')
  const template = rows(yaml.load(await readFile(join(repository, 'configs/personal/cordis.patch.yml'), 'utf8')), 'shared template')
  const settingsText = await optional(settingsPath)
  const settings = settingsText === null ? {} : object(yaml.load(settingsText), 'settings')
  const { target, descriptions } = profileName === 'web' ? migrate(settings, patch) : { target: structuredClone(patch), descriptions: [] }
  const shared = mergeShared(homePatch, template, target)
  const backup = join(home, 'backups', `daily-driver-${new Date().toISOString().replaceAll(':', '-')}`)
  console.log(`Mode: ${args.mode}; one-time legacy configuration migration; package installation is unchanged`)
  console.log(`Home: ${home}; backup: ${backup}`)
  console.log(`Profile ${profileName} rows: ${patch.length} -> ${shared.profile.length}; home rows: ${homePatch.length} -> ${shared.home.length}; settings sections: ${descriptions.length}`)
  for (const description of descriptions) console.log(`  ${description}`)
  console.log('No packages, manifests, lockfiles, sessions, or storages are changed. Use dsh-config for dependency updates.')
  if (args.mode !== 'apply') return
  if (existsSync(backup)) throw new Error(`Backup exists: ${backup}`)
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 })
  await mkdir(backup, { mode: 0o700 })
  await cp(patchPath, join(backup, 'profile.patch.yml'))
  if (homePatchText !== null) await cp(homePatchPath, join(backup, 'cordis.patch.yml'))
  if (settingsText !== null) await cp(settingsPath, join(backup, 'settings.yaml'))
  await writeFile(join(backup, 'backup.json'), JSON.stringify({ home, globalDir, profileName, hadHomePatch: homePatchText !== null, hadSettings: settingsText !== null }, null, 2) + '\n')
  try {
    await writeFile(patchPath, yaml.dump(shared.profile))
    await writeFile(homePatchPath, yaml.dump(shared.home))
    if (profileName === 'web' && settingsText !== null) await rename(settingsPath, join(backup, 'settings.archived.yaml'))
    console.log(`Migrated legacy configuration. Configuration-only rollback: node scripts/upgrade-daily-driver.mjs --rollback ${backup} --home ${home} --global-dir ${globalDir} --profile ${profileName}`)
  } catch (error) {
    console.error(`Configuration migration failed; restore configuration from ${backup} with --rollback`)
    throw error
  }
}

async function restore(backup, paths) {
  const metadata = JSON.parse(await readFile(join(backup, 'backup.json'), 'utf8'))
  await cp(join(backup, 'profile.patch.yml'), paths.patchPath)
  if (metadata.hadHomePatch) await cp(join(backup, 'cordis.patch.yml'), paths.homePatchPath)
  else await rm(paths.homePatchPath, { force: true })
  if (metadata.hadSettings) await cp(join(backup, 'settings.yaml'), paths.settingsPath)
  else await rm(paths.settingsPath, { force: true })
}

main().catch(error => { console.error(`Legacy configuration migration: ${error.message}`); process.exitCode = 1 })
