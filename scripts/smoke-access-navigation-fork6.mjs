/** Exercise paired Access artifacts through the installed official CLI and its real Web Loader. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const names = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-client-ui-settings',
]
const officialVersion = '0.1.7-rc.2'
const versions = names.map((_, index) => `${officialVersion}-fork${index === 3 ? 1 : 2}`)
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, 4,
  'Usage: node scripts/smoke-access-navigation-fork6.mjs <connection-fork2.tgz> <frontend-static-fork2.tgz> <gateway-fork2.tgz> <ui-settings-fork1.tgz>')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(root, 'dist', 'smoke')
await mkdir(scratch, { recursive: true })
const runtime = await mkdtemp(join(scratch, 'access-navigation-fork6-'))
const home = join(runtime, 'home')
const profile = join(home, 'profiles', 'web')
const issuer = 'https://test-team.cloudflareaccess.com'
const audience = 'test-app'
// Do not inherit real Host credentials or another launcher's Node preload.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && !key.startsWith('DSH_')
    && !['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH'].includes(key)))
Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(runtime, 'agents'), DSH_TELEMETRY_DISABLED: '1' })
let child
let completion
let closed = false
let stage = 'installation'

/** Fetch a real loopback HTTP route while retaining the remote ingress authority. */
function get(origin, path, headers) {
  return new Promise((resolveResponse, reject) => {
    const req = request(new URL(path, origin), { method: 'GET', headers, timeout: 15_000 }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        text += chunk
        if (text.length > 16 * 1024 * 1024) req.destroy(new Error('response exceeded smoke bound'))
      })
      res.on('error', reject)
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('timeout', () => req.destroy(new Error('HTTP smoke timed out')))
    req.on('error', reject)
    req.end()
  })
}

