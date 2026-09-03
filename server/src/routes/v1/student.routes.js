const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createStudentSchema,
    updateStudentSchema,
    listStudentsSchema,
    idParamSchema,
} = require('../../validators/academic.validator');

router.get('/', can('student.view'), validate(listStudentsSchema, 'query'), c.listStudents);
router.get('/defaulters', can('fee.view'), c.defaulters);
router.get('/:id', can('student.view'), validate(idParamSchema, 'params'), c.getStudent);
router.get('/:id/ledger', can('fee.view'), validate(idParamSchema, 'params'), c.getStudentLedger);

router.post('/', can('student.create'), validate(createStudentSchema), c.createStudent);
router.patch('/:id', can('student.edit'), validate(idParamSchema, 'params'), validate(updateStudentSchema), c.updateStudent);

// Never deleted — status becomes Left. The history never goes away.
router.delete('/:id', can('student.delete'), validate(idParamSchema, 'params'), c.markStudentLeft);

module.exports = router;
