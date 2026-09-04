const mongoose = require('mongoose');

// A hand-entered line on the slip: a bonus, an arrear, a fine, a breakage
// recovery. Every one carries a reason, because "why is my salary ₹800 less
// this month" is the question these exist to answer.
//
// It keeps its own _id on purpose — the screen removes a line by id, and
// removing by array position goes wrong the moment two people are editing.
const adjustmentSchema = new mongoose.Schema({
    kind: { type: String, enum: ['Add', 'Deduct'], required: true },
    label: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
});

// Superseded by `adjustments` (which can also add). Kept so a slip created
// before adjustments existed does not silently gain back the money that was
// deducted from it.
const deductionSchema = new mongoose.Schema(
    { label: { type: String, required: true }, amount: { type: Number, required: true, min: 0 } },
    { _id: false }
);

// ---------------------------------------------------------------------------
// Built from attendance, then FROZEN.
//
// grossSalary, monthDays and every day count are COPIED onto the slip at
// generation time, never read live. Two reasons:
//   1. A raise given in June must not rewrite April's paid slip.
//      rewrite it.
//   2. An attendance correction made after payment must not change what
//      was actually handed over.
//
// Once approved the slip is immutable. A mistake is corrected with a
// separate adjustment entry, never by editing this slip.
// ---------------------------------------------------------------------------
const salarySlipSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        month: { type: String, required: true }, // "2026-08"
        teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
        teacherName: { type: String, required: true },
        designation: { type: String, default: '' },

        // ---- snapshot ----
        grossSalary: { type: Number, required: true, min: 0 },
        // The divisor — calendar days in the month (31 / 30 / 28)
        monthDays: { type: Number, default: 0, min: 0 },
        // Information only: monthDays minus Sundays and school holidays
        workingDays: { type: Number, required: true, min: 0 },
        perDayRate: { type: Number, required: true, min: 0 },

        presentDays: { type: Number, default: 0 },
        halfDays: { type: Number, default: 0 },
        leaveDays: { type: Number, default: 0 },
        absentDays: { type: Number, default: 0 },
        holidayDays: { type: Number, default: 0 },
        // Days nobody marked — not paid, and shown so the gap is visible
        unmarkedDays: { type: Number, default: 0 },
        // Sundays in the month — paid, and never part of workingDays
        sundayDays: { type: Number, default: 0 },
        // present + half/2 + paid leave
        payableDays: { type: Number, default: 0 },

        earned: { type: Number, default: 0 },
        // Bonuses, arrears, fines — anything added to or taken off this slip
        adjustments: { type: [adjustmentSchema], default: [] },
        // legacy, see above
        deductions: { type: [deductionSchema], default: [] },
        advance: { type: Number, default: 0, min: 0 },
        netPayable: { type: Number, default: 0 },
        paidAmount: { type: Number, default: 0, min: 0 },

        status: { type: String, enum: ['Draft', 'Approved', 'Paid'], default: 'Draft' },

        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        approvedAt: { type: Date, default: null },
        paidAt: { type: Date, default: null },
        note: { type: String, default: '' },
    },
    { timestamps: true }
);

// One teacher, one month, one slip — always. Re-running generation means
// no duplicate is possible (the same idempotency guard as fee demands).
salarySlipSchema.index({ teacher: 1, month: 1 }, { unique: true });
// "August — who is still unpaid"
salarySlipSchema.index({ session: 1, month: 1, status: 1 });

module.exports = mongoose.models.SalarySlip || mongoose.model('SalarySlip', salarySlipSchema);
