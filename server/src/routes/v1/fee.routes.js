const router = require('express').Router();

const c = require('../../controllers/fee.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { heavyLimiter } = require('../../middlewares/rateLimiter');
const {
    generateFeesSchema,
    collectFeeSchema,
    discountSchema,
    voidSchema,
    listDemandsSchema,
} = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/demands', can('fee.view'), validate(listDemandsSchema, 'query'), c.listDemands);
router.get('/pending/:studentId', can('fee.view'), c.pendingForStudent);
router.get('/summary', can('report.fee'), c.summary);
router.get('/receipts/:id', can('fee.view'), validate(idParamSchema, 'params'), c.getReceipt);

// Generation runs across the whole school — heavyLimiter because there is
// no valid reason to repeat it (and being idempotent, a double-click is
// harmless anyway).
router.post('/generate', can('fee.generate'), heavyLimiter, validate(generateFeesSchema), c.generate);

router.post('/collect', can('fee.collect'), validate(collectFeeSchema), c.collect);
router.post('/demands/:id/discount', can('fee.discount'), validate(idParamSchema, 'params'), validate(discountSchema), c.applyDiscount);
router.post('/receipts/:id/void', can('fee.void'), validate(idParamSchema, 'params'), validate(voidSchema), c.voidReceipt);

module.exports = router;
