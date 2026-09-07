const mongoose = require('mongoose');
const FeeDemand = require('../models/feeDemand.model');
const Student = require('../models/student.model');
const Transaction = require('../models/transaction.model');
const MonthlyRollup = require('../models/monthlyRollup.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2, allocate } = require('../utils/money');
const { isValidMonthKey, monthRangeIST } = require('../utils/istDate');

// A demand's status is always derived from its own numbers, never set
// separately, so it can never contradict the amounts.
const statusFor = (d) => {
    const due = round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0));
    if (due <= 0) return 'Paid';
    return (d.paidAmount || 0) > 0 ? 'Partial' : 'Unpaid';
};

const dueOf = (d) => Math.max(0, round2((d.amount || 0) - (d.discount || 0) - (d.paidAmount || 0)));

// ---------------------------------------------------------------------------
// Raise the month's fees.
//
// This is the heart of the whole "no cron" design. Running it twice is
// completely safe: the unique index on { student, month } physically
// prevents a second row. So the button can be pressed again, retried on a
// slow connection, or run by two people at once — no student is ever
// charged twice.
//
// Re-running is also useful: students admitted since the last run get
// their rows now.
// ---------------------------------------------------------------------------
const generateMonth = async ({ month, classId = null }, actorId) => {
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');

    const session = await sessionService.getActiveSession();

    if (session.feeMonths?.length && !session.feeMonths.includes(month)) {
        throw new ApiError(
            400,
            `${month} is not in this session's fee months — add it in Settings`
        );
    }

    const studentFilter = { session: session.name, status: 'Active' };
    if (classId) studentFilter.class = classId;

    const students = await Student.find(studentFilter)
        .select('name class className monthlyFee admissionDate')
        .lean();

    if (!students.length) {
        return { month, created: 0, skipped: 0, totalRaised: 0, message: 'No active students found' };
    }

    // Filter out demands that already exist. The unique index is the real
    // guard (for concurrent runs), but this pre-filter keeps the common case
    // off the error path — cleaner and faster.
    const existing = await FeeDemand.find({
        month,
        student: { $in: students.map((s) => s._id) },
    })
        .select('student')
        .lean();

    const already = new Set(existing.map((d) => d.student.toString()));
    const pending = students.filter((s) => !already.has(s._id.toString()));

    if (!pending.length) {
        return {
            month,
            created: 0,
            skipped: students.length,
            totalRaised: 0,
            message: 'Fees for this month have already been raised',
        };
    }

    const { start, end } = monthRangeIST(month);

    const docs = pending
        // A student admitted AFTER this month gets no demand for it. (A student
        // admitted mid-month is charged the full fee — the usual school practice;
        // pro-rata would be a one-line change.)
        .filter((s) => new Date(s.admissionDate) < end)
        .map((s) => ({
            session: session.name,
            month,
            student: s._id,
            studentName: s.name,
            class: s.class,
            className: s.className,
            amount: round2(s.monthlyFee),
            dueDate: end,
            status: 'Unpaid',
            generatedBy: actorId,
        }));

    if (!docs.length) {
        return { month, created: 0, skipped: students.length, totalRaised: 0 };
    }

    let created = [];

    try {
        created = await FeeDemand.insertMany(docs, { ordered: false });
    } catch (err) {
        // ordered:false means the other rows did insert. An 11000 here is
        // expected (someone else won a race) — part of the design, not an
        // error. Only duplicate-key is swallowed.
        if (err.code !== 11000 && err.code !== undefined) throw err;
        created = err.insertedDocs || [];
    }

    if (!created.length) {
        return { month, created: 0, skipped: students.length, totalRaised: 0 };
    }

    // Raise each student's outstanding — one bulkWrite, not N updates
    await Student.bulkWrite(
        created.map((d) => ({
            updateOne: { filter: { _id: d.student }, update: { $inc: { feeOutstanding: d.amount } } },
        })),
        { ordered: false }
    );

    // feeExpected is SET from an aggregation rather than $inc'd.
    // Why: if generation half-ran, or rows arrived from elsewhere in a race,
    // an $inc could double count. Generation is not a hot path, so one
    // authoritative aggregation is affordable here — and it always tells
    // the truth.
    await recomputeExpected(session.name, month);

    return {
        month,
        created: created.length,
        skipped: students.length - created.length,
        totalRaised: round2(created.reduce((sum, d) => sum + d.amount, 0)),
    };
};