try {
  for (const tarball of tarballs) await copyFile(tarball, join(runtime, basename(tarball)))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'access-navigation-fork6-smoke', private: true, type: 'module', packageManager: 'pnpm@11.24.0',
    dependencies: { '@deepseek-ai/dsh': officialVersion },
  }, null, 2) + '\n')
  const overrides = names.map((name, index) => `  '${name}': 'file:./${basename(tarballs[index])}'`).join('\n')
  await writeFile(join(runtime, 'pnpm-workspace.yaml'),
    `packages:\n  - .\nblockExoticSubdeps: false\noverrides:\n${overrides}\n`)
  // The nested project is its own workspace: --ignore-workspace would discard these overrides.
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'install', '--ignore-scripts'], {
    cwd: runtime, env, stdio: 'pipe', timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
  })
  const local = createRequire(join(runtime, 'package.json'))
  const cliManifest = local.resolve('@deepseek-ai/dsh/package.json')
  const cli = createRequire(cliManifest)
  const web = createRequire(cli.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
  for (const [anchor, name] of [[local, '@deepseek-ai/dsh'], [cli, '@deepseek-ai/dsh-web-app']]) {
    assert.equal(JSON.parse(await readFile(anchor.resolve(`${name}/package.json`), 'utf8')).version, officialVersion)
  }
  const anchors = new Map()
  const manifests = new Map()
  for (const [index, name] of names.entries()) {
    const consumer = index === 2 ? base : web
    const manifest = await realpath(consumer.resolve(`${name}/package.json`))
    assert.match(manifest, /file\+/)
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(metadata.version, versions[index], name)
    manifests.set(name, metadata)
    anchors.set(name, createRequire(manifest))
    const loaded = await import(pathToFileURL(consumer.resolve(name)).href)
    assert(Object.keys(loaded).length > 0, `${name} has a built Host entry`)
    if (metadata.dsh?.client) {
      const clientBundle = await readFile(join(dirname(manifest), 'lib/client.js'), 'utf8')
      assert(clientBundle.includes('__ModuleLoader__'), `${name} has a browser bundle`)
      assert(!clientBundle.includes('require("@deepseek-ai/cosmokit")'), `${name} inlines cosmokit`)
    }
  }
  for (const name of names.slice(1)) {
    if (manifests.get(name).peerDependencies?.[names[0]]) {
      assert.equal(await realpath(anchors.get(name).resolve(names[0])), await realpath(web.resolve(names[0])), `${name} shares Connection`)
    }
    assert.equal(await realpath(anchors.get(name).resolve('@deepseek-ai/cordis')),
      await realpath(anchors.get(names[0]).resolve('@deepseek-ai/cordis')), `${name} shares Cordis`)
  }
  stage = 'compatibility'
  const boot = await import(pathToFileURL(cli.resolve('@deepseek-ai/dsh-app-boot')).href)
  assert.equal(boot.getDshRuntimeVersion(), officialVersion)
  const bin = join(dirname(cliManifest), 'lib', 'bin.js')
  await mkdir(profile, { recursive: true })
  // The supported profile manifest selects the shipped bundles; no custom launcher or Loader is used.
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'access-navigation-web-smoke', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  const incompatible = []
  for (const name of names) {
    const issue = boot.evaluatePluginCompatibility(manifests.get(name))
    if (names.slice(1, 3).includes(name)) {
      assert(issue && !issue.exempted, `${name} must require explicit consent, not a widened peer range`)
      assert.equal(issue.peers[names[0]], `${officialVersion}-fork2`)
    }
    if (issue) {
      assert.equal(issue.exempted, false)
      incompatible.push(name)
      execFileSync(process.execPath, [bin, 'plugin', '--profile', 'web', 'allow-version',
        `${name}@${manifests.get(name).version}`, '--dsh-version', officialVersion, '--accept-risk'], {
        cwd: runtime, env, stdio: 'pipe', timeout: 60_000, maxBuffer: 1024 * 1024,
      })
    }
  }
  const exemptions = JSON.parse(await readFile(join(profile, 'compatibility.json'), 'utf8'))
  assert.deepEqual(Object.keys(exemptions).sort(), incompatible.map(name => `${name}@${manifests.get(name).version}`).sort())
  for (const name of names) {
    const issue = boot.evaluatePluginCompatibility(manifests.get(name), exemptions)
    assert(!issue || issue.exempted, `${name} is admitted with the saved exact exemption`)
    if (issue) {
      assert.equal(boot.evaluatePluginCompatibility(manifests.get(name), { [`${name}@9.9.9`]: [officialVersion] }).exempted, false)
      assert.equal(boot.evaluatePluginCompatibility(manifests.get(name), { [`${name}@${manifests.get(name).version}`]: ['9.9.9'] }).exempted, false)
    }
  }
  const jose = await import(pathToFileURL(anchors.get(names[0]).resolve('jose')).href)
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256')
  const jwt = await new jose.SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'fork6-smoke' })
    .setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(privateKey)
  const jwk = { ...await jose.exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'fork6-smoke' }
  const preload = join(runtime, 'jwks-preload.mjs')
  await writeFile(preload, `const original = globalThis.fetch\nconst endpoint = ${JSON.stringify(issuer + '/cdn-cgi/access/certs')}\nglobalThis.fetch = (input, init) => {\n  const url = input instanceof Request ? input.url : String(input)\n  return url === endpoint ? Promise.resolve(Response.json({ keys: [${JSON.stringify(jwk)}] })) : original(input, init)\n}\n`)
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{
    id: 'connection', config: { trustedHosts: ['remote.example'], cloudflareAccess: { issuer, audience } },
  }]) + '\n')
  stage = 'cold CLI startup'
  child = spawn(process.execPath, ['--import', preload, bin, '--profile', 'web',
    '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] })
  completion = new Promise(resolveExit => {
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }) })
  })
  const launchUrl = await new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('official CLI did not announce readiness within 90s')), 90_000)
    const stop = () => clearTimeout(timer)
    child.once('error', () => { stop(); reject(new Error('official CLI spawn failed')) })
    child.once('close', (code, signal) => { stop(); reject(new Error(`official CLI exited before readiness (code ${code}, signal ${signal})`)) })
    const collect = chunk => {
      // Logs may contain the launch token; retain only a bounded in-memory window and never report it.
      output = (output + chunk.toString()).slice(-64 * 1024)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/.exec(output)
      if (match) { stop(); resolveReady(new URL(match[1])); output = '' }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
  })
  const origin = launchUrl.origin
  stage = 'HTTP navigation and runtime module graph'
  const headers = { host: 'remote.example', 'cf-access-jwt-assertion': jwt,
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' }
  const login = await get(origin, '/', headers)
  assert.equal(login.status, 200, 'first valid cross-site Access document navigation renders without a DSH Cookie')
  assert.equal(login.headers['set-cookie'], undefined, 'Access navigation does not mint a DSH Cookie')
  const page = await get(origin, '/', headers)
  assert.equal(page.status, 200, 'repeated cross-site navigation needs no SameSite=Strict Cookie')
  assert.equal(page.headers['set-cookie'], undefined)
  const cleaned = await get(origin, '/?token=stale-launch-token', headers)
  assert.equal(cleaned.status, 303, 'Access navigation removes an old token query once')
  assert.equal(cleaned.headers.location, './')
  assert.equal(cleaned.headers['set-cookie'], undefined)
  assert.equal((await get(origin, cleaned.headers.location, headers)).status, 200)
  const management = /window\.__DSH_CAN_MANAGE_HOST__=(true|false)<\/script>/u.exec(page.text)?.[1]
  assert.equal(management && JSON.parse(management), true, 'Access page grants canManageHost')
  const rawBoot = /globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/u.exec(page.text)?.[1]
  assert(rawBoot, 'actual Web page injects __DSH_BOOT__')
  const graph = JSON.parse(rawBoot)
  const required = [names[0], names[2], names[3],
    '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-job-controller',
    '@deepseek-ai/dsh-api-terminal-controller', '@deepseek-ai/dsh-api-workspace-controller']
  for (const name of required) {
    const row = graph.entries.find(entry => entry.id === name)
    assert(row, `${name} is not runtime-disabled or missing from __DSH_BOOT__`)
    const module = await get(origin, row.url, { host: 'remote.example', 'cf-access-jwt-assertion': jwt,
      'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'script', 'sec-fetch-site': 'same-origin' })
    assert.equal(module.status, 200, `${name} advertised module URL is served`)
    assert(module.text.includes('__ModuleLoader__'), `${name} URL contains a real browser bundle`)
  }
  const api = await get(origin, '/api/smoke-navigation-fence', headers)
  assert.equal(api.status, 403, 'valid Access JWT never bypasses the API cross-site fence')
  const rejected = await get(origin, '/', { ...headers, 'cf-access-jwt-assertion': 'fake.jwt.token' })
  assert.equal(rejected.status, 401, 'invalid Access JWT cannot enter the root page')
  const localLogin = await get(origin, launchUrl.pathname + launchUrl.search, { host: launchUrl.host })
  assert.equal(localLogin.status, 303, 'localhost retains token-to-Cookie login')
  const localCookie = localLogin.headers['set-cookie']?.[0]?.split(';', 1)[0]
  assert(localCookie, 'localhost login still sets a Cookie')
  assert.equal((await get(origin, '/', { host: launchUrl.host, cookie: localCookie })).status, 200)
  console.log('fork6 smoke passed: actual overrides/shared peers, exact CLI exemptions, cold official Web Loader, cookieless Access navigation, localhost Cookie fallback, API fence and served controller graph')
} catch (error) {
  // Do not print child output, command objects, request headers, assertion values, or URLs containing tokens.
  console.error(`fork6 smoke failed during ${stage}: ${error instanceof assert.AssertionError ? 'acceptance assertion failed (' + error.message.split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]') + ')' : 'operation failed or timed out'}`)
  process.exitCode = 1
} finally {
  if (child && !closed) {
    child.kill('SIGTERM')
    let timer
    await Promise.race([completion, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, 10_000) })])
    clearTimeout(timer)
    if (!closed) { child.kill('SIGKILL'); await completion }
  }
  await rm(runtime, { recursive: true, force: true })
}
