const router = require('express').Router();

const c = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { listAuditSchema, entityHistoryParamsSchema } = require('../../validators/auth.validator');

// ---------------------------------------------------------------------------
// The edit history.
//
// `can('audit.view')` rather than adminOnly: Admin passes every check anyway,
// and this way a school that wants the Principal to see the trail can grant it
// from Settings with no code change — the same rule as every other screen.
//
// It is read-only by design. There is no route here that edits or deletes a
// history row, and there should never be one: a trail somebody can tidy up is
// not a trail.
// ---------------------------------------------------------------------------
router.get('/', can('audit.view'), validate(listAuditSchema, 'query'), c.listAudit);

// One record's own trail — /audit/Student/6863... — for the panel on a
// student, teacher or item.
router.get('/:entity/:id', can('audit.view'), validate(entityHistoryParamsSchema, 'params'), c.entityHistory);

module.exports = router;
