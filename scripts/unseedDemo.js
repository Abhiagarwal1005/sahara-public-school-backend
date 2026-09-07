// ---------------------------------------------------------------------------
// Removes exactly what seedDemo.js created — and nothing else.
//
//   node scripts/unseedDemo.js --dry     # show what would go (default)
//   node scripts/unseedDemo.js --yes     # actually delete
//
// It works off scripts/.demo-seed-ids.json, which seedDemo.js writes. Only
// documents whose _id is in that file, or which reference one of them, are
// touched. Data the school entered by hand is never matched, because its ids
// are not in the file.
//
// Order matters: the money rows come out before the master records they point
// at, so nothing is left orphaned if the run stops halfway.
//
// The rollups are the one thing that cannot be deleted by id — they are
// shared counters, not per-record rows. So they are rebuilt at the end from
// what survives, which is exactly what recomputeBalances --fix does.
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { validateEnv } = require('../server/src/config/env');
validateEnv();

const Student = require('../server/src/models/student.model');
const Teacher = require('../server/src/models/teacher.model');
const Lead = require('../server/src/models/lead.model');
const Vendor = require('../server/src/models/vendor.model');
const StockItem = require('../server/src/models/stockItem.model');
const StockMovement = require('../server/src/models/stockMovement.model');
const StockSale = require('../server/src/models/stockSale.model');
const Purchase = require('../server/src/models/purchase.model');
const VendorPayment = require('../server/src/models/vendorPayment.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const Transaction = require('../server/src/models/transaction.model');
const Expense = require('../server/src/models/expense.model');
const ExpenseCategory = require('../server/src/models/expenseCategory.model');
const SalarySlip = require('../server/src/models/salarySlip.model');
const TeacherAttendance = require('../server/src/models/teacherAttendance.model');
const SchoolClass = require('../server/src/models/schoolClass.model');

const IDS_FILE = path.join(__dirname, '.demo-seed-ids.json');
const GO = process.argv.includes('--yes');

const run = async () => {
    if (!fs.existsSync(IDS_FILE)) {
        throw new Error(`${IDS_FILE} not found — nothing to undo (it is written by seedDemo.js)`);
    }

    const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    const oid = (list) => (list || []).map((x) => new mongoose.Types.ObjectId(x));

    const students = oid(ids.students);
    const teachers = oid(ids.teachers);
    const vendors = oid(ids.vendors);
    const items = oid(ids.stockItems);
    const leads = oid(ids.leads);
    const expenses = oid(ids.expenses);
    const categories = oid(ids.expenseCategories);

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

    console.log(`Undo list from ${ids.seededAt}`);
    console.log(`  students ${students.length} · teachers ${teachers.length} · vendors ${vendors.length} · items ${items.length} · leads ${leads.length} · expenses ${expenses.length}\n`);

    // The ledger rows to remove: those raised BY a seeded record (party) and
    // those raised FOR one (refModel/refId), plus any reversal pointing at
    // one of them.
    const sales = await StockSale.find({ student: { $in: students } }).select('_id').lean();
    const purchases = await Purchase.find({ vendor: { $in: vendors } }).select('_id').lean();
    const payments = await VendorPayment.find({ vendor: { $in: vendors } }).select('_id').lean();
    const slips = await SalarySlip.find({ teacher: { $in: teachers } }).select('_id').lean();

    const refIds = [
        ...sales.map((s) => s._id), ...purchases.map((p) => p._id),
        ...payments.map((p) => p._id), ...slips.map((s) => s._id),
        ...expenses, ...students,
    ];

    const txnFilter = {
        $or: [
            { 'party.ref': { $in: [...students, ...vendors, ...teachers] } },
            { refId: { $in: refIds } },
        ],
    };
    const txns = await Transaction.find(txnFilter).select('_id').lean();
    const txnIds = txns.map((t) => t._id);

    const plan = [
        ['transactions (incl. reversals)', Transaction, { $or: [{ _id: { $in: txnIds } }, { reversalOf: { $in: txnIds } }] }],
        ['fee demands', FeeDemand, { student: { $in: students } }],
        ['stock sales', StockSale, { student: { $in: students } }],
        ['purchases', Purchase, { vendor: { $in: vendors } }],
        ['vendor payments', VendorPayment, { vendor: { $in: vendors } }],
        ['salary slips', SalarySlip, { teacher: { $in: teachers } }],
        ['teacher attendance', TeacherAttendance, { teacher: { $in: teachers } }],
        ['stock movements', StockMovement, { item: { $in: items } }],
        ['expenses', Expense, { _id: { $in: expenses } }],
        ['expense categories', ExpenseCategory, { _id: { $in: categories } }],
        ['stock items', StockItem, { _id: { $in: items } }],
        ['vendors', Vendor, { _id: { $in: vendors } }],
        ['leads', Lead, { _id: { $in: leads } }],
        ['teachers', Teacher, { _id: { $in: teachers } }],
        ['students', Student, { _id: { $in: students } }],
    ];

    let total = 0;
    for (const [label, Model, filter] of plan) {
        const count = await Model.countDocuments(filter);
        total += count;
        console.log(`  ${String(count).padStart(6)}  ${label}`);
    }

    if (!GO) {
        console.log(`\n${total} documents would be deleted. Re-run with --yes to do it.`);
        await mongoose.disconnect();
        process.exit(0);
    }

    console.log('\nDeleting...');
    for (const [label, Model, filter] of plan) {
        const res = await Model.deleteMany(filter);
        if (res.deletedCount) console.log(`  removed ${res.deletedCount} ${label}`);
    }

    // The class roster counts were $inc'd on the way in, so put them back from
    // what is actually left rather than subtracting what we think we added.
    const classes = await SchoolClass.find().select('_id').lean();
    await SchoolClass.bulkWrite(
        await Promise.all(
            classes.map(async (c) => ({
                updateOne: {
                    filter: { _id: c._id },
                    update: { $set: { studentCount: await Student.countDocuments({ class: c._id, status: 'Active' }) } },
                },
            }))
        ),
        { ordered: false }
    );
    console.log(`  reset studentCount on ${classes.length} classes`);

    fs.unlinkSync(IDS_FILE);

    console.log('\nDone.');
    console.log('Now run:  npm run recompute:balances -- --fix    (rebuilds the monthly rollups)');

    await mongoose.disconnect();
    process.exit(0);
};

run().catch((err) => {
    console.error('Unseed failed:', err.message);
    process.exit(1);
});
