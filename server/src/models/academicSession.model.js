const mongoose = require('mongoose');

// "2026-27". This is the partition key for the whole app — every transactional
// collection carries it, and it leads almost every compound index.
//
// Solar4U used `company` here (multi-tenant). This serves one school, so a
// tenant field would be dead weight on every index. Session does the same
// job: last year's data stays out of this year's queries automatically.
// 
const academicSessionSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true }, // "2026-27"
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        // Only one active at a time — the service layer enforces this
        // (activating a new one deactivates the old).
        isActive: { type: Boolean, default: false },
        // Which months fees are raised for. Some schools bill 12 months, some
        // 10 (April–January). This list drives generation.
        feeMonths: { type: [String], default: [] }, // ["2026-04", ...]
        // What an ID card costs this year. A school-wide default, overridable per
        // student at issue time (a staff child's card is often free), so the
        // common case is one number set once and never typed again.
        idCardFee: { type: Number, default: 0, min: 0 },
        closedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

academicSessionSchema.index({ name: 1 }, { unique: true });
// "Which session is current" — once per cold start, then cached.
academicSessionSchema.index({ isActive: 1 });

module.exports =
    mongoose.models.AcademicSession || mongoose.model('AcademicSession', academicSessionSchema);
