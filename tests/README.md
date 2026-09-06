# Tests

These are not unit tests — they are three smoke suites that run real business
flows against a real MongoDB. The point is to prove the things that could go
*quietly* wrong: balances, rollups, idempotency and permissions.

## Before running: a replica set

Transactions need a replica set (they will not run on a standalone mongod).
Atlas is a replica set by default; locally:

```bash
mongod --replSet rs0 --dbpath /tmp/spsdb --port 27018
npm run test:mongo     # initiates the replica set
```

## The suites

| Command | What it checks |
|---|---|
| `npm run test:routes` | The app loads, all 92 routes register, no circular requires |
| `npm run test:smoke` | Business rules end to end — money, stock, salary, permissions |
| `npm run test:http` | The real HTTP surface — auth, cookies, permission changes taking effect live |
| `npm run test:dues` | Stock dues — collecting what a student owes on a credit sale, and what a void may not undo |
| `npm run test:voidfee` | Voiding a fee receipt when the student has more than one — that it unwinds the months *that* receipt paid, and leaves the other receipt's months alone |
| `npm run test:salary` | Payroll — Sundays paid automatically, what Present / HalfDay / Leave / Absent are each worth, and the late-arrival allowance (4 excess lates = 1 absent, 2 = a half day) |
| `npm run test:leads` | Enquiries — follow-up queue, and proof the module touches no student, fee, ledger or rollup |

`smoke.js` drops and rebuilds its own database (`sps_smoke`) on every run.
`dues.js` uses a separate database (`sps_dues`) so it can move balances freely
without disturbing the numbers `smoke.js` asserts on. `voidfee.js` owns
`sps_voidfee` for the same reason.
`http.js` runs against that same database, so run `test:smoke` first.

## Afterwards

```bash
node scripts/recomputeBalances.js   # should print "No drift"
```

That last command is the real proof: it rebuilds every balance from the ledger
and reports any difference. If the suites pass but this reports drift, a write
path is updating a balance without going through `ledger.service`.

It is not the *only* proof, though — and `voidfee.js` exists because of the
gap. The old void unwound the wrong months while every total stayed correct,
so this script reported no drift throughout. A balance that adds up is not the
same as a balance made of the right parts; assert per-month, not per-total.