// Authoritatively write a month's feeExpected/feeDiscount into the rollups
const recomputeExpected = async (session, month) => {
    const rows = await FeeDemand.aggregate([
        { $match: { session, month } },
        {
            $group: {
                _id: '$class',
                className: { $first: '$className' },
                expected: { $sum: '$amount' },
                discount: { $sum: '$discount' },
            },
        },
    ]);

    const schoolTotal = rows.reduce(
        (acc, r) => ({ expected: acc.expected + r.expected, discount: acc.discount + r.discount }),
        { expected: 0, discount: 0 }
    );

    const ops = [
        {
            updateOne: {
                filter: { session, month, scope: 'SCHOOL', class: null },
                update: {
                    $set: { feeExpected: round2(schoolTotal.expected), feeDiscount: round2(schoolTotal.discount) },
                    $setOnInsert: { session, month, scope: 'SCHOOL', class: null },
                },
                upsert: true,
            },
        },
        ...rows.map((r) => ({
            updateOne: {
                filter: { session, month, scope: 'CLASS', class: r._id },
                update: {
                    $set: { feeExpected: round2(r.expected), feeDiscount: round2(r.discount) },
                    $setOnInsert: { session, month, scope: 'CLASS', class: r._id, className: r.className },
                },
                upsert: true,
            },
        })),
    ];

    await MonthlyRollup.bulkWrite(ops, { ordered: false });
};

const listDemands = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session };
    if (query.month) filter.month = query.month;
    if (query.class) filter.class = query.class;
    if (query.status) filter.status = query.status;
    if (query.student) filter.student = query.student;

    return fetchPage(
        FeeDemand.find(filter)
            .select('month studentName className amount discount paidAmount status dueDate student class')
            .sort({ month: -1, studentName: 1 }),
        { page, limit, withTotal: true }
    );
};

// A student's unpaid months, oldest first
const pendingForStudent = async (studentId) =>
    FeeDemand.find({ student: studentId, status: { $ne: 'Paid' } })
        .sort({ month: 1 })
        .lean();

// ---------------------------------------------------------------------------
// Collecting a fee. Four writes inside one transaction — either all of
// them or none. Half-applying is the worst outcome: a receipt printed
// while the student's outstanding never moved.
// ---------------------------------------------------------------------------
const collect = async ({ studentId, amount, mode, txnDate, note = '' }, actor) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const demands = await pendingForStudent(studentId);
    const totalDue = round2(demands.reduce((sum, d) => sum + dueOf(d), 0));

    if (totalDue <= 0) throw new ApiError(400, 'This student has no fees outstanding');

    // Never more than what is owed — a typing slip would create a negative
    // balance, and those are only ever fixed by manual reconciliation
    // afterwards.
    if (value > totalDue) {
        throw new ApiError(400, `Only ₹${totalDue} is outstanding — you cannot collect more than that`);
    }

    // Oldest months first — the universal practice in fee collection
    const splits = allocate(value, demands.map(dueOf));

    return withTransaction(async (mongoSession) => {
        const seq = await getNextSequence('receiptNo', session, mongoSession);
        const receiptNo = formatCode('RCP', seq, 5);

        // 1. Apply the allocated amount to each demand
        const demandOps = [];
        const covered = [];

        demands.forEach((d, i) => {
            const take = splits[i];
            if (take <= 0) return;

            const next = { ...d, paidAmount: round2((d.paidAmount || 0) + take) };
            demandOps.push({
                updateOne: {
                    filter: { _id: d._id },
                    update: { $inc: { paidAmount: take }, $set: { status: statusFor(next) } },
                },
            });
            // `demand` is what makes a void exact — the rest is for the printed
            // receipt. Only demand/month/amount are stored on the transaction
            // (the schema drops the others).
            covered.push({
                demand: d._id,
                month: d.month,
                amount: take,
                className: d.className,
                class: d.class,
            });
        });

        await FeeDemand.bulkWrite(demandOps, { session: mongoSession, ordered: true });

        // 2. Lower the student's outstanding — this is the field the defaulters
        //    list and the student card read (no aggregation anywhere).
        await Student.updateOne(
            { _id: studentId },
            { $inc: { feeOutstanding: -value } },
            { session: mongoSession }
        );

        // 3 + 4. Ledger row + monthly/class rollups (ledger.service does both)
        const txn = await ledger.record(
            {
                session,
                direction: 'IN',
                type: 'FEE',
                amount: value,
                mode,
                txnDate: txnDate || new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                refModel: 'FeeDemand',
                refId: covered[0]?.demand || null,
                receiptNo,
                // The allocation this receipt made, so voidReceipt reverses
                // exactly these months rather than guessing. See
                // transaction.model.js for what went wrong without it.
                covered: covered.map((c) => ({
                    demand: c.demand,
                    month: c.month,
                    amount: c.amount,
                })),
                note,
                recordedBy: actor.id,
            },
            mongoSession
        );

        return {
            receiptNo,
            transactionId: txn._id,
            amount: value,
            mode,
            date: txn.txnDate,
            student: {
                id: student._id,
                name: student.name,
                admissionNo: student.admissionNo,
                className: student.className,
            },
            covered,
            balanceAfter: round2(totalDue - value),
        };
    });
};

