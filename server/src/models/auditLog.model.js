const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Only things touching money or access are logged: discounts, voids,
// salary approve/pay, permission change, user create/deactivate.
//
// Reads are NOT logged. Logging every GET would eat M0's 512MB in months
// for no practical gain — the question is always "who gave this discount",
// never "who looked at this list".
// ---------------------------------------------------------------------------
const auditLogSchema = new mongoose.Schema(
    {
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        actorName: { type: String, required: true },
        actorRole: { type: String, required: true },

        action: { type: String, required: true }, // 'fee.discount', 'salary.pay'
        entity: { type: String, required: true }, // 'FeeDemand'
        entityId: { type: mongoose.Schema.Types.ObjectId, default: null },

        // Only the fields that matter, never the whole document. An audit row
        // that copies the whole document grows storage at the same rate as the
        // real data.
        summary: { type: String, default: '' },
        before: { type: mongoose.Schema.Types.Mixed, default: null },
        after: { type: mongoose.Schema.Types.Mixed, default: null },

        ip: { type: String, default: '' },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
// The history screen filters by module — an anchored prefix on action
// ('fee' -> fee.collect, fee.discount, fee.void) walks this index.
auditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
