// Domain errors and their problem-details JSON (RFC 9457).
//
// The status mapping copies LazyTax's App/Modules/Common/BaseController.cs:
//   not_found 404, validation 400, unauthorized 403, unauthenticated 401, conflict 409,
//   precondition 412. Anything else that is thrown is a 500 with no detail.

export type ProblemKind = 'not_found' | 'validation' | 'unauthorized' | 'unauthenticated' | 'conflict' | 'precondition';

const STATUS: Record<ProblemKind, number> = {
  not_found: 404,
  validation: 400,
  unauthorized: 403,
  unauthenticated: 401,
  conflict: 409,
  precondition: 412,
};

export interface ProblemInit {
  kind: ProblemKind;
  // Stable machine id, e.g. "entity_not_found", "tier_insufficient". Becomes the problem type.
  id: string;
  title: string;
  detail: string;
  // Extra, non-secret fields for the client (LazyTax puts these under "data").
  data?: Record<string, unknown>;
}

export class Problem extends Error {
  readonly kind: ProblemKind;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly data: Record<string, unknown>;

  constructor(init: ProblemInit) {
    super(init.detail);
    this.name = 'Problem';
    this.kind = init.kind;
    this.id = init.id;
    this.title = init.title;
    this.detail = init.detail;
    this.data = init.data ?? {};
  }

  get status(): number {
    return STATUS[this.kind];
  }
}

// ── The common problems. Contexts add their own with `new Problem({...})`. ────────────────────

export const notFound = (entity: string, id: string) =>
  new Problem({
    kind: 'not_found',
    id: 'entity_not_found',
    title: 'Entity Not Found',
    detail: `${entity} Not Found`,
    data: { entity, requestIdentifier: id },
  });

export const validationFailed = (detail: string, errors: Record<string, string[]>) =>
  new Problem({ kind: 'validation', id: 'validation_error', title: 'Validation Error', detail, data: { errors } });

export const unauthorized = (detail = 'You are not authorized to access this resource') =>
  new Problem({ kind: 'unauthorized', id: 'unauthorized', title: 'Unauthorized', detail });

export const unauthenticated = (detail = 'You are not authenticated') =>
  new Problem({ kind: 'unauthenticated', id: 'unauthenticated', title: 'Unauthenticated', detail });

export const conflict = (id: string, detail: string, data?: Record<string, unknown>) =>
  new Problem({ kind: 'conflict', id, title: 'Conflict', detail, data });

export const preconditionFailed = (id: string, detail: string, data?: Record<string, unknown>) =>
  new Problem({ kind: 'precondition', id, title: 'Precondition Failed', detail, data });

// The user's advisory lock timed out (LazyTax UserBusyException -> 409).
export const userBusy = (userId: string) =>
  new Problem({
    kind: 'conflict',
    id: 'user_busy',
    title: 'User Busy',
    detail: 'Another request for this user is still running; try again',
    data: { userId },
  });

export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId: string;
  data: Record<string, unknown>;
}

export const problemType = (id: string) => `urn:lazytax:problem:${id}`;

export function toProblemJson(err: unknown, requestId: string, instance?: string): ProblemJson {
  if (err instanceof Problem) {
    return {
      type: problemType(err.id),
      title: err.title,
      status: err.status,
      detail: err.detail,
      instance,
      requestId,
      data: err.data,
    };
  }
  return {
    type: problemType('internal_error'),
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred',
    instance,
    requestId,
    data: {},
  };
}
