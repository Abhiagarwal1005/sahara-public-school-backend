const router = require('express').Router();

const c = require('../../controllers/payment.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { listPaymentsSchema } = require('../../validators/finance.validator');
const { idParamSchema } = require('../../validators/auth.validator');

// ---------------------------------------------------------------------------
// The second pair of eyes on money collected from students.
//
// One permission covers both reading and ticking: somebody who cannot sign a
// payment off has no reason to sit in front of the queue. `can('payment.verify')`
// rather than adminOnly, so a school where the Principal does the daily check
// can be set up from Settings with no code change — the same rule the edit
// history follows.
//
// There is no route here that edits an amount, a date or a receipt number, and
// there should never be one. This screen exists to CONFIRM the cash book, not
// to correct it; a wrong entry is voided through the fee module, which writes a
// reversal, and that correction is itself visible in this queue.
// ---------------------------------------------------------------------------
router.get('/', can('payment.verify'), validate(listPaymentsSchema, 'query'), c.listPayments);

router.post('/:id/verify', can('payment.verify'), validate(idParamSchema, 'params'), c.verifyPayment);
// Undo, for a tick put on the wrong row. Audited exactly like the tick itself.
router.post('/:id/unverify', can('payment.verify'), validate(idParamSchema, 'params'), c.unverifyPayment);

module.exports = router;
