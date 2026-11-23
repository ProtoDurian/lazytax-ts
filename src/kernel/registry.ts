// The typed registries. They start empty; each context's contract package fills them in with a
// module augmentation, so `deps.get("plan.v1")` and `outbox.add({ type: "vacation.created", ... })`
// are typed with no casts:
//
//   declare module '@lazytax/kernel' {
//     interface ContractRegistry { 'plan.v1': PlanV1 }
//     interface EventRegistry { 'vacation.created': { userId: string; vacationId: string } }
//   }
//
// Account deletion needs no registry: contexts register the kernel user hooks
// (deleteGuard, beforePurge, purgeUser) in defineContext's `users`.

// Contract id ("<context>.v<N>") -> the interface the providing context implements.
// biome-ignore lint/suspicious/noEmptyInterface: filled in by contract packages
export interface ContractRegistry {}

// Outbox event type ("<context>.<event>") -> its payload.
// biome-ignore lint/suspicious/noEmptyInterface: filled in by contract packages
export interface EventRegistry {}

export type ContractId = keyof ContractRegistry & string;
export type EventType = keyof EventRegistry & string;
