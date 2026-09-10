const MonthlyRollup = require('../models/monthlyRollup.model');
const Transaction = require('../models/transaction.model');
const Student = require('../models/student.model');
const Vendor = require('../models/vendor.model');
const SalarySlip = require('../models/salarySlip.model');
const sessionService = require('./session.service');
const stockService = require('./stock.service');
const vendorService = require('./vendor.service');
const { round2 } = require('../utils/money');
const { monthKeyIST, startOfDayIST, endOfDayIST } = require('../utils/istDate');

// The modes the office reconciles separately at the end of a day: the cash box
// is counted, the UPI app is opened, the bank statement is checked, the cheque
// book is flipped through. They are always shown, even at zero, so the row of
// tiles keeps a fixed shape somebody can read at a glance.
//
// 'Adjustment' is the fifth mode a Transaction can carry and is deliberately
// NOT in this list — it moves no real money and would read ₹0 every day. It is
// still added on any day it appears, because a mode that moved money and is
// missing from the tiles would make them stop adding up to Money in / Money out.
const RECONCILED_MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];

// ---------------------------------------------------------------------------
// DASHBOARD
//
// The important point: not one aggregation here runs over transaction
// rows. Every monthly figure comes from a single MonthlyRollup document,
// and student and vendor outstanding from their own denormalised fields.
//
// So this screen is as fast after three years of data as it was on day
// one — which is what matters on M0's shared CPU.
// ---------------------------------------------------------------------------
const dashboard = async () => {
    const session = await sessionService.getActiveSessionName();
    const month = monthKeyIST();

    const [rollup, studentDues, vendorDues, unpaidSlips, low] = await Promise.all([
        MonthlyRollup.findOne({ session, month, scope: 'SCHOOL', class: null }).lean(),

        // A small aggregation, but over the Student collection (a few hundred
        // rows) with both fields indexed — not over the transaction ledger.
        Student.aggregate([
            { $match: { session, status: 'Active' } },
            {
                $group: {
                    _id: null,
                    feeOutstanding: { $sum: '$feeOutstanding' },
                    stockOutstanding: { $sum: '$stockOutstanding' },
                    withDues: { $sum: { $cond: [{ $gt: ['$feeOutstanding', 0] }, 1, 0] } },
                    total: { $sum: 1 },
                },
            },
        ]),

        Vendor.aggregate([
            { $match: { isActive: true, outstanding: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: '$outstanding' }, count: { $sum: 1 } } },
        ]),

        SalarySlip.countDocuments({ session, month, status: { $in: ['Draft', 'Approved'] } }),

        stockService.lowStock(),
    ]);

    const s = studentDues[0] || {};
    const v = vendorDues[0] || {};
    const r = rollup || {};

    const feeExpected = round2(r.feeExpected || 0);
    const feeCollected = round2(r.feeCollected || 0);
    const feeDiscount = round2(r.feeDiscount || 0);
    const net = round2(feeExpected - feeDiscount);

    return {
        session,
        month,
        fees: {
            expected: feeExpected,
            collected: feeCollected,
            discount: feeDiscount,
            rate: net > 0 ? Math.round((feeCollected / net) * 100) : 0,
        },
        outstanding: {
            fee: round2(s.feeOutstanding || 0),
            stock: round2(s.stockOutstanding || 0),
            total: round2((s.feeOutstanding || 0) + (s.stockOutstanding || 0)),
            studentsWithDues: s.withDues || 0,
            activeStudents: s.total || 0,
        },
        vendors: { outstanding: round2(v.total || 0), count: v.count || 0 },
        // Its own line, because "how much came in from ID cards" is a question
        // the school asks separately from fees.
        idCards: { collected: round2(r.idCardCollected || 0) },
        spend: {
            expenses: round2(r.expenses || 0),
            salaries: round2(r.salaries || 0),
            vendorPaid: round2(r.vendorPaid || 0),
            purchases: round2(r.purchases || 0),
        },
        cash: { in: round2(r.cashIn || 0), out: round2(r.cashOut || 0), net: round2((r.cashIn || 0) - (r.cashOut || 0)) },
        alerts: {
            unpaidSalarySlips: unpaidSlips,
            lowStock: low.slice(0, 10),
            lowStockCount: low.length,
        },
    };
};

