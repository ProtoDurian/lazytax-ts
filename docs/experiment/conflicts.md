# Conflict log

One table per language, same 4 columns, so the two compare. Bun only; the .NET table lives in ProtoDurian/lazytax-dotnet.

## Bun

| File                                                                                                       | Kind     | Minutes | Tokens |
| ---------------------------------------------------------------------------------------------------------- | -------- | ------- | ------ |
| charity: (none)                                                                                            | clean    | 1       | 500    |
| charity: (none)                                                                                            | clean    | 1       | 500    |
| charity: (none)                                                                                            | clean    | 1       | 500    |
| check: (none)                                                                                              | clean    | 0       | 0      |
| check: src/kernel/db/migrate.ts                                                                            | kernel   | 6       | 9000   |
| check: (none)                                                                                              | clean    | 1       | 1500   |
| check: (none)                                                                                              | clean    | 0       | 300    |
| check: (none)                                                                                              | clean    | 0       | 400    |
| check: (none)                                                                                              | clean    | 0       | 400    |
| check: (none)                                                                                              | clean    | 0       | 400    |
| check: (none)                                                                                              | clean    | 0       | 400    |
| check: (none)                                                                                              | clean    | 0       | 400    |
| check: (none)                                                                                              | clean    | 0       | 300    |
| check: (none)                                                                                              | clean    | 0       | 300    |
| check: contexts/check/tests/sit (vs proof, protection SIT)                                                 | test     | 25      | 30000  |
| disbursement: bun.lock                                                                                     | lock     | 3       | 2000   |
| disbursement: bun.lock                                                                                     | lock     | 2       | 1500   |
| disbursement: bun.lock                                                                                     | lock     | 2       | 1200   |
| friend: bun.lock                                                                                           | lock     | 2       | 1500   |
| friend: bun.lock                                                                                           | lock     | 2       | 1500   |
| friend: (none)                                                                                             | clean    | 0       | 0      |
| friend: (none)                                                                                             | clean    | 0       | 0      |
| friend: (none)                                                                                             | clean    | 0       | 0      |
| friend: (none)                                                                                             | clean    | 0       | 0      |
| friend: (none)                                                                                             | clean    | 0       | 0      |
| habit: bun.lock                                                                                            | lock     | 2       | 1500   |
| habit: (merge 1: kernel boot)                                                                              | clean    | 0       | 0      |
| habit: bun.lock                                                                                            | lock     | 2       | 1500   |
| habit: (merge 3: main 7e7ebcf)                                                                             | clean    | 0       | 0      |
| habit: quota race test vs uow snapshot-before-lock                                                         | kernel   | 10      | 3000   |
| habit: (merge 4-6: main through c703c92)                                                                   | clean    | 0       | 0      |
| habit: (merge 7-9: main through 279a139)                                                                   | clean    | 0       | 0      |
| lead: charity contract: (none; gitlint refused merge title)                                                | clean    | 1       | 2000   |
| lead: notification contract: bun.lock                                                                      | lock     | 0.2     | 1500   |
| lead: habit contract: bun.lock                                                                             | lock     | 0.2     | 500    |
| lead: check contract: bun.lock                                                                             | lock     | 0.2     | 500    |
| lead: proof contract: bun.lock                                                                             | lock     | 0.2     | 500    |
| lead: friend contract: bun.lock                                                                            | lock     | 0.2     | 500    |
| lead: payment contract: bun.lock                                                                           | lock     | 0.2     | 500    |
| lead: penalty contract: bun.lock                                                                           | lock     | 0.2     | 500    |
| lead: disbursement contract: bun.lock                                                                      | lock     | 0.2     | 500    |
| lead: merge kernel: (none)                                                                                 | clean    | 0       | 0      |
| lead: merge protection: (none)                                                                             | clean    | 0       | 0      |
| lead: merge sit-ci: (none)                                                                                 | clean    | 0       | 0      |
| lead: merge kernel 228e0c3: (none)                                                                         | clean    | 0       | 0      |
| lead: merge disbursement: (none; stale node_modules until bun install)                                     | clean    | 1       | 1500   |
| lead: merge check 8a88c57: (none)                                                                          | clean    | 0       | 0      |
| lead: merge sit-ci 4035864: (none)                                                                         | clean    | 0       | 0      |
| lead: merge habit 2649cd7: (none)                                                                          | clean    | 0       | 0      |
| lead: merge protection 7574a8e: (none)                                                                     | clean    | 0       | 0      |
| lead: merge friend bcf8f24: (none)                                                                         | clean    | 0       | 0      |
| lead: merge kernel fa526ac: (none)                                                                         | clean    | 0       | 0      |
| lead: merge penalty fc682a4: (none)                                                                        | clean    | 0       | 0      |
| lead: merge proof 260622c: (none)                                                                          | clean    | 0       | 0      |
| lead: merge charity: (squash for 1 unsigned merge; knip hook on kernel exports, skipped)                   | text     | 1       | 3000   |
| lead: merge kernel 277f028: (none)                                                                         | clean    | 0       | 0      |
| lead: merge notification: (squash for 1 unsigned merge; builder ended)                                     | text     | 2       | 4000   |
| lead: merge habit 0fc5e71: (none)                                                                          | clean    | 0       | 0      |
| lead: merge kernel f21a674: (none)                                                                         | clean    | 0       | 0      |
| lead: merge check f4f6235: (none)                                                                          | clean    | 0       | 0      |
| lead: merge habit 9386b2f: (none)                                                                          | clean    | 0       | 0      |
| lead: merge payment 4e26e0e: (none)                                                                        | clean    | 0       | 0      |
| lead: merge check c01898e: (none)                                                                          | clean    | 0       | 0      |
| lead: merge friend 866c5df: (none)                                                                         | clean    | 0       | 0      |
| lead: merge habit eb54704: (none)                                                                          | clean    | 0       | 0      |
| lead: merge notification 2dd75f6: (none)                                                                   | clean    | 0       | 0      |
| lead: merge penalty 30d8847: (none)                                                                        | clean    | 0       | 0      |
| lead: merge kernel 78ebe06: (none)                                                                         | clean    | 0       | 0      |
| lead: merge kernel 6e06154: (none)                                                                         | clean    | 0       | 0      |
| lead: merge check 1cf1276: (none)                                                                          | clean    | 0       | 0      |
| lead: merge sweep ea5debb: (none)                                                                          | clean    | 0       | 0      |
| lead: merge sweep 4e30fdb: (none)                                                                          | clean    | 0       | 0      |
| notification: (none)                                                                                       | clean    | 0       | 0      |
| notification: contexts/notification/src/domain/events.ts                                                   | semantic | 8       | 6000   |
| notification: (none: account.v1 still a stub on main, startTestApp cannot boot, integration tests unrun)   | kernel   | 0       | 0      |
| notification: contexts/notification/tests/integration/inbox.test.ts                                        | test     | 20      | 15000  |
| notification: contexts/notification/contract/v1/index.ts                                                   | semantic | 10      | 6000   |
| notification: contexts/payment, contexts/check (register stubs)                                            | build    | 5       | 3000   |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| payment: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| penalty: contexts/penalty/src/domain/penalty-service.ts                                                    | semantic | 12      | 40000  |
| penalty: (none)                                                                                            | clean    | 0       | 0      |
| proof: (none)                                                                                              | clean    | 0       | 0      |
| proof: (none)                                                                                              | clean    | 0       | 0      |
| proof: (none)                                                                                              | clean    | 0       | 0      |
| proof: (none)                                                                                              | clean    | 0       | 0      |
| proof: contexts/proof/src/register.ts                                                                      | semantic | 5       | 3000   |
| protection: (none)                                                                                         | clean    | 0       | 0      |
| protection: src/domain/check-settled.ts                                                                    | semantic | 8       | 6000   |
| protection: (none)                                                                                         | clean    | 0       | 0      |
| protection: (unsigned merge commits)                                                                       | text     | 6       | 3000   |
| protection: (none)                                                                                         | clean    | 0       | 0      |
| sit-ci: (none) merge main 7e7ebcf                                                                          | clean    | 1       | 500    |
| sit-ci: (none) merge main 14d0957                                                                          | clean    | 1       | 500    |
| sweep: ---                                                                                                 | ---      | ---     | ---    |
| sweep: tests/sit-flows/\*/04-habit.bru                                                                     | semantic | 10      | 15000  |
| sweep: tests/sit-flows/flow2-skip-ownership/02-sign-up.bru, 03-configuration.bru                           | test     | 3       | 3000   |
| sweep: tests/sit-flows/flow1-missed-habit/04..07, tests/integration/flow-missed-habit.test.ts, docs/sit.md | semantic | 35      | 60000  |
| sweep: contexts/proof/tests/integration/support.ts (+ nfc, proof-routes, purge, strava tests)              | test     | 25      | 60000  |
| sweep: src/kernel/testing (TestApp.tick, made by anahy at my ask)                                          | kernel   | 5       | 5000   |
| sweep: contexts/proof/src/data/strava-repository.ts                                                        | kernel   | 3       | 3000   |
| sweep: tools/harness.ts, tools/sit.ts (per-collection SIT users)                                           | test     | 10      | 15000  |
| sweep: contexts/notification/tests/integration/inbox.test.ts (fixed by lissette)                           | test     | 5       | 8000   |
| sweep: contexts/friend/tests/integration/\*.test.ts (already fixed on ctx/friend)                          | test     | 3       | 4000   |
| sweep: contexts/charity/tests/integration/purge.test.ts                                                    | test     | 2       | 2000   |
