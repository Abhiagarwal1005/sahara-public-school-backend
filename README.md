# Sahara Public School — Backend

Fees, stock, purchases, attendance and payroll.

Node + Express + MongoDB Atlas, deployed as a single serverless function on
Vercel.

---

## Running it

```bash
npm install
cp .env.example .env         # fill in MONGODB_URI and the two token secrets
npm run seed:admin           # prints a temporary password — note it down
npm run seed:session 2026-27 # session + classes
npm run build:indexes        # indexes (autoIndex is OFF in production)
npm run dev                  # http://localhost:8000
```

Health check: `GET /health` — it sits *after* the database middleware, so it
only returns 200 when Mongo is genuinely reachable.

---

## Architecture — six things that explain the whole design

**1. Permissions are data, not code.**
A route declares the *capability* it needs, not the *role*:
`can('fee.discount')`. From the Settings screen the Admin can grant or revoke
anything for any role — no code change, no deploy. Only `permission.manage`
stays locked to Admin (a role that can widen its own permissions is not a
permission system).

**2. Session is the partition key.**
`company` — Solar4U's multi-tenant field — is absent here, because this serves
one school. In its place every transactional collection carries `session`
("2026-27"), and that leads almost every compound index.

**3. Append-only ledger, denormalised balances.**
Every rupee writes one row into `Transaction`. But a balance is never
*computed* from the ledger — `Student.feeOutstanding`, `Vendor.outstanding`
and the `MonthlyRollup` fields are maintained with `$inc`. That is why the
dashboard and reports stay fast as the data grows.
Every money mutation goes through **`ledger.service` only**.

**4. A mistake is a void + reversal, never an edit or delete.**
Both lines show in the day book. A cash book that can be silently edited is
not a cash book.

**5. No cron — idempotent endpoints instead.**
The unique index on `{ student, month }` makes fee generation idempotent:
press the button twice, retry the request, run it from two machines at once —
no student is charged twice. Salary generation works the same way. Vercel has
no long-running process, and this design does not need one.

**6. Images never pass through the server.**
The backend issues a short-lived Cloudinary signature; the browser uploads
directly. That bypasses Vercel's 4.5MB body cap, halves the bandwidth, and
keeps the API secret away from the client.

---

## Performance — what was actually done

| | |
|---|---|
| **Region pinning** | Functions in `bom1`, Atlas cluster in Mumbai. Cross-region costs ~220ms per query — more than every other optimisation here saves combined. |
| **Connection caching** | A cached promise on `globalThis`. A warm instance never reconnects. `maxPoolSize: 5` (M0's ceiling is 500 connections), `bufferCommands: false`. |
| **One function** | The whole app from `api/index.js`. Per-route functions would mean a cold start and a connection pool per endpoint. |
| **Index design** | ESR (equality → sort → range). Every index serves a named query; none are speculative. `autoIndex` is off in production. |
| **Index-friendly search** | `nameLower` plus an anchored regex (`^`). A bare `$regex` scans the whole collection. |
| **No `countDocuments`** | Lists fetch `limit + 1` and infer `hasNextPage`. An exact total appears only where it genuinely matters — and comes from a rollup. |
| **Bulk operations** | Attendance for 40 teachers is one `bulkWrite`, not 40 round trips. |
| **Pre-aggregated rollups** | The dashboard and class-wise report are a small `find()`, not a `$group`. |
| **Cold-start discipline** | No Firebase, PDFKit, Nodemailer or Winston. Receipts and slips print from the browser. |

---

## Scripts

```bash
npm run seed:admin               # first Admin (or reset its password)
npm run seed:session 2026-27     # session + classes
npm run build:indexes            # after a deploy, and after any schema change
npm run recompute:balances       # drift check — see below
npm run backup                   # gzipped JSON per collection
npm test                         # routes + smoke + http suites
```

`recompute:balances` is the safety net for the denormalised design — it
rebuilds every balance from its source data and reports the difference. Run it
after a deploy, after any incident, and once a month. **It should print
"No drift".**

---

## Two things to settle before deploying

**1. Vercel's free plan is licensed for non-commercial use.**
Perfectly fine for building, demos and UAT. Once the school is paying, move
the deployment — either Vercel Pro (~$20/mo), or the same Hostinger VPS that
runs Solar4U (it has room for a small second Node app at no extra cost). The
code does not change.

**2. Atlas M0 has no backups.**
This database holds a school's fee receipts and payroll. That is what
`scripts/backup.js` is for — put it in the system cron of any machine that can
run it daily:

```bash
0 2 * * * cd /path/to/Sps-backend && npm run backup
```

---

## To confirm with the client

The salary rule is currently `monthlySalary ÷ workingDays × payableDays`,
where `payableDays = Present + (HalfDay × 0.5) + Leave`, and `workingDays`
comes from the attendance sheet itself (excluding Holiday).

Schools vary a lot here — some allow two free absences a month, some have a
leave quota, some deduct nothing at all. **This is the one calculation every
teacher checks personally.** Changing the rule means changing `computeSlip()`
in `salary.service.js` and nothing else.

The remaining open questions are in Section 13 of the design document.
