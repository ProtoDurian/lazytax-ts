// Layer 1: the bearer JWT, checked with jose against the JWKS URL, issuer and audience pinned.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { unauthenticated } from '../errors';
import { ADMIN_POLICY, type Policy, passes } from './policies';
import { ANONYMOUS, type Principal } from './principal';

export interface Authenticator {
  // No header -> ANONYMOUS. A header that is not a valid token -> throws 401.
  fromHeader(header: string | undefined | null): Promise<Principal>;
}

const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v.split(' ').filter(Boolean);
  return [];
};

function toPrincipal(payload: JWTPayload, admin: Policy = ADMIN_POLICY): Principal {
  const scopes = list(payload.scope ?? payload.scp);
  const roles = list(payload.roles);
  const sub = payload.sub ?? '';
  return Object.freeze({
    sub,
    authenticated: true,
    scopes,
    roles,
    isAdmin: passes(admin, { scopes, roles }),
    claims: Object.freeze({ ...payload }),
  });
}

export function createAuthenticator(opts: {
  jwksUrl: string;
  issuer: string;
  audience: string;
  admin?: Policy;
}): Authenticator {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 1000 });
  return {
    async fromHeader(header) {
      if (header === undefined || header === null || header === '') return ANONYMOUS;
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m?.[1]) throw unauthenticated('The Authorization header must be "Bearer <token>"');
      try {
        const { payload } = await jwtVerify(m[1], jwks, { issuer: opts.issuer, audience: opts.audience });
        if (!payload.sub) throw unauthenticated('The token has no sub');
        return toPrincipal(payload, opts.admin);
      } catch (e) {
        if (e instanceof Error && e.name === 'Problem') throw e;
        throw unauthenticated('The token is not valid');
      }
    },
  };
}
