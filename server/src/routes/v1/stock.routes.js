const router = require('express').Router();

const c = require('../../controllers/stock.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createItemSchema,
    updateItemSchema,
    adjustSchema,
    listItemsSchema,
} = require('../../validators/stock.validator');
const { idParamSchema } = require('../../validators/auth.validator');

router.get('/items', can('stock.view'), validate(listItemsSchema, 'query'), c.listItems);
router.get('/low', can('stock.view'), c.lowStock);
router.get('/items/:id', can('stock.view'), validate(idParamSchema, 'params'), c.getItem);
router.get('/items/:id/movements', can('stock.view'), validate(idParamSchema, 'params'), c.movements);

router.post('/items', can('stock.manage'), validate(createItemSchema), c.createItem);
router.patch('/items/:id', can('stock.manage'), validate(idParamSchema, 'params'), validate(updateItemSchema), c.updateItem);

// Adjustment is its own permission — it is the door through which stock
// can move with no bill or sale, so the Accountant does not get it by default.
router.post('/adjust', can('stock.adjust'), validate(adjustSchema), c.adjust);

module.exports = router;
