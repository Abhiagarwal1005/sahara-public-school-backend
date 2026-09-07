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

    const rows = await Transaction.find({
        session,
        txnDate: { $gte: date, $lte: endOfDayIST(date) },
    })
        .select('type direction amount mode txnDate party note receiptNo voided reversalOf className')
        .sort({ txnDate: 1 })
        .lean();

    // Voids and reversals both show — that is correct behaviour. A cash
    // book chupchaap edit ho silently edited is not a cash book.
    const totals = rows.reduce(
        (acc, t) => {
            if (t.voided) return acc; // a voided row has its own reversal as a separate row
            const key = t.direction === 'IN' ? 'in' : 'out';
            acc[key] = round2(acc[key] + t.amount);
            if (t.mode === 'Cash') {
                acc[t.direction === 'IN' ? 'cashIn' : 'cashOut'] = round2(
                    acc[t.direction === 'IN' ? 'cashIn' : 'cashOut'] + t.amount
                );
            }
            return acc;
        },
        { in: 0, out: 0, cashIn: 0, cashOut: 0 }
    );

    return {
        date,
        rows,
        totals: {
            ...totals,
            net: round2(totals.in - totals.out),
            netCash: round2(totals.cashIn - totals.cashOut),
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
