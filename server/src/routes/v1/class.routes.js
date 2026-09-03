const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { createClassSchema, updateClassSchema, idParamSchema } = require('../../validators/academic.validator');

router.get('/', can('class.view'), c.listClasses);
router.post('/', can('class.manage'), validate(createClassSchema), c.createClass);
router.patch('/:id', can('class.manage'), validate(idParamSchema, 'params'), validate(updateClassSchema), c.updateClass);
router.delete('/:id', can('class.manage'), validate(idParamSchema, 'params'), c.deactivateClass);

module.exports = router;
