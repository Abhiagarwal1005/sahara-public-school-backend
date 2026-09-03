const Transaction = require('../models/transaction.model');
const MonthlyRollup = require('../models/monthlyRollup.model');
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { monthKeyIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// The ONLY door through which money moves in this school.
//
// No other service calls Transaction.create() directly. The reason is
// simple: writing a transaction row is half the job — the rollups must
// move with it, or the dashboard goes quietly wrong and nobody notices
// for months. Doing both in one place makes forgetting impossible.
//
// Entity balances (Student.feeOutstanding, Vendor.outstanding) are the
// responsibility because they differ per type — but they must happen
// inside the same mongoose session that is passed in here.
// ---------------------------------------------------------------------------

// Which type moves which rollup field.
// Each entry: [rollup field, cash field]. A null cash field means it is
// not a cash movement (no such type today, but a case like a credit
// purchase could arrive later).
const ROLLUP_MAP = {
    FEE: ['feeCollected', 'cashIn'],
    STOCK_SALE: ['stockSales', 'cashIn'],
    OTHER_IN: ['otherIncome', 'cashIn'],
    EXPENSE: ['expenses', 'cashOut'],
    SALARY: ['salaries', 'cashOut'],
    VENDOR_PAY: ['vendorPaid', 'cashOut'],
    OTHER_OUT: [null, 'cashOut'],
};

// The same $inc lands in two places: the school-wide rollup and (for fees)
// that class's rollup. Both are upserts — the first entry creates the
// document, so nothing needs seeding at the start of a month.
const bumpRollup = async ({ session, month, classId = null, className = '', fields }, mongoSession) => {
    const inc = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value) inc[key] = round2(value);
    }
    if (!Object.keys(inc).length) return;

    const ops = [
        {
            updateOne: {
                filter: { session, month, scope: 'SCHOOL', class: null },
                update: { $inc: inc, $setOnInsert: { session, month, scope: 'SCHOOL', class: null } },
                upsert: true,
            },
        },
    ];

    if (classId) {
        ops.push({
            updateOne: {
                filter: { session, month, scope: 'CLASS', class: classId },
                update: {
                    $inc: inc,
                    $setOnInsert: { session, month, scope: 'CLASS', class: classId, className },
                },
                upsert: true,
            },
        });
    }

    await MonthlyRollup.bulkWrite(ops, { session: mongoSession, ordered: false });
};

// The rollup fields this transaction type changes
const rollupFieldsFor = (type, signedAmount) => {
    const mapping = ROLLUP_MAP[type];
    if (!mapping) return {};

    const [head, cash] = mapping;
    const fields = {};
    if (head) fields[head] = signedAmount;
    if (cash) fields[cash] = signedAmount;
    return fields;
};

// ---------------------------------------------------------------------------
// Record a transaction and update the rollups.
//
// mongoSession is optional but should almost always be passed — the
// caller's own balance updates belong in the same session so the whole
// operation stays atomic.
// ---------------------------------------------------------------------------
const record = async (payload, mongoSession = null) => {
    const {
        session,
        direction,
        type,
        amount,
        mode,
        txnDate = new Date(),
        party,
        classId = null,
        className = '',
        refModel = '',
        refId = null,
        receiptNo = null,
        note = '',
        attachments = [],
        recordedBy,
    } = payload;

    if (!ROLLUP_MAP[type] && type !== 'REVERSAL') {
        throw new ApiError(500, `Unknown transaction type: ${type}`);
    }
    const value = round2(amount);
    if (!(value > 0)) {
        throw new ApiError(400, 'Amount must be greater than zero');
    }

    const month = monthKeyIST(txnDate);

    const [txn] = await Transaction.create(
        [
            {
                session,
                direction,
                type,
                amount: value,
                mode,
                txnDate,
                month,
                party,
                class: classId,
                className,
                refModel,
                refId,
                receiptNo,
                note,
                attachments,
                recordedBy,
            },
        ],
        { session: mongoSession }
    );

    await bumpRollup(
        {
            session,
            month,
            classId,
            className,
            fields: rollupFieldsFor(type, value),
        },
        mongoSession
    );

    return txn;
};

// ---------------------------------------------------------------------------
// Correcting a mistake: mark the original void and write an OPPOSING row.
//
// The original is never edited or deleted. Both lines show in the day
// book — that is correct behaviour, not clutter. A cash book that can be
// silently edited is not a cash book.
//
// The rollups correct themselves because the reversal's $inc is negative.
// ---------------------------------------------------------------------------
const reverse = async ({ original, reason, actorId }, mongoSession = null) => {
    if (original.voided) {
        throw new ApiError(409, 'This entry has already been voided');
    }

    await Transaction.updateOne(
        { _id: original._id, voided: false },
        {
            $set: {
                voided: true,
                voidedAt: new Date(),
                voidedBy: actorId,
                voidReason: reason,
            },
        },
        { session: mongoSession }
    );

    const [reversal] = await Transaction.create(
        [
            {
                session: original.session,
                // Opposite direction — the cash book reads correctly on both sides
                direction: original.direction === 'IN' ? 'OUT' : 'IN',
                type: 'REVERSAL',
                amount: original.amount,
                mode: original.mode,
                txnDate: new Date(),
                month: monthKeyIST(new Date()),
                party: original.party,
                class: original.class,
                className: original.className,
                refModel: original.refModel,
                refId: original.refId,
                note: `Reversal of ${original.receiptNo || original._id}: ${reason}`,
                recordedBy: actorId,
                reversalOf: original._id,
            },
        ],
        { session: mongoSession }
    );

    // Subtract the same amount from the rollup. Note: from the ORIGINAL's
    // month, not today's — otherwise a July mistake would understate August's
    // collection and leave July's figure wrong forever.
    await bumpRollup(
        {
            session: original.session,
            month: original.month,
            classId: original.class,
            className: original.className,
            fields: rollupFieldsFor(original.type, -original.amount),
        },
        mongoSession
    );

    return reversal;
};

module.exports = { record, reverse, bumpRollup, ROLLUP_MAP };
