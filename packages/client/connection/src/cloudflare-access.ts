/** Verification of the optional Cloudflare Access browser ingress. */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { ConnectionTrustRequest } from './rpc.ts'

/** Deployment-selected Cloudflare Access application. */
export interface CloudflareAccessConfig {
  /** Official team issuer, for example https://team.cloudflareaccess.com. */
  issuer: string
  /** Application audience tag from Cloudflare Access. */
  audience: string
}

/** Request-local JWT verification; JWKS fetching and caching are owned by jose. */
export class CloudflareAccess {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>

  /** @param config - configured team issuer and application audience. */
  constructor(private readonly config: CloudflareAccessConfig) {
    const issuer = new URL(config.issuer)
    if (issuer.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(issuer.hostname)
      || issuer.port !== '' || issuer.pathname !== '/' || issuer.search !== '' || issuer.hash !== ''
      || issuer.username !== '' || issuer.password !== '' || issuer.origin !== config.issuer
      || config.audience.trim() === '') {
      throw new Error('client-connection: Cloudflare Access requires an official HTTPS team issuer and application audience')
    }
    this.keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer))
  }

  /**
   * Verify the assertion forwarded by Cloudflare, never the browser's identity headers.
   * @param request - request carrying Cf-Access-Jwt-Assertion.
   * @returns expiry in milliseconds for a valid assertion, otherwise undefined.
   */
  async verify(request: ConnectionTrustRequest): Promise<number | undefined> {
    const headers = request.headers
    const token = headers instanceof Headers
      ? headers.get('cf-access-jwt-assertion')
      : headers['cf-access-jwt-assertion']
    if (typeof token !== 'string' || token.length === 0) return undefined
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      })
      return payload.exp === undefined ? undefined : payload.exp * 1000
    } catch (_error) {
      // Invalid assertions and unavailable signing keys both refuse admission.
      return undefined
    }
  }
}
