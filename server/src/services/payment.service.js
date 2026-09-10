const Transaction = require('../models/transaction.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2 } = require('../utils/money');
const { startOfDayIST, endOfDayIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// VERIFYING COLLECTED MONEY
//
// Somebody at the counter takes a fee, sells a uniform, issues an ID card. The
// receipt prints, the balance moves, the day book records it — all of that is
// already done and none of it waits for anybody's approval, because the parent
// is standing there and the money is in the drawer.
//
// What was missing is the second pair of eyes AFTERWARDS: the person in charge
// sitting down with the cash box, the UPI app and the bank statement and
// ticking off each entry as genuinely received. Until they do, an entry is
// simply unverified — that is a STATUS, not a hold.
//
// The one rule this module lives by: verifying changes nothing but the flag.
// No balance, no rollup, no fee demand, no ledger row. If ticking a box could
// move a number, it would be a second and much quieter way to edit the books,
// and the whole append-only design would be for nothing.
// ---------------------------------------------------------------------------

const { VERIFIABLE_FILTER } = Transaction;

const LIST_FIELDS =
    'receiptNo txnDate type amount mode party className note verified verifiedAt verifiedByName';

// Rows written before verification existed have no `verified` field at all, and
// `{ verified: false }` does not match a missing field. So "pending" is always
// asked as "not true" — that way the feature works on the day it ships, with no
// migration to remember and no back-dated payment quietly invisible.
const PENDING = { verified: { $ne: true } };
const VERIFIED = { verified: true };

const statusFilter = (status) =>
    status === 'pending' ? PENDING : status === 'verified' ? VERIFIED : {};

// ---------------------------------------------------------------------------
// One day's collections, with the day's own tally.
// ---------------------------------------------------------------------------
const listForDate = async (query = {}) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const date = startOfDayIST(query.date || new Date());
    const dayFilter = { session, ...VERIFIABLE_FILTER, txnDate: { $gte: date, $lte: endOfDayIST(date) } };

    const [listed, tally, pendingAll] = await Promise.all([
        fetchPage(
            Transaction.find({ ...dayFilter, ...statusFilter(query.status) })
                .select(LIST_FIELDS)
                // Oldest first: the day is worked through in the order the
                // money actually came in, which is the order the cash box and
                // the UPI history are read in.
                .sort({ txnDate: 1 }),
            { page, limit, withTotal: true }
        ),

        // The tally is for the WHOLE DAY, never for the current filter —
        // otherwise "3 still to check" would read as "0 still to check" the
        // moment somebody switched the view to Verified.
        //
        // Grouped on a computed boolean rather than on the raw field, so a
        // missing `verified` buckets with false instead of forming a third
        // group of its own.
        Transaction.aggregate([
            { $match: dayFilter },
            {
                $group: {
                    _id: { $eq: ['$verified', true] },
                    count: { $sum: 1 },
                    amount: { $sum: '$amount' },
                },
            },
        ]),

        // Without this the screen can only answer "is this date done?", and
        // finding the dates that are NOT done would mean clicking back through
        // the calendar one day at a time.
        oldestPending(session),
    ]);

    const verified = tally.find((t) => t._id === true) || { count: 0, amount: 0 };
    const pending = tally.find((t) => t._id === false) || { count: 0, amount: 0 };

    return {
        date,
        // Every row here is verifiable by construction — the filter says so. It
        // is still stamped explicitly, because the same VerifyMark component
        // renders these rows and the day book's, and it must not have to guess
        // which list it is looking at.
        items: listed.items.map((t) => ({ ...t, verifiable: true })),
        pagination: listed.pagination,
        summary: {
            count: verified.count + pending.count,
            amount: round2(verified.amount + pending.amount),
            verifiedCount: verified.count,
            verifiedAmount: round2(verified.amount),
            pendingCount: pending.count,
            pendingAmount: round2(pending.amount),
        },
        pendingAll,
    };
};

// How much of the session is still unchecked, and where to start. A count and
// one indexed read — cheap enough to send with every page of the list.
const oldestPending = async (session) => {
    const filter = { session, ...VERIFIABLE_FILTER, ...PENDING };

    const [count, oldest] = await Promise.all([
        Transaction.countDocuments(filter),
        Transaction.findOne(filter).select('txnDate').sort({ txnDate: 1 }).lean(),
    ]);

    return { count, oldestDate: oldest?.txnDate || null };
};

// ---------------------------------------------------------------------------
// Tick and untick.
//
// Both directions exist on purpose. A tick put on the wrong row has to be
// removable, or the only way to correct it is to edit the database by hand —
// and the audit trail records both, so nothing is lost by allowing it.
// ---------------------------------------------------------------------------
const setVerified = async (id, verified, actor) => {
    const txn = await Transaction.findById(id).select(`${LIST_FIELDS} direction voided`).lean();
    if (!txn) throw new ApiError(404, 'Payment not found');

    if (!Transaction.isVerifiable(txn)) {
        throw new ApiError(
            400,
            txn.voided
                ? 'This entry has been voided — there is nothing left to verify'
                : 'Only money collected from a student can be verified'
        ).withCode('NOT_VERIFIABLE');
    }

    const stamp = verified
        ? { verified: true, verifiedAt: new Date(), verifiedBy: actor.id, verifiedByName: actor.name || '' }
        : { verified: false, verifiedAt: null, verifiedBy: null, verifiedByName: '' };

    // Conditional, so two people clicking the same row in the same second
    // cannot both write. The loser is NOT an error: the row already holds the
    // state they asked for, which is the only thing they wanted.
    const updated = await Transaction.findOneAndUpdate(
        { _id: id, ...(verified ? PENDING : VERIFIED) },
        { $set: stamp },
        { new: true }
    )
        .select(LIST_FIELDS)
        .lean();

    if (!updated) {
        const current = await Transaction.findById(id).select(LIST_FIELDS).lean();
        return { payment: current, changed: false };
    }

    return { payment: updated, changed: true };
};

module.exports = { listForDate, setVerified, oldestPending, LIST_FIELDS };
