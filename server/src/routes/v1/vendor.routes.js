const router = require('express').Router();

const c = require('../../controllers/purchase.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createVendorSchema,
    updateVendorSchema,
    payVendorSchema,
} = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/', can('vendor.view'), c.listVendors);
router.get('/ageing', can('report.outstanding'), c.ageing);
router.get('/:id', can('vendor.view'), validate(idParamSchema, 'params'), c.getVendor);
router.get('/:id/statement', can('vendor.view'), validate(idParamSchema, 'params'), c.statement);
router.get('/:id/payments', can('vendor.view'), validate(idParamSchema, 'params'), c.listPayments);

router.post('/', can('vendor.manage'), validate(createVendorSchema), c.createVendor);
router.patch('/:id', can('vendor.manage'), validate(idParamSchema, 'params'), validate(updateVendorSchema), c.updateVendor);

router.post('/pay', can('vendor.pay'), validate(payVendorSchema), c.payVendor);

module.exports = router;