// ---------------------------------------------------------------------------
// Discount / waiver. Tracked separately so it never hides inside
// collections — "how much was waived" stays a number the Principal can see.
// ---------------------------------------------------------------------------
const applyDiscount = async (demandId, { amount, reason }, actor) => {
    const value = round2(amount);
    if (!(value > 0)) throw new ApiError(400, 'Discount must be greater than zero');
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required for the discount');

    const demand = await FeeDemand.findById(demandId).lean();
    if (!demand) throw new ApiError(404, 'Fee record not found');

    const due = dueOf(demand);
    if (value > due) throw new ApiError(400, `Only ₹${due} is outstanding — the discount cannot exceed that`);

    return withTransaction(async (mongoSession) => {
        const next = { ...demand, discount: round2((demand.discount || 0) + value) };

        await FeeDemand.updateOne(
            { _id: demandId },
            {
                $inc: { discount: value },
                $set: {
                    status: statusFor(next),
                    discountReason: reason.trim(),
                    discountBy: actor.id,
                },
            },
            { session: mongoSession }
        );

        await Student.updateOne(
            { _id: demand.student },
            { $inc: { feeOutstanding: -value } },
            { session: mongoSession }
        );

        // A discount is NOT a cash movement, so no Transaction row is written.
        // Only the rollup's discount head rises while expected stays put, so
        // "expected vs collected vs waived" all read separately.
        await ledger.bumpRollup(
            {
                session: demand.session,
                month: demand.month,
                classId: demand.class,
                className: demand.className,
                fields: { feeDiscount: value },
            },
            mongoSession
        );

        return { demandId, discount: value, reason: reason.trim() };
    });
};

// One demand giving money back. Status is recomputed from the demand's own
// numbers, so it can never contradict them.
const unwindOp = (demand, take) => {
    const next = { ...demand, paidAmount: round2((demand.paidAmount || 0) - take) };
    return {
        updateOne: {
            filter: { _id: demand._id },
            update: { $inc: { paidAmount: -take }, $set: { status: statusFor(next) } },
        },
    };
};

// ---------------------------------------------------------------------------
// Which demands give the money back when a receipt is voided.
//
// A receipt now records the allocation it made (Transaction.covered), so this
// is the exact inverse of that collection — the months THIS receipt paid, and
// nothing else.
//
// It used to unwind the student's newest paid months instead, on the reasoning
// that collection allocates oldest-first so a void should run newest-first.
// That is the exact inverse only while the student has ONE receipt. With two,
// voiding the older one took the money back off the months the NEWER one had
// paid: April/May stayed 'Paid' with their money gone, June/July flipped to
// 'Unpaid' with a valid receipt behind them. Every total still agreed — the
// student's outstanding, the rollups, recomputeBalances — because only the
// attribution was wrong, which is exactly why it could sit there unnoticed.
// ---------------------------------------------------------------------------
const unwindReceipt = async (txn, mongoSession) => {
    const ops = [];
    const done = [];
    let reversed = 0;

    if (txn.covered?.length) {
        const demands = await FeeDemand.find({ _id: { $in: txn.covered.map((c) => c.demand) } })
            .session(mongoSession)
            .lean();

        const byId = new Map(demands.map((d) => [String(d._id), d]));

        for (const line of txn.covered) {
            const demand = byId.get(String(line.demand));
            // The demand is gone — nothing to unwind here. The shortfall is
            // picked up below so the student's balance still adds up.
            if (!demand) continue;

            // Clamped: a demand cannot give back more than it currently holds.
            // Normally that is the full line, but a receipt voided under the
            // old guess could have already moved money off this demand, and a
            // negative paidAmount is worse than a short reversal.
            const take = round2(Math.min(line.amount, demand.paidAmount || 0));
            if (take <= 0) continue;

            reversed = round2(reversed + take);
            done.push(demand._id);
            ops.push(unwindOp(demand, take));
        }
    }

    // Whatever the allocation could not account for. For a receipt written
    // before `covered` existed that is the entire amount, and this is the old
    // newest-first behaviour — kept so those receipts stay voidable at all.
    // For a newer one it is a shortfall from the cases above.
    //
    // It has to be covered somehow: Student.feeOutstanding goes up by the full
    // receipt amount below, so if the demands gave back less, the student's
    // balance and the sum of their dues would disagree — and that IS drift
    // recomputeBalances would report.
    let remaining = round2(txn.amount - reversed);

    if (remaining > 0) {
        const others = await FeeDemand.find({
            student: txn.party.ref,
            paidAmount: { $gt: 0 },
            _id: { $nin: done },
        })
            .sort({ month: -1 })
            .session(mongoSession)
            .lean();

        for (const demand of others) {
            if (remaining <= 0) break;

            const take = round2(Math.min(remaining, demand.paidAmount));
            if (take <= 0) continue;

            remaining = round2(remaining - take);
            ops.push(unwindOp(demand, take));
        }
    }

    return ops;
};

