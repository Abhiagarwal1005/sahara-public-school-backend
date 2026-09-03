const AuditLog = require('../models/auditLog.model');

// ---------------------------------------------------------------------------
// Writing an audit entry must never fail the real work.
//
// If the audit insert fails (network blip, storage full), failing the fee
// collection would be the wrong trade-off — the money has arrived and the
// receipt is printed. So this is fire-and-forget and errors are only logged.
//
// For the same reason it never runs inside a mongoose transaction: a
// transaction means "all or nothing", and the audit should not be part of
// that "all".
// ---------------------------------------------------------------------------
const log = ({ actor, action, entity, entityId = null, summary = '', before = null, after = null, ip = '' }) => {
    if (!actor) return;

    AuditLog.create({
        actor: actor.id || actor._id,
        actorName: actor.name || '',
        actorRole: actor.role || '',
        action,
        entity,
        entityId,
        summary,
        before,
        after,
        ip,
    }).catch((err) => {
        console.error(`[audit] ${action} could not be logged: ${err.message}`);
    });
};

// Pull actor and IP off the request so controllers can log in one line
const fromRequest = (req) => ({
    actor: { id: req.userId, name: req.user?.name, role: req.role },
    ip: req.ip || '',
});

const list = async ({ page = 1, limit = 50, entity, entityId } = {}) => {
    const filter = {};
    if (entity) filter.entity = entity;
    if (entityId) filter.entityId = entityId;

    return AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();
};

module.exports = { log, fromRequest, list };
