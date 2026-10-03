/** Access ingress through a real Loader, HTTP carrier and durable settings provider. */
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '../../../api/gateway/src/index.ts'
import type { Duplex } from 'node:stream'
import * as FrontendStatic from '../../../host/frontend-static/src/index.ts'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import yaml from 'js-yaml'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'
import { CloudflareAccess } from '../src/cloudflare-access.ts'
import { BrowserAuth } from '../src/browser-auth.ts'

const issuer = 'https://test-team.cloudflareaccess.com'
const audience = 'test-app'
let ctx: Context | undefined
let home: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  ctx = undefined
  home = undefined
  vi.unstubAllGlobals()
})

async function keys() {
  const pair = await generateKeyPair('RS256')
  const jwk = await exportJWK(pair.publicKey)
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === `${issuer}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
    }
    return originalFetch(input, init)
  }))
  return async (options: { aud?: string; iss?: string; exp?: number; signed?: boolean; noExpiry?: boolean } = {}) => {
    const key = options.signed === false ? (await generateKeyPair('RS256')).privateKey : pair.privateKey
    let token = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.iss ?? issuer).setAudience(options.aud ?? audience)
    if (!options.noExpiry) token = token.setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 300)
    return token.sign(key)
  }
}

async function load(access = true) {
  home = await mkdtemp(join(tmpdir(), 'dsh-access-'))
  const config = join(home, 'base.yml')
  const index = join(home, 'index.html')
  await writeFile(index, '<head></head><body>shell</body>')
  await writeFile(config, [
    '- id: credentials', '  name: credentials', '  config:', `    path: ${join(home, 'credentials.yml')}`, '    watch: false',
    '- id: server', '  name: server', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- id: connection', '  name: connection', '  config:', '    trustedHosts: [remote.example]',
    ...(access ? ['    cloudflareAccess:', `      issuer: ${issuer}`, `      audience: ${audience}`] : []),
    '- id: frontend', '  name: frontend', '  config:', `    distIndex: ${index}`,
    '- id: typert', '  name: typert', '- id: gateway', '  name: gateway',
    '- id: probe', '  name: probe',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const probe = {
    inject: ['connection', 'settings', 'webServer'],
    Config: z.object({ enabled: z.boolean().default(false).volatile() }),
    apply(owner: Context) {
      owner.connection.fetch.register({
        path: '/api/persist', methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          const payload: unknown = await request.json()
          if (typeof payload !== 'object' || payload === null) return new Response('invalid', { status: 400 })
          await owner.settings.update('probe', payload, undefined)
          return Response.json({ saved: true })
        },
      })
    },
  }
  const modules = new Map<string, object>([
    ['credentials', LocalCredentials], ['server', HttpServer], ['connection', Connection],
    ['frontend', FrontendStatic], ['probe', probe], ['typert', TypertRegistry], ['gateway', Gateway],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    const module = modules.get(name)
    if (module === undefined) throw new Error(`unexpected module ${name}`)
    return module
  } }
  const dir = join(home, 'profile')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), yaml.dump([{ insert: yaml.load(await readFile(config, 'utf8')) }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  const patch = profile.patchPath
  expect(ctx.get('connection')).toBeDefined()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { host: ctx, patch }
}

async function request(port: number, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

function cookie(response: Awaited<ReturnType<typeof request>>): string {
  const value = response.headers['set-cookie']?.[0]?.split(';', 1)[0]
  if (value === undefined) throw new Error('missing browser cookie')
  return value
}

async function upgrade(port: number, token?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; socket?: Duplex }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/remote.mux', headers: {
      host: 'remote.example', connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...(token === undefined ? {} : { 'cf-access-jwt-assertion': token }),
      ...headers,
    } })
    request.on('upgrade', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }))
    request.on('response', (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }) })
    request.on('error', reject)
    request.end()
  })
}

describe('Cloudflare Access', () => {
  it('rejects incomplete and non-official deployment configuration', () => {
    expect(Connection.Config({}).cloudflareAccess).toBeUndefined()
    for (const value of [undefined, 'http://team.cloudflareaccess.com', 'https://evil.example', issuer + '/path', issuer + '/']) {
      expect(() => new CloudflareAccess({ issuer: value as string, audience })).toThrow()
    }
    expect(() => new CloudflareAccess({ issuer, audience: '' })).toThrow()
    expect(() => Connection.Config({ cloudflareAccess: { issuer } } as never)).toThrow()
  })

  it('verifies signatures, issuer, audience and mandatory expiry with jose', async () => {
    const sign = await keys()
    const verifier = new CloudflareAccess({ issuer, audience })
    expect(await verifier.verify({ headers: { 'cf-access-jwt-assertion': await sign() } })).toBeGreaterThan(Date.now())
    for (const token of ['fake.jwt.token', await sign({ signed: false }), await sign({ aud: 'wrong' }),
      await sign({ iss: 'https://wrong.cloudflareaccess.com' }), await sign({ exp: 1 }), await sign({ noExpiry: true })]) {
      expect(await verifier.verify({ headers: new Headers({ 'cf-access-jwt-assertion': token }) })).toBeUndefined()
    }
    expect(await verifier.verify({ headers: {} })).toBeUndefined()
  })

  it('automatically logs in, persists remote settings, and rejects cookie-only remote requests', async () => {
    const sign = await keys()
    const token = await sign()
    const { host, patch } = await load()
    const port = host.webServer.port
    const headers = { host: 'remote.example', 'cf-access-jwt-assertion': token }
    const authenticated = headers
    const page = await request(port, '/', authenticated)
    expect(page.status).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['set-cookie']).toBeUndefined()
    expect(page.body).toContain('window.__DSH_CAN_MANAGE_HOST__=true')
    expect(page.body).not.toContain(new URL(host.connection.authenticatedUrl('https://remote.example')).searchParams.get('token'))
    // A signed cookie from token login before Access was enabled cannot replace the JWT.
    const legacyAuth = await BrowserAuth.create(host, host.credentials, 30)
    const legacyLaunch = new URL(legacyAuth.authenticatedUrl('https://remote.example'))
    let legacyCookie = ''
    legacyAuth.authorizeIndex({ method: 'GET', url: legacyLaunch.pathname + legacyLaunch.search, headers: { host: 'remote.example' } }, {
      writeHead(_status, responseHeaders) { legacyCookie = responseHeaders?.['set-cookie']?.split(';', 1)[0] ?? '' },
      end: vi.fn(),
    })
    const cookieOnly = { host: 'remote.example', cookie: legacyCookie }
    expect(legacyAuth.isAuthenticated({ headers: cookieOnly })).toBe(true)
    expect(await request(port, '/', cookieOnly)).toMatchObject({ status: 401 })
    expect(await request(port, '/api/persist', { ...cookieOnly, 'content-type': 'application/json' }, '{}')).toMatchObject({ status: 401 })
    const payload = JSON.stringify({ enabled: true })
    const writeHeaders = { ...authenticated, 'content-type': 'application/json', origin: 'https://remote.example' }
    expect(await request(port, '/api/persist', writeHeaders, payload)).toMatchObject({ status: 200, body: '{"saved":true}' })
    expect(await readFile(patch, 'utf8')).toContain('enabled: true')
    const before = await readFile(patch, 'utf8')
    expect(await request(port, '/api/persist', { ...writeHeaders, 'cf-access-jwt-assertion': 'fake' }, payload)).toMatchObject({ status: 401 })
    expect(await readFile(patch, 'utf8')).toBe(before)
    expect(await request(port, '/api/settings.update', { ...writeHeaders, 'cf-access-jwt-assertion': '' }, payload)).toMatchObject({ status: 401 })
    expect(await request(port, '/api/settings.update', { ...writeHeaders, origin: 'https://evil.example' }, payload)).toMatchObject({ status: 403 })
    const remoteLaunch = new URL(host.connection.authenticatedUrl('https://remote.example'))
    expect(await request(port, remoteLaunch.pathname + remoteLaunch.search, { host: 'remote.example' })).toMatchObject({ status: 401 })
    expect(host.connection.requestRejection({ headers: authenticated })).toBe(401)
    expect(host.connection.canManageHost({ headers: authenticated })).toBe(false)
    await host.fiber.dispose()
    ctx = undefined
    expect(host.get('connection')).toBeUndefined()
  })

  it.each([undefined, issuer, 'https://remote.example', 'null'])('allows Access document navigation with Origin=%s without admitting cross-site API or WS', async (origin) => {
    const sign = await keys()
    const token = await sign()
    const { host, patch } = await load()
    const port = host.webServer.port
    const navigation = {
      host: 'remote.example', 'cf-access-jwt-assertion': token,
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
      ...(origin === undefined ? {} : { origin }),
    }
    const firstPage = await request(port, '/', navigation)
    expect(firstPage.status).toBe(200)
    expect(firstPage.headers['set-cookie']).toBeUndefined()
    expect(firstPage.headers['cache-control']).toBe('no-store')
    expect(firstPage.body).toContain('window.__DSH_CAN_MANAGE_HOST__=true')
    const authenticated = navigation
    // Repeated navigation and the configured index render even when no DSH cookie is sent.
    for (const path of ['/', '/index.html']) {
      const page = await request(port, path, authenticated)
      expect(page.status).toBe(200)
      expect(page.body).toContain('window.__DSH_CAN_MANAGE_HOST__=true')
      expect(page.headers['set-cookie']).toBeUndefined()
    }
    const launch = new URL(host.connection.authenticatedUrl('https://remote.example'))
    for (const query of [launch.search, '?token=obsolete&token=duplicate']) {
      const cleaned = await request(port, '/' + query, navigation)
      expect(cleaned.status).toBe(303)
      expect(cleaned.headers.location).toBe('./')
      expect(cleaned.headers['set-cookie']).toBeUndefined()
      expect(cleaned.headers['referrer-policy']).toBe('no-referrer')
      expect(await request(port, '/', navigation)).toMatchObject({ status: 200 })
    }
    const before = await readFile(patch, 'utf8')
    const payload = JSON.stringify({ enabled: true })
    expect(await request(port, '/api/persist', {
      ...authenticated, 'content-type': 'application/json',
    }, payload)).toMatchObject({ status: 403 })
    // Navigation markers do not make a GET to the API or an upgrade a page request.
    expect(await request(port, '/api/settings.update', authenticated)).toMatchObject({ status: 403 })
    expect(await upgrade(port, token, authenticated)).toMatchObject({ status: 403 })
    expect(await readFile(patch, 'utf8')).toBe(before)
    const sameOrigin = {
      ...authenticated, origin: 'https://remote.example', 'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json',
    }
    expect(await request(port, '/api/persist', sameOrigin, payload)).toMatchObject({ status: 200 })
    expect(await readFile(patch, 'utf8')).toContain('enabled: true')
  })

  it('keeps Access index Host, JWT and navigation requirements and synchronous refusal', async () => {
    const sign = await keys()
    const { host } = await load()
    const port = host.webServer.port
    const navigation = {
      host: 'remote.example', 'cf-access-jwt-assertion': await sign(),
      'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    }
    expect(await request(port, '/', { ...navigation, host: 'evil.example' })).toMatchObject({ status: 403 })
    for (const token of ['', 'fake.jwt.token', await sign({ signed: false }), await sign({ exp: 1 })]) {
      const response = await request(port, '/', { ...navigation, 'cf-access-jwt-assertion': token })
      expect(response.status).toBe(401)
      expect(response.headers['set-cookie']).toBeUndefined()
    }
    for (const markers of [
      { 'sec-fetch-mode': '', 'sec-fetch-dest': '' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'document' },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    ]) {
      expect(await request(port, '/', { ...navigation, ...markers })).toMatchObject({ status: 403 })
    }
    expect(await request(port, '/', navigation, 'body')).toMatchObject({ status: 405 })
    const indexRequest = { method: 'GET', url: '/', headers: navigation }
    const response = { writeHead: vi.fn(), end: vi.fn() }
    expect(host.connection.authorizeIndex(indexRequest, response)).toBe(false)
    expect(response.writeHead).toHaveBeenCalledWith(401, { 'cache-control': 'no-store' })
    expect(host.connection.admit(indexRequest)).toMatchObject({ rejection: 403 })
    expect(host.connection.canManageHost(indexRequest)).toBe(false)
    expect(await host.connection.authorizeIndexAsync(indexRequest, response)).toBe(true)
    expect(host.connection.canManageHost(indexRequest)).toBe(true)
    expect(await host.connection.admitAsync(indexRequest)).toMatchObject({ rejection: 403 })
    expect(await host.connection.authorizeIndexAsync({ ...indexRequest, method: 'HEAD' }, response)).toBe(false)
    expect(response.writeHead).toHaveBeenLastCalledWith(403, { 'cache-control': 'no-store' })
  })

  it('requires Access for WebSocket admission and closes the socket at assertion expiry', async () => {
    const sign = await keys()
    const { host } = await load()
    expect(await upgrade(host.webServer.port)).toMatchObject({ status: 401 })
    expect(await upgrade(host.webServer.port, 'fake')).toMatchObject({ status: 401 })
    const expiry = Math.floor(Date.now() / 1000) + 2
    const accepted = await upgrade(host.webServer.port, await sign({ exp: expiry }))
    expect(accepted.status).toBe(101)
    const socket = accepted.socket
    if (socket === undefined) throw new Error('upgrade did not retain a socket')
    socket.resume()
    await new Promise<void>((resolve) => { socket.once('close', resolve) })
    expect(Date.now()).toBeGreaterThanOrEqual(expiry * 1000)
    expect(await upgrade(host.webServer.port, await sign({ exp: expiry }))).toMatchObject({ status: 401 })
  })

  it.each([false, true])('preserves localhost token login (Access enabled=%s)', async (access) => {
    const { host } = await load(access)
    const port = host.webServer.port
    const authorities = [`127.0.0.1:${String(port)}`, ...access ? [] : ['remote.example']]
    for (const authority of authorities) {
      const launch = new URL(host.connection.authenticatedUrl(`http://${authority}`))
      const exchange = await request(port, launch.pathname + launch.search, { host: authority })
      expect(exchange.status).toBe(303)
      const page = await request(port, '/', { host: authority, cookie: cookie(exchange) })
      expect(page.status).toBe(200)
      expect(page.body).toContain(`window.__DSH_CAN_MANAGE_HOST__=${String(authority !== 'remote.example')}`)
    }
  })
})