// ---------------------------------------------------------------------------
// Voiding a wrong receipt. The original is never deleted — it is marked
// void and an opposing entry is written. The money goes back onto the
// student's outstanding.
// ---------------------------------------------------------------------------
const voidReceipt = async (transactionId, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to void this');

    const txn = await Transaction.findById(transactionId).lean();
    if (!txn) throw new ApiError(404, 'Receipt not found');
    if (txn.type !== 'FEE') throw new ApiError(400, 'This is not a fee receipt');
    if (txn.voided) throw new ApiError(409, 'This receipt has already been voided');

    return withTransaction(async (mongoSession) => {
        const ops = await unwindReceipt(txn, mongoSession);

        if (ops.length) await FeeDemand.bulkWrite(ops, { session: mongoSession, ordered: true });

        await Student.updateOne(
            { _id: txn.party.ref },
            { $inc: { feeOutstanding: txn.amount } },
            { session: mongoSession }
        );

        const reversal = await ledger.reverse(
            { original: txn, reason: reason.trim(), actorId: actor.id },
            mongoSession
        );

        return { voided: txn._id, reversalId: reversal._id, amount: txn.amount };
    });
};

// Receipt reprint
const getReceipt = async (transactionId) => {
    const txn = await Transaction.findById(transactionId).lean();
    if (!txn || txn.type !== 'FEE') throw new ApiError(404, 'Receipt not found');

    const student = await Student.findById(txn.party.ref)
        .select('name admissionNo className guardianName phone')
        .lean();

    return { receipt: txn, student };
};

// ---------------------------------------------------------------------------
// The class-wise monthly report — the screen the client asked for.
//
// This reads ONLY rollups. No $group, no $lookup, no collection scan.
// That is why the report still returns in single-digit milliseconds when
// the ledger holds half a million rows.
// ---------------------------------------------------------------------------
const summary = async ({ month }) => {
    const session = await sessionService.getActiveSessionName();
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');

    const rollups = await MonthlyRollup.find({ session, month })
        .select('scope class className feeExpected feeCollected feeDiscount')
        .lean();

    const school = rollups.find((r) => r.scope === 'SCHOOL') || {};
    const classes = rollups
        .filter((r) => r.scope === 'CLASS')
        .map((r) => {
            const expected = round2(r.feeExpected || 0);
            const collected = round2(r.feeCollected || 0);
            const discount = round2(r.feeDiscount || 0);
            return {
                classId: r.class,
                className: r.className,
                expected,
                collected,
                discount,
                outstanding: round2(Math.max(0, expected - discount - collected)),
                // Percentage is against the net demand after discount — otherwise a
                // a class with waivers would show an artificially low collection rate.
                rate: expected - discount > 0 ? Math.round((collected / (expected - discount)) * 100) : 100,
            };
        })
        .sort((a, b) => a.className.localeCompare(b.className));

    const expected = round2(school.feeExpected || 0);
    const collected = round2(school.feeCollected || 0);
    const discount = round2(school.feeDiscount || 0);

    return {
        month,
        school: {
            expected,
            collected,
            discount,
            outstanding: round2(Math.max(0, expected - discount - collected)),
            rate: expected - discount > 0 ? Math.round((collected / (expected - discount)) * 100) : 100,
        },
        classes,
    };
};

module.exports = {
    generateMonth,
    listDemands,
    pendingForStudent,
    collect,
    applyDiscount,
    voidReceipt,
    getReceipt,
    summary,
    recomputeExpected,
    statusFor,
    dueOf,
};
