/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  authorization: Array<string | undefined>
  close: () => Promise<void>
}

/** Start a local stateless MCP endpoint exposing one `ping` tool. */
export async function startHttpMcpFixture(): Promise<HttpMcpFixture> {
  const authorization: Array<string | undefined> = []
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.' }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    return mcp
  })
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk))
      else throw new TypeError('HTTP fixture received an unsupported request chunk')
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    const method = request.method ?? 'GET'
    const init: RequestInit = { method, headers }
    if (chunks.length > 0 && method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks).toString('utf8')
    const webRequest = new Request(`http://${request.headers.host ?? '127.0.0.1'}${request.url ?? '/'}`, init)
    const webResponse = await handler.fetch(webRequest)
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers))
    if (webResponse.body === null) {
      response.end()
      return
    }
    for await (const chunk of webResponse.body as AsyncIterable<Uint8Array>) response.write(chunk)
    response.end()
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}