// ---------------------------------------------------------------------------
// DAY BOOK — every cash movement for a day. The office reconciles the cash box with it.
// ---------------------------------------------------------------------------
const daybook = async (dateInput) => {
    const session = await sessionService.getActiveSessionName();
    const date = startOfDayIST(dateInput || new Date());

    const raw = await Transaction.find({
        session,
        txnDate: { $gte: date, $lte: endOfDayIST(date) },
    })
        .select(
            'type direction amount mode txnDate party note receiptNo voided reversalOf className ' +
                'verified verifiedAt verifiedByName'
        )
        .sort({ txnDate: 1 })
        .lean();

    // WHICH rows carry a verification tick is decided in one place — the model —
    // and sent down as a flag. Letting each screen re-derive "student money in,
    // not voided" is how the day book and a student's own ledger end up
    // disagreeing about the same receipt.
    const rows = raw.map((t) => ({ ...t, verifiable: Transaction.isVerifiable(t) }));

    // ONE pass produces both the day's totals and the same money split by
    // payment mode. Deriving the cash figures from the same buckets rather than
    // adding them up a second time is the point: two separate sums over the
    // same rows is how a cash line and a mode line start disagreeing.
    //
    // Voids and reversals both show in `rows` — that is correct behaviour. A
    // cash book that can be silently edited is not a cash book. But a VOIDED
    // row is skipped in the arithmetic, because its REVERSAL is a row of its
    // own carrying the opposite direction; counting both would double it.
    const modes = new Map(RECONCILED_MODES.map((m) => [m, { mode: m, in: 0, out: 0 }]));
    let moneyIn = 0;
    let moneyOut = 0;

    for (const t of rows) {
        if (t.voided) continue;

        if (!modes.has(t.mode)) modes.set(t.mode, { mode: t.mode, in: 0, out: 0 });
        const bucket = modes.get(t.mode);

        if (t.direction === 'IN') {
            bucket.in = round2(bucket.in + t.amount);
            moneyIn = round2(moneyIn + t.amount);
        } else {
            bucket.out = round2(bucket.out + t.amount);
            moneyOut = round2(moneyOut + t.amount);
        }
    }

    // In RECONCILED_MODES order, with any other mode that actually moved money
    // appended after it.
    const byMode = [...modes.values()].map((m) => ({ ...m, net: round2(m.in - m.out) }));
    const cash = modes.get('Cash');

    return {
        date,
        rows,
        // Mode by mode, so the cash box, the UPI app, the bank statement and the
        // cheque book can each be reconciled on their own instead of against one
        // combined figure that none of them will ever match.
        byMode,
        totals: {
            in: moneyIn,
            out: moneyOut,
            net: round2(moneyIn - moneyOut),
            // Cash keeps its own named fields: it is the one total somebody
            // physically counts, and the dashboard's "cash today" line reads it.
            cashIn: cash.in,
            cashOut: cash.out,
            netCash: round2(cash.in - cash.out),
        },
    };
};

// ---------------------------------------------------------------------------
// OUTSTANDING — both directions. "What is owed to us, what we owe"
// ---------------------------------------------------------------------------
const outstanding = async () => {
    const session = await sessionService.getActiveSessionName();

    const [byClass, vendorAgeing] = await Promise.all([
        Student.aggregate([
            {
                $match: {
                    session,
                    status: 'Active',
                    $or: [{ feeOutstanding: { $gt: 0 } }, { stockOutstanding: { $gt: 0 } }],
                },
            },
            {
                $group: {
                    _id: '$class',
                    className: { $first: '$className' },
                    students: { $sum: 1 },
                    fee: { $sum: '$feeOutstanding' },
                    stock: { $sum: '$stockOutstanding' },
                },
            },
            { $sort: { fee: -1 } },
        ]),
        vendorService.ageing(),
    ]);

    const students = byClass.map((c) => ({
        classId: c._id,
        className: c.className,
        students: c.students,
        fee: round2(c.fee),
        stock: round2(c.stock),
        total: round2(c.fee + c.stock),
    }));

    const receivable = round2(students.reduce((s, c) => s + c.total, 0));
    const payable = vendorAgeing.totals.total;

    return {
        receivable: { total: receivable, byClass: students },
        payable: { total: payable, ...vendorAgeing },
        net: round2(receivable - payable),
    };
};

// ---------------------------------------------------------------------------
// INCOME vs EXPENSE — month by month across the session. Straight from rollups,
// so this is a small query.
// ---------------------------------------------------------------------------
const incomeVsExpense = async () => {
    const session = await sessionService.getActiveSessionName();

    const rows = await MonthlyRollup.find({ session, scope: 'SCHOOL' })
        .select('month feeCollected stockSales idCardCollected otherIncome expenses salaries vendorPaid cashIn cashOut')
        .sort({ month: 1 })
        .lean();

    const months = rows.map((r) => {
        // Every income head has to be named here. A head that exists in the
        // rollup but is left out of this sum makes the month's income quietly
        // too low — which is exactly the kind of wrong number nobody notices.
        const income = round2(
            (r.feeCollected || 0) + (r.stockSales || 0) + (r.idCardCollected || 0) + (r.otherIncome || 0)
        );
        const spend = round2((r.expenses || 0) + (r.salaries || 0) + (r.vendorPaid || 0));
        return {
            month: r.month,
            feeCollected: round2(r.feeCollected || 0),
            stockSales: round2(r.stockSales || 0),
            idCards: round2(r.idCardCollected || 0),
            otherIncome: round2(r.otherIncome || 0),
            totalIn: income,
            expenses: round2(r.expenses || 0),
            salaries: round2(r.salaries || 0),
            vendorPaid: round2(r.vendorPaid || 0),
            totalOut: spend,
            net: round2(income - spend),
        };
    });

    const totals = months.reduce(
        (acc, m) => ({
            totalIn: round2(acc.totalIn + m.totalIn),
            totalOut: round2(acc.totalOut + m.totalOut),
        }),
        { totalIn: 0, totalOut: 0 }
    );

    return { session, months, totals: { ...totals, net: round2(totals.totalIn - totals.totalOut) } };
};

// Fee collection trend — for the dashboard chart
const feeTrend = async () => {
    const session = await sessionService.getActiveSessionName();

    const rows = await MonthlyRollup.find({ session, scope: 'SCHOOL' })
        .select('month feeExpected feeCollected feeDiscount')
        .sort({ month: 1 })
        .lean();

    return rows.map((r) => ({
        month: r.month,
        expected: round2(r.feeExpected || 0),
        collected: round2(r.feeCollected || 0),
        discount: round2(r.feeDiscount || 0),
    }));
};

module.exports = { dashboard, daybook, outstanding, incomeVsExpense, feeTrend };
