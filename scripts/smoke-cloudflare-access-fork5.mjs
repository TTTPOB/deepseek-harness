/** Verify the installed Access fork package graph and published entries without touching a running Host. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packages = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-client-ui-settings',
]
const version = '0.1.7-rc.2-fork1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, packages.length,
  'Usage: node scripts/smoke-cloudflare-access-fork5.mjs <connection.tgz> <frontend-static.tgz> <gateway.tgz> <ui-settings.tgz>')
const scratch = join(root, 'dist', 'smoke')
await mkdir(scratch, { recursive: true })
const runtime = await mkdtemp(join(scratch, 'cloudflare-access-'))
try {
  for (const tarball of tarballs) await copyFile(tarball, join(runtime, basename(tarball)))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'cloudflare-access-fork5-smoke', private: true, type: 'module', packageManager: 'pnpm@11.24.0',
    dependencies: { '@deepseek-ai/dsh': '0.1.7-rc.2' },
  }, null, 2) + '\n')
  const overrides = packages.map((name, index) => `  '${name}': 'file:./${basename(tarballs[index])}'`).join('\n')
  await writeFile(join(runtime, 'pnpm-workspace.yaml'),
    `packages:\n  - .\nblockExoticSubdeps: false\noverrides:\n${overrides}\n`)
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'install', '--ignore-scripts'], {
    cwd: runtime, stdio: 'inherit', timeout: 600_000,
  })
  const local = createRequire(join(runtime, 'package.json'))
  const cli = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
  const web = createRequire(cli.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
  for (const [anchor, name] of [[local, '@deepseek-ai/dsh'], [cli, '@deepseek-ai/dsh-web-app']]) {
    assert.equal(JSON.parse(await readFile(anchor.resolve(`${name}/package.json`), 'utf8')).version, '0.1.7-rc.2')
  }
  const anchors = new Map()
  const modules = new Map()
  for (const name of packages) {
    const consumer = name === '@deepseek-ai/dsh-api-gateway' ? base : web
    const manifest = await realpath(consumer.resolve(`${name}/package.json`))
    assert.match(manifest, /file\+/)
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(metadata.version, version, name)
    const anchor = createRequire(manifest)
    anchors.set(name, anchor)
    modules.set(name, await import(pathToFileURL(consumer.resolve(name)).href))
    if (metadata.dsh?.client) {
      const client = await readFile(join(dirname(manifest), 'lib/client.js'), 'utf8')
      assert(client.includes('__ModuleLoader__'), `${name} publishes its browser bundle`)
      assert(!client.includes('require("@deepseek-ai/cosmokit")'), `${name} inlines the browser utility dependency`)
      if (name !== '@deepseek-ai/dsh-client-connection') {
        assert(client.includes('canManageHost'), `${name} publishes its management capability consumer`)
      }
    }
    console.log(`Installed ${name}@${version}; imported built Host entry`)
  }
  const connectionAnchor = anchors.get(packages[0])
  const connection = modules.get(packages[0])
  for (const name of [packages[1], packages[2]]) {
    assert.equal(await realpath(anchors.get(name).resolve(packages[0])), await realpath(web.resolve(packages[0])))
    assert.equal(await realpath(anchors.get(name).resolve('@deepseek-ai/cordis')),
      await realpath(connectionAnchor.resolve('@deepseek-ai/cordis')))
  }
  assert.equal(typeof connection.apply, 'function')
  assert.equal(typeof connection.Config, 'function')
  const jose = await import(pathToFileURL(connectionAnchor.resolve('jose')).href)
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256')
  const jwt = await new jose.SignJWT({}).setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://smoke.cloudflareaccess.com').setAudience('smoke-audience')
    .setExpirationTime('1m').sign(privateKey)
  await jose.jwtVerify(jwt, publicKey, { issuer: 'https://smoke.cloudflareaccess.com', audience: 'smoke-audience' })
  await assert.rejects(jose.jwtVerify(jwt, publicKey, { audience: 'wrong-audience' }))
  const { Context } = await import(pathToFileURL(connectionAnchor.resolve('@deepseek-ai/cordis')).href)
  const { default: LocalCredentials } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-credentials-local')).href)
  const issuer = 'https://smoke.cloudflareaccess.com'
  const audience = 'smoke-audience'
  const jwk = await jose.exportJWK(publicKey)
  const originalFetch = globalThis.fetch
  const ctx = new Context()
  try {
    globalThis.fetch = async (input, init) => String(input) === issuer + '/cdn-cgi/access/certs'
      ? Response.json({ keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] })
      : originalFetch(input, init)
    await ctx.plugin(LocalCredentials, { path: join(runtime, 'credentials.yml'), watch: false })
    await ctx.plugin(connection, connection.Config({ trustedHosts: ['remote.example'], cloudflareAccess: { issuer, audience } }))
    const headers = { host: 'remote.example', 'cf-access-jwt-assertion': jwt }
    assert(!('rejection' in await ctx.connection.admitAsync({ headers })))
    assert.equal(ctx.connection.requestRejection({ headers }), 401)
    for (const assertion of ['fake.jwt.token', await new jose.SignJWT({}).setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer).setAudience('wrong-audience').setExpirationTime('1m').sign(privateKey),
      await new jose.SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer)
        .setAudience(audience).setExpirationTime(1).sign(privateKey)]) {
      assert.equal((await ctx.connection.admitAsync({ headers: { ...headers, 'cf-access-jwt-assertion': assertion } })).rejection, 401)
    }
    let status
    let responseHeaders
    const response = { writeHead(code, values) { status = code; responseHeaders = values }, end() {} }
    assert.equal(await ctx.connection.authorizeIndexAsync({ method: 'GET', url: '/', headers }, response), false)
    assert.equal(status, 303)
    assert.equal(responseHeaders.location, './')
    assert(!responseHeaders.location.includes('token'))
    const cookie = responseHeaders['set-cookie'].split(';', 1)[0]
    const page = { method: 'GET', url: '/', headers: { ...headers, cookie } }
    assert.equal(await ctx.connection.authorizeIndexAsync(page, response), true)
    assert.equal(ctx.connection.canManageHost(page), true)
    assert.equal((await ctx.connection.admitAsync({ headers: { host: 'remote.example', cookie } })).rejection, 401)
    const localhost = new URL(ctx.connection.authenticatedUrl('http://localhost'))
    assert.equal(ctx.connection.authorizeIndex({
      method: 'GET', url: localhost.pathname + localhost.search, headers: { host: 'localhost' },
    }, response), false)
    assert.equal(status, 303)
    const localCookie = responseHeaders['set-cookie'].split(';', 1)[0]
    assert(!('rejection' in await ctx.connection.admitAsync({ headers: { host: 'localhost', cookie: localCookie } })))
  } finally {
    await ctx.fiber.dispose()
    globalThis.fetch = originalFetch
  }
  console.log('Access fork smoke passed: installed graph, shared peers, JWT admission, Cookie exchange and localhost fallback')
} finally {
  await rm(runtime, { recursive: true, force: true })
}
