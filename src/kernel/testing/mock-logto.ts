// A local stand-in for Logto: serves a JWKS and mints test tokens for any sub and scope.
//
//   GET  /jwks                         -> { keys: [...] }
//   GET  /.well-known/openid-configuration
//   POST /token { sub, scope?, roles?, expiresIn?, claims? } -> { access_token, token_type, expires_in }
//
// No real Logto and no secrets: the key pair is generated fresh on every start.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface MintOptions {
  scopes?: string[];
  roles?: string[];
  // Seconds; negative mints an already-expired token.
  expiresInSec?: number;
  claims?: Record<string, unknown>;
  // Override to mint a token the API must refuse (wrong audience / issuer).
  audience?: string;
  issuer?: string;
}

export interface MockLogto {
  url: string;
  issuer: string;
  jwksUrl: string;
  audience: string;
  mint(sub: string, opts?: MintOptions): Promise<string>;
  stop(): Promise<void>;
}

export async function startMockLogto(opts: { port?: number; audience?: string } = {}): Promise<MockLogto> {
  const audience = opts.audience ?? 'lazytax-api';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'mock-1', alg: 'RS256', use: 'sig' };
  let issuer = '';

  const mint = async (sub: string, o: MintOptions = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: (o.scopes ?? []).join(' '), roles: o.roles ?? [], ...o.claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
      .setSubject(sub)
      .setIssuer(o.issuer ?? issuer)
      .setAudience(o.audience ?? audience)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresInSec ?? 3600))
      .sign(privateKey);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    fetch: async req => {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/jwks') return Response.json({ keys: [jwk] });
      if (req.method === 'GET' && path === '/.well-known/openid-configuration')
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${issuer}/token` });
      if (req.method === 'POST' && path === '/token') {
        const b = (await req.json().catch(() => ({}))) as {
          sub?: string;
          scope?: string;
          roles?: string[];
          expiresIn?: number;
          claims?: Record<string, unknown>;
        };
        if (!b.sub) return Response.json({ error: 'sub is required' }, { status: 400 });
        const expiresIn = b.expiresIn ?? 3600;
        const token = await mint(b.sub, {
          scopes: (b.scope ?? '').split(' ').filter(Boolean),
          roles: b.roles,
          expiresInSec: expiresIn,
          claims: b.claims,
        });
        return Response.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
      }
      return new Response('not found', { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  issuer = url;
  return {
    url,
    issuer,
    jwksUrl: `${url}/jwks`,
    audience,
    mint,
    stop: async () => {
      await server.stop(true);
    },
  };
}
