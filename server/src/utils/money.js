// ---------------------------------------------------------------------------
// Money is stored in rupees, to 2 decimal places. Fee and stock amounts are
// whole rupees; only the per-day salary calculation produces a fraction
// (30000 / 22 = 1363.636...).
//
// Rule: apply round2 wherever an amount is produced or accumulated. Without
// it, floating point slips like 0.1 + 0.2 = 0.30000000000000004 would
// slowly open a gap between the ledger and the balances, and the recompute
// script would report drift on every run.
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const sum = (numbers) => round2(numbers.reduce((acc, n) => acc + Number(n || 0), 0));

// Is this a valid money amount? (finite, non-negative, at most 2 decimals)
const isValidAmount = (n) => Number.isFinite(n) && n >= 0 && round2(n) === n;

// Spread a positive amount across dependent rows, oldest first —
// both fee collection and vendor payment allocation use this.
//
//   allocate(2600, [{due:1300},{due:1300},{due:1300}])
//     -> [1300, 1300, 0]
const allocate = (amount, dues) => {
    let left = round2(amount);
    return dues.map((due) => {
        const take = round2(Math.min(left, Number(due) || 0));
        left = round2(left - take);
        return take;
    });
};

module.exports = { round2, sum, isValidAmount, allocate };
