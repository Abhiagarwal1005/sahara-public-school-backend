const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Makes multi-document writes atomic.
//
// Collecting a fee touches 4 documents (Transaction, FeeDemand, Student,
// MonthlyRollup). If the third failed, the receipt would exist while the
// student's outstanding stayed unchanged — the ledger and the balance
// telling different stories. A transaction makes it all four or none.
//
// Atlas is a replica set (M0 included), so transactions are supported.
//
// Retry on TransientTransactionError: a write conflict on a replica set is
// is normal (two people touching the same document at once). Mongo itself
// marks it retryable — without honouring that label we would fail a
// request that would have succeeded on a second run.
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

const withTransaction = async (fn) => {
    const session = await mongoose.startSession();

    try {
        for (let attempt = 1; ; attempt += 1) {
            try {
                let result;

                await session.withTransaction(
                    async () => {
                        result = await fn(session);
                    },
                    {
                        readConcern: { level: 'local' },
                        // majority: a commit is not confirmed until it is durable on
                        // a majority of nodes. Money data does not
                        // settle for less than that.
                        writeConcern: { w: 'majority' },
                    }
                );

                return result;
            } catch (err) {
                const transient =
                    err?.hasErrorLabel?.('TransientTransactionError') ||
                    err?.hasErrorLabel?.('UnknownTransactionCommitResult');

                if (!transient || attempt >= MAX_RETRIES) throw err;

                // Small exponential backoff — retrying instantly tends to hit
                // conflict happens again.
                await new Promise((r) => setTimeout(r, 40 * attempt));
            }
        }
    } finally {
        await session.endSession();
    }
};

module.exports = withTransaction;
