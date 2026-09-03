const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        admissionNo: { type: String, required: true }, // ADM0412 - counter se
        name: { type: String, required: true, trim: true },
        // Search key. The anchored regex (^) runs on this so Mongo can walk the
        // index — see utils/search.js for why.
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        guardianName: { type: String, default: '', trim: true },
        phone: { type: String, required: true, trim: true },
        altPhone: { type: String, default: '', trim: true },
        address: { type: String, default: '', trim: true },

        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', required: true },
        // Denormalised — the student list, fee receipts and the defaulters report
        // all show the class name. Without it every list API would need a $lookup,
        // the most expensive step on a hot read path.
        className: { type: String, required: true },

        // Defaults from the class but can be overridden per student — the sibling
        // concession and staff-child cases, handled without a special feature.
        monthlyFee: { type: Number, required: true, min: 0 },

        status: { type: String, enum: ['Active', 'Left'], default: 'Active' },
        admissionDate: { type: Date, required: true },
        leftAt: { type: Date, default: null },
        photo: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
        },

        // ---- Denormalised balances ----
        // These two fields are why the whole fee module is fast. The student card,
        // the defaulters list and the dashboard's outstanding all read them and
        // never run an aggregation. They are $inc'd on every movement of money
        // (ledger.service), and the recompute script rebuilds them from the ledger
        // to check for drift.
        feeOutstanding: { type: Number, default: 0 },
        stockOutstanding: { type: Number, default: 0 },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// Per-session admission numbers
studentSchema.index({ session: 1, admissionNo: 1 }, { unique: true });
// Class roster, alphabetically — filter AND sort both from the index, no
// in-memory sort (ESR: equality session+status+class, then sort nameLower)
studentSchema.index({ session: 1, status: 1, class: 1, nameLower: 1 });
// Search by name across the whole school
studentSchema.index({ session: 1, status: 1, nameLower: 1 });
// "The guardian is on the phone" — the office's most common lookup
studentSchema.index({ phone: 1 });
// Defaulters list with no aggregation
studentSchema.index({ session: 1, status: 1, feeOutstanding: -1 });

// so nameLower never has to be set by hand
studentSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema);
