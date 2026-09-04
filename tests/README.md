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
| `npm run test:salary` | Payroll — Sundays paid automatically, and what Present / HalfDay / Leave / Absent are each worth |
| `npm run test:leads` | Enquiries — follow-up queue, and proof the module touches no student, fee, ledger or rollup |

`smoke.js` drops and rebuilds its own database (`sps_smoke`) on every run.
`dues.js` uses a separate database (`sps_dues`) so it can move balances freely
without disturbing the numbers `smoke.js` asserts on.
`http.js` runs against that same database, so run `test:smoke` first.

## Afterwards

```bash
node scripts/recomputeBalances.js   # should print "No drift"
```

That last command is the real proof: it rebuilds every balance from the ledger
and reports any difference. If the suites pass but this reports drift, a write
path is updating a balance without going through `ledger.service`.
