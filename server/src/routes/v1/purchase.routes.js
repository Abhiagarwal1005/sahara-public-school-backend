const router = require('express').Router();

const c = require('../../controllers/purchase.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createPurchaseSchema,
    updatePurchaseSchema,
    listPurchasesSchema,
} = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/', can('purchase.view'), validate(listPurchasesSchema, 'query'), c.listPurchases);
router.get('/:id', can('purchase.view'), validate(idParamSchema, 'params'), c.getPurchase);

router.post('/', can('purchase.create'), validate(createPurchaseSchema), c.createPurchase);

// Only note, image and date are editable — not items or amounts. Changing
// a bill's quantity would make the stock movements lie.
router.patch('/:id', can('purchase.edit'), validate(idParamSchema, 'params'), validate(updatePurchaseSchema), c.updatePurchase);

module.exports = router;
