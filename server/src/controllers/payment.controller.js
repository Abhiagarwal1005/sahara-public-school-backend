const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const paymentService = require('../services/payment.service');
const audit = require('../services/audit.service');

// ---------------------------------------------------------------------------
// The daily check on money collected from students.
//
// Everything here is read-and-flag. Nothing in this controller can move a
// rupee — see payment.service.js for why that is the point rather than a
// limitation.
// ---------------------------------------------------------------------------

const listPayments = asyncHandler(async (req, res) => {
    const data = await paymentService.listForDate(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Payments'));
});

// Ticking a row is exactly the kind of thing somebody gets asked about later
// ("who signed this off?"), so both directions are audited — and un-ticking
// especially, since that is the one that removes an assurance.
const describe = (p) =>
    `${p?.receiptNo ? `${p.receiptNo} · ` : ''}₹${p?.amount ?? '?'} from ${p?.party?.name || 'a student'}`;

const applyVerification = (verified) =>
    asyncHandler(async (req, res) => {
        const actor = { id: req.userId, name: req.user.name, role: req.role };
        const { payment, changed } = await paymentService.setVerified(req.params.id, verified, actor);

        // A no-op writes no history row. Two people ticking the same payment in
        // the same second should leave one entry, not two identical ones.
        if (changed) {
            audit.log({
                ...audit.fromRequest(req),
                action: verified ? 'payment.verify' : 'payment.unverify',
                entity: 'Transaction',
                entityId: req.params.id,
                summary: `${verified ? 'Verified' : 'Verification removed'}: ${describe(payment)}`,
                before: { verified: !verified },
                after: { verified },
            });
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                { payment, changed },
                changed
                    ? verified
                        ? 'Payment verified'
                        : 'Verification removed'
                    : verified
                      ? 'This payment was already verified'
                      : 'This payment was already unverified'
            )
        );
    });

const verifyPayment = applyVerification(true);
const unverifyPayment = applyVerification(false);

module.exports = { listPayments, verifyPayment, unverifyPayment };
