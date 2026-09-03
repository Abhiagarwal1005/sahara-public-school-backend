const router = require('express').Router();

const c = require('../../controllers/stock.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createSaleSchema,
    listSalesSchema,
    collectStockDuesSchema,
} = require('../../validators/stock.validator');
const { voidSchema } = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/', can('stock.view'), validate(listSalesSchema, 'query'), c.listSales);
// Two segments, so this can never be swallowed by '/:id' below.
router.get('/dues/:id', can('fee.collect'), validate(idParamSchema, 'params'), c.studentStockDues);
router.get('/:id', can('stock.view'), validate(idParamSchema, 'params'), c.getSale);

router.post('/', can('stock.sell'), validate(createSaleSchema), c.createSale);
// Taking money at the counter is the same act as collecting a fee, so it
// rides on the same permission rather than adding a 43rd key.
router.post('/collect', can('fee.collect'), validate(collectStockDuesSchema), c.collectStockDues);
router.post('/:id/void', can('stock.adjust'), validate(idParamSchema, 'params'), validate(voidSchema), c.voidSale);

module.exports = router;
