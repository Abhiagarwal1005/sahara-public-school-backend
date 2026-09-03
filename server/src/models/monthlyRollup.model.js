const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Pre-aggregated totals. The dashboard and class-wise report read these.
//
// Why: Solar4U's admin dashboard fires nine aggregations in parallel. On a
// dedicated VPS that is fine; on M0's shared CPU it would be the slowest
// screen in the app. Here every movement of money $incs this document, so
// the dashboard is one small find() — and stays that way after three years
// stays just as fast.
//
// The cost: if a new write path forgets to update the rollup, the number
// goes quietly wrong. That is why every money mutation goes through
// ledger.service ONLY, and the recompute script rebuilds these from the
// ledger and reports any drift.
// ---------------------------------------------------------------------------
const monthlyRollupSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        month: { type: String, required: true }, // "2026-08"
        // SCHOOL = the whole school's total; CLASS = one class
        scope: { type: String, enum: ['SCHOOL', 'CLASS'], required: true },
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', default: null },
        className: { type: String, default: '' },

        // Fee side
        feeExpected: { type: Number, default: 0 }, // set when demands are generated
        feeCollected: { type: Number, default: 0 },
        feeDiscount: { type: Number, default: 0 },

        // Other income
        stockSales: { type: Number, default: 0 },
        otherIncome: { type: Number, default: 0 },

        // Kharche
        expenses: { type: Number, default: 0 },
        salaries: { type: Number, default: 0 },
        vendorPaid: { type: Number, default: 0 },
        purchases: { type: Number, default: 0 }, // bill value, not cash

        // Cash movement — the sum of the heads above, kept separately so the day
        // book and dashboard can read it directly.
        cashIn: { type: Number, default: 0 },
        cashOut: { type: Number, default: 0 },

        lastRecomputedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// The upsert target for every $inc, and the dashboard's read key.
// class is null at SCHOOL scope — Mongo indexes null too, so the unique
// constraint holds correctly across both scopes.
monthlyRollupSchema.index({ session: 1, month: 1, scope: 1, class: 1 }, { unique: true });
// "Every month in this session" — the trend chart
monthlyRollupSchema.index({ session: 1, scope: 1, month: 1 });

module.exports =
    mongoose.models.MonthlyRollup || mongoose.model('MonthlyRollup', monthlyRollupSchema);
