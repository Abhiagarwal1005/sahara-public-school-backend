const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// A LEAD — an enquiry, not a student.
//
// Somebody walks in and asks about admission. We take the same details we
// would take on an admission form, and then we chase them: call back, note
// what they said, set the next follow-up date.
//
// DELIBERATELY UNCONNECTED TO EVERYTHING ELSE.
//
// This collection holds no reference to Student, SchoolClass, FeeDemand,
// Transaction or any balance. That is not an oversight — a lead has not paid
// anything, owes nothing and sits in no roster, so linking it to the money
// side of the app could only ever produce wrong numbers. Nothing here is
// counted in a report, a rollup or an outstanding figure.
//
// `classInterested` is a PLAIN STRING for the same reason. The form offers
// the school's classes as a dropdown for convenience, but the answer is
// stored as text — so a lead can say "Nursery next year" for a class that
// does not exist yet, and deleting a class can never damage a lead.
//
// When a lead does join, the office admits them through the normal Students
// screen. The lead is then simply marked Admitted. No record is created from
// here, and no link is kept.
// ---------------------------------------------------------------------------

const STATUSES = ['New', 'Contacted', 'Visited', 'Interested', 'Admitted', 'Lost'];
const OPEN_STATUSES = ['New', 'Contacted', 'Visited', 'Interested'];
const SOURCES = ['Walk-in', 'Phone', 'Reference', 'Online', 'Other'];

// One line in the chase history. Append-only — a follow-up is a record of
// what was said on a particular day, so it is never edited afterwards.
const followUpSchema = new mongoose.Schema(
    {
        at: { type: Date, required: true },
        note: { type: String, required: true, trim: true },
        outcome: { type: String, enum: STATUSES, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        byName: { type: String, default: '' },
    },
    { _id: false }
);

const leadSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // Search key — the anchored regex runs on this so Mongo can walk the
        // index instead of scanning. Same reason as Student.nameLower.
        nameLower: { type: String, required: true, lowercase: true, trim: true },

        guardianName: { type: String, default: '', trim: true },
        phone: { type: String, required: true, trim: true },
        altPhone: { type: String, default: '', trim: true },
        address: { type: String, default: '', trim: true },

        classInterested: { type: String, default: '', trim: true },
        source: { type: String, enum: SOURCES, default: 'Walk-in' },

        status: { type: String, enum: STATUSES, default: 'New' },
        // The whole point of the module: when to ring them next.
        nextFollowUp: { type: Date, default: null },
        followUps: { type: [followUpSchema], default: [] },

        note: { type: String, default: '', trim: true },

        closedAt: { type: Date, default: null },
        closeReason: { type: String, default: '', trim: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// The follow-up queue: open leads whose date has arrived, oldest first.
// ESR — equality on status, then range + sort on nextFollowUp.
leadSchema.index({ status: 1, nextFollowUp: 1 });
// Search by name
leadSchema.index({ nameLower: 1 });
// "This number rang again" — and it catches a duplicate enquiry
leadSchema.index({ phone: 1 });
// The plain list, newest enquiry first
leadSchema.index({ createdAt: -1 });

leadSchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);

Lead.STATUSES = STATUSES;
Lead.OPEN_STATUSES = OPEN_STATUSES;
Lead.SOURCES = SOURCES;

module.exports = Lead;
