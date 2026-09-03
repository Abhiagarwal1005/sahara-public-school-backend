const router = require('express').Router();

const c = require('../../controllers/staff.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const {
    markTeacherAttendanceSchema,
    markClassAttendanceSchema,
} = require('../../validators/staff.validator');

// ---- teachers ----
router.get('/teachers', can('attendance.teacher.view'), c.teacherSheet);
router.get('/teachers/monthly', can('attendance.teacher.view'), c.teacherGrid);
// The whole sheet in one call — the service turns it into one bulkWrite
router.post('/teachers', can('attendance.teacher.mark'), validate(markTeacherAttendanceSchema), c.markTeacherAttendance);

// ---- classes (totals only, not per student) ----
router.get('/classes', can('attendance.class.view'), c.classSheet);
router.get('/classes/monthly', can('attendance.class.view'), c.classMonthly);
router.post('/classes', can('attendance.class.mark'), validate(markClassAttendanceSchema), c.markClassAttendance);

module.exports = router;
