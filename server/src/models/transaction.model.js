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
    'FEE', // student ne fee di
    'STOCK_SALE', // uniform/books becha
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

module.exports =
    mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
module.exports.TYPES = TYPES;
