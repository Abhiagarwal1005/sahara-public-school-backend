const router = require('express').Router();

const { isAuth, requirePasswordChanged } = require('../../middlewares/isAuth');

// Auth is open — login and refresh happen here
router.use('/auth', require('./auth.routes'));

// ---------------------------------------------------------------------------
// Everything below this point is authenticated.
//
// isAuth is applied in one place, not repeated in every route file. That
// makes the gate fail-closed: a route file added tomorrow is protected
// automatically, with nobody having to remember to add isAuth. This is the
// Solar4U pattern, and it is the safest one.
// ---------------------------------------------------------------------------
router.use(isAuth);

// A user on a temporary password may only change it (that route sits above
// under /auth, before this gate).
router.use(requirePasswordChanged);

router.use('/users', require('./user.routes'));
router.use('/permissions', require('./permission.routes'));
router.use('/sessions', require('./session.routes'));
router.use('/classes', require('./class.routes'));
router.use('/students', require('./student.routes'));
router.use('/leads', require('./lead.routes'));
router.use('/fees', require('./fee.routes'));
router.use('/stock', require('./stock.routes'));
router.use('/sales', require('./sale.routes'));
router.use('/vendors', require('./vendor.routes'));
router.use('/purchases', require('./purchase.routes'));
router.use('/teachers', require('./teacher.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/salary', require('./salary.routes'));
router.use('/expenses', require('./expense.routes'));
router.use('/reports', require('./report.routes'));
router.use('/uploads', require('./upload.routes'));
router.use('/audit', require('./audit.routes'));

module.exports = router;
