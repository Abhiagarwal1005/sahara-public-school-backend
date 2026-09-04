const router = require('express').Router();

const c = require('../../controllers/lead.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createLeadSchema,
    updateLeadSchema,
    followUpSchema,
    listLeadsSchema,
    phoneQuerySchema,
} = require('../../validators/lead.validator');
const { idParamSchema } = require('../../validators/auth.validator');

// Two segments, so neither can be swallowed by '/:id'
router.get('/summary', can('lead.view'), c.leadSummary);
router.get('/by-phone', can('lead.view'), validate(phoneQuerySchema, 'query'), c.leadsByPhone);

router.get('/', can('lead.view'), validate(listLeadsSchema, 'query'), c.listLeads);
router.get('/:id', can('lead.view'), validate(idParamSchema, 'params'), c.getLead);

router.post('/', can('lead.manage'), validate(createLeadSchema), c.createLead);
router.patch('/:id', can('lead.manage'), validate(idParamSchema, 'params'), validate(updateLeadSchema), c.updateLead);
router.post('/:id/follow-up', can('lead.manage'), validate(idParamSchema, 'params'), validate(followUpSchema), c.addFollowUp);

// Safe to offer: a lead is referenced by nothing, so removing one cannot
// leave an orphan anywhere.
router.delete('/:id', can('lead.manage'), validate(idParamSchema, 'params'), c.deleteLead);

module.exports = router;
