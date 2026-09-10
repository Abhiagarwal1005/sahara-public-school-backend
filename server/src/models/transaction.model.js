const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// The school's cash book. Every rupee in or out, one row.
//
// This collection is APPEND-ONLY. A transaction is never edited or
// deleted — a mistake sets `voided: true` and writes an opposing REVERSAL
// row. A financial record that can be silently edited is not a record;
// in front of a school trust or an auditor, that difference is the point.
//
// Important: this ledger is not read to derive BALANCES. A student's
// outstanding comes from Student.feeOutstanding, a vendor's from
// Vendor.outstanding, and a month's totals from MonthlyRollup. These rows
// are the audit trail — the answer to "why is this number what it is".
// ---------------------------------------------------------------------------

const TYPES = [
    'FEE', // a student paid their fee
    'STOCK_SALE', // uniform / books sold
    'ID_CARD', // student ID card issued and paid for
    'EXPENSE', // any expense
    'SALARY', // salary paid to a teacher
    'VENDOR_PAY', // payment made to a vendor
    'OTHER_IN',
    'OTHER_OUT',
    'REVERSAL', // the inverse of an earlier entry
];

const transactionSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        direction: { type: String, enum: ['IN', 'OUT'], required: true },
        type: { type: String, enum: TYPES, required: true },

        amount: { type: Number, required: true, min: 0 },
        mode: {
            type: String,
            enum: ['Cash', 'UPI', 'Bank', 'Cheque', 'Adjustment'],
            required: true,
        },

        txnDate: { type: Date, required: true },
        // "2026-08", in IST (istDate.monthKeyIST). Denormalised so monthly
        // queries run on equality rather than a date range,
        // which indexes far better.
        month: { type: String, required: true },

        party: {
            kind: {
                type: String,
                enum: ['Student', 'Vendor', 'Teacher', 'Other'],
                required: true,
            },
            ref: { type: mongoose.Schema.Types.ObjectId, default: null },
            // Denormalised name — the day book and reports show this directly,
            // with no $lookup.
            name: { type: String, default: '' },
        },

        // Filled on fee rows only — the class-wise monthly report is built from it
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', default: null },
        className: { type: String, default: '' },

        // The document that moved this money (FeeDemand, StockSale, Purchase...)
        refModel: { type: String, default: '' },
        refId: { type: mongoose.Schema.Types.ObjectId, default: null },

        receiptNo: { type: String, default: null }, // on fee receipts only

        // ---- what this receipt actually paid ----
        //
        // Collection allocates across several months (oldest first), and until
        // this existed that breakdown was returned to the browser for the
        // printed receipt and then thrown away. Voiding therefore had to GUESS
        // which months to unwind — it took the money back off the student's
        // newest paid months, which is the exact inverse only while the student
        // has ONE receipt. With two, voiding the older one clawed money back
        // off the months the NEWER one had paid: the totals still agreed (so
        // recomputeBalances reported no drift), but every month's status was
        // wrong on the screen.
        //
        // Storing the allocation makes a void the exact inverse of its own
        // collection, by construction. Empty on non-fee rows, and on fee rows
        // written before this field existed — voidReceipt falls back for those.
        covered: [
            {
                demand: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeDemand', required: true },
                month: { type: String, required: true }, // "2026-08"
                amount: { type: Number, required: true, min: 0 },
                _id: false,
            },
        ],

        note: { type: String, default: '' },
        attachments: [
            {
                publicId: { type: String, required: true },
                width: Number,
                height: Number,
                format: String,
                bytes: Number,
            },
        ],

        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

        // ---- void / reversal ----
        voided: { type: Boolean, default: false },
        voidedAt: { type: Date, default: null },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        voidReason: { type: String, default: '' },
        // On REVERSAL rows: which transaction this reverses
        reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

        // ---- verification ----
        //
        // An OVERSIGHT layer, not an accounting one. By the time a row exists the
        // money has moved and the receipt is printed; this only records that
        // somebody in charge has since checked the entry against the cash box,
        // the UPI app or the bank statement.
        //
        // It deliberately touches NOTHING else. Verifying does not move a
        // balance, a rollup or a fee demand, and neither does un-verifying —
        // which is exactly why it is safe to tick and untick. A flag that
        // changed the books would be a second, quieter way to edit them.
        verified: { type: Boolean, default: false },
        verifiedAt: { type: Date, default: null },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        // Denormalised, so the tick can say WHO signed it off without a lookup
        // on every row of the day book.
        verifiedByName: { type: String, default: '' },
    },
    { timestamps: true }
);

// Day book / cash book - newest first
transactionSchema.index({ session: 1, txnDate: -1 });
// A month's slice, by kind of money
transactionSchema.index({ session: 1, type: 1, month: 1 });
// The full history of one student or vendor
transactionSchema.index({ 'party.kind': 1, 'party.ref': 1, txnDate: -1 });
// Class-wise monthly collection — straight from the index
transactionSchema.index({ session: 1, month: 1, class: 1, type: 1 });
// Receipt reprint + duplicate guard.
//
// partialFilterExpression, NOT sparse. The difference matters: a sparse
// index only skips documents where the field is ABSENT. Our schema uses
// `default: null`, so every non-fee transaction STORES receiptNo as null
// — and two nulls are duplicates to a unique sparse index. A partial index
// filters on type instead, so only real receipt numbers are unique and the
// null rows never enter the index at all.
// 
transactionSchema.index(
    { receiptNo: 1 },
    { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } }
);
// All transactions for a source document (needed when voiding)
transactionSchema.index({ refModel: 1, refId: 1 });
// The verification queue: "what is still unchecked", newest first. ESR —
// equality on session and the flag, then the sort. The party/direction filters
// narrow a set that is already small by then, so they stay out of the key.
transactionSchema.index({ session: 1, verified: 1, txnDate: -1 });

const Transaction =
    mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);

// ---------------------------------------------------------------------------
// What is worth verifying: money the school took FROM A STUDENT at the counter
// — a fee, uniform and books, an ID card. Those are the entries somebody signs
// off against the cash that was actually collected.
//
// Money going OUT is not here. An expense, a salary and a vendor payment each
// already pass through approval steps of their own, and adding a second tick to
// them would be ceremony rather than control. A REVERSAL is direction OUT, so
// it falls out of this by itself, and a voided row has nothing left to check.
//
// This lives in ONE place, and the services that display a payment send the
// result down as `verifiable` rather than each screen re-deciding it.
// ---------------------------------------------------------------------------
const VERIFIABLE_FILTER = { direction: 'IN', 'party.kind': 'Student', voided: { $ne: true } };

const isVerifiable = (txn) =>
    Boolean(txn) && txn.direction === 'IN' && txn.party?.kind === 'Student' && txn.voided !== true;

module.exports = Transaction;
module.exports.TYPES = TYPES;
module.exports.VERIFIABLE_FILTER = VERIFIABLE_FILTER;
module.exports.isVerifiable = isVerifiable;
