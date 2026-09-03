const router = require('express').Router();

const c = require('../../controllers/misc.controller');
const { can } = require('../../middlewares/can');

// These endpoints all read pre-aggregated rollups or denormalised balances
// — no aggregation runs over the transaction ledger. That is why these
// stay just as fast after three years of data.
router.get('/dashboard', can('report.dashboard'), c.dashboard);
router.get('/daybook', can('report.daybook'), c.daybook);
router.get('/outstanding', can('report.outstanding'), c.outstanding);
router.get('/income-expense', can('report.dashboard'), c.incomeVsExpense);
router.get('/fee-trend', can('report.dashboard'), c.feeTrend);

module.exports = router;
