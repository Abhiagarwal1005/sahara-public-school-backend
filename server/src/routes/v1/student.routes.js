const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    createStudentSchema,
    updateStudentSchema,
    listStudentsSchema,
    issueIdCardSchema,
    cancelIdCardSchema,
    idParamSchema,
} = require('../../validators/academic.validator');

router.get('/', can('student.view'), validate(listStudentsSchema, 'query'), c.listStudents);
router.get('/defaulters', can('fee.view'), c.defaulters);
// Two segments, so neither can be swallowed by '/:id' below.
router.get('/id-cards/summary', can('student.view'), c.idCardSummary);
router.get('/:id', can('student.view'), validate(idParamSchema, 'params'), c.getStudent);
router.get('/:id/ledger', can('fee.view'), validate(idParamSchema, 'params'), c.getStudentLedger);

router.post('/', can('student.create'), validate(createStudentSchema), c.createStudent);
router.patch('/:id', can('student.edit'), validate(idParamSchema, 'params'), validate(updateStudentSchema), c.updateStudent);

// ---- ID cards ----
// Issuing takes money at the counter, so it has its own permission rather than
// riding on student.edit.
router.post('/:id/id-card', can('student.idcard'), validate(idParamSchema, 'params'), validate(issueIdCardSchema), c.issueIdCard);
// Cancel, not delete — if money was taken it is reversed in the ledger.
router.delete('/:id/id-card', can('student.idcard'), validate(idParamSchema, 'params'), validate(cancelIdCardSchema), c.cancelIdCard);

// Never deleted — status becomes Left. The history never goes away.
router.delete('/:id', can('student.delete'), validate(idParamSchema, 'params'), c.markStudentLeft);

module.exports = router;
