const router = require('express').Router();

const c = require('../../controllers/staff.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { heavyLimiter } = require('../../middlewares/rateLimiter');
const {
    generateSalarySchema,
    updateSlipSchema,
    adjustmentSchema,
    adjustmentParamsSchema,
    paySlipSchema,
} = require('../../validators/staff.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/slips', can('salary.view'), c.listSlips);
router.get('/slips/:id', can('salary.view'), validate(idParamSchema, 'params'), c.getSlip);

router.post('/generate', can('salary.generate'), heavyLimiter, validate(generateSalarySchema), c.generateSalary);

// Only a Draft is editable — after approval the slip is frozen
router.patch('/slips/:id', can('salary.generate'), validate(idParamSchema, 'params'), validate(updateSlipSchema), c.updateSlip);

// Bonus / arrear / fine on a draft. Same permission as editing one.
router.post('/slips/:id/adjustment', can('salary.generate'), validate(idParamSchema, 'params'), validate(adjustmentSchema), c.addAdjustment);
router.delete('/slips/:id/adjustment/:adjustmentId', can('salary.generate'), validate(adjustmentParamsSchema, 'params'), c.removeAdjustment);

// Discard a draft so the next generate rebuilds it from current attendance
router.delete('/slips/:id', can('salary.generate'), validate(idParamSchema, 'params'), c.discardSlip);

router.post('/slips/:id/approve', can('salary.approve'), validate(idParamSchema, 'params'), c.approveSlip);
router.post('/slips/:id/pay', can('salary.pay'), validate(idParamSchema, 'params'), validate(paySlipSchema), c.paySlip);

module.exports = router;
