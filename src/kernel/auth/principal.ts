// Who is calling. Built by the kernel from a verified JWT (layer 1).

export interface Principal {
  // JWT `sub`. Empty only on a `public` route called without a token.
  readonly sub: string;
  readonly authenticated: boolean;
  // `scope` claim split on spaces (Logto sends a string), and the `roles` claim.
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  // True when the `admin` policy passes for this principal.
  readonly isAdmin: boolean;
  // Every verified claim of the token (e.g. username, email, email_verified). Never log it.
  readonly claims?: Readonly<Record<string, unknown>>;
}

export const ANONYMOUS: Principal = Object.freeze({
  sub: '',
  authenticated: false,
  scopes: [],
  roles: [],
  isAdmin: false,
});
