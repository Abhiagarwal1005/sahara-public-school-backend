// ---------------------------------------------------------------------------
// Set every student's feeOutstanding back to zero for the active session.
//
//   node scripts/resetFeeOutstanding.js            (dry run — shows the plan)
//   node scripts/resetFeeOutstanding.js --write    (does it)
//
// WHEN THIS IS THE RIGHT THING
//
// feeOutstanding is a DENORMALISED figure: the real record of what a student
// owes is their FeeDemand rows, and the balance is only a running total kept
// alongside them so the app never has to add the demands up. So this is safe
// exactly when there are NO demands behind the balances — a number left over
// from an import or an abandoned attempt, with nothing under it.
//
// It REFUSES when demands or fee receipts exist, because then the balance is
// not junk, it is the school's receivable. Zeroing it there would forgive every
// parent's dues silently and recompute:balances would put them straight back.
// Use the app to waive or collect instead.
// ---------------------------------------------------------------------------

require('dotenv').config();

const mongoose = require('mongoose');

const connectDB = require('../server/src/config/db');
const AcademicSession = require('../server/src/models/academicSession.model');
const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const Transaction = require('../server/src/models/transaction.model');

const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

(async () => {
    await connectDB();

    const session = await AcademicSession.findOne({ isActive: true }).lean();
    if (!session) throw new Error('there is no active session');

    const [students, withDue, totals, demands, receipts] = await Promise.all([
        Student.countDocuments({ session: session.name }),
        Student.countDocuments({ session: session.name, feeOutstanding: { $gt: 0 } }),
        Student.aggregate([
            { $match: { session: session.name } },
            { $group: { _id: null, fee: { $sum: '$feeOutstanding' } } },
        ]),
        FeeDemand.countDocuments({ session: session.name }),
        Transaction.countDocuments({ session: session.name, type: 'FEE', voided: { $ne: true } }),
    ]);

    console.log(`database : ${mongoose.connection.name}`);
    console.log(`session  : ${session.name}\n`);
    console.log(`students on the roll          : ${students}`);
    console.log(`with feeOutstanding > 0       : ${withDue}`);
    console.log(`total that would be cleared   : ₹${totals[0]?.fee || 0}`);
    console.log(`fee demands behind it         : ${demands}`);
    console.log(`fee receipts collected        : ${receipts}\n`);

    // ---- the safety gate ----
    if ((demands > 0 || receipts > 0) && !FORCE) {
        console.log('='.repeat(64));
        console.log('REFUSING — this session has real fee records behind those balances.');
        console.log('');
        console.log(`  ${demands} fee demand(s) and ${receipts} receipt(s) exist.`);
        console.log('  Zeroing the balances would forgive every parent\'s dues without');
        console.log('  a record of it, and recompute:balances would put them all back.');
        console.log('');
        console.log('  Collect or waive through the app instead. If you really mean to');
        console.log('  do this anyway, add --force.');
        console.log('='.repeat(64));
        await mongoose.disconnect();
        process.exit(1);
    }

    if (!demands && !receipts) {
        console.log('No demands and no receipts — these balances have nothing behind them,');
        console.log('so zero is what recompute:balances would work out too.\n');
    }

    if (!WRITE) {
        console.log('='.repeat(64));
        console.log('NOTHING WAS CHANGED — this was only a preview.');
        console.log('\nKarna hai toh yeh chalao:\n');
        console.log('  node scripts/resetFeeOutstanding.js --write'
            + ((demands > 0 || receipts > 0) ? ' --force' : ''));
        console.log('='.repeat(64));
        await mongoose.disconnect();
        return;
    }

    const result = await Student.updateMany(
        { session: session.name },
        { $set: { feeOutstanding: 0 } }
    );

    console.log(`updated ${result.modifiedCount} of ${result.matchedCount} students`);

    const after = await Student.aggregate([
        { $match: { session: session.name } },
        {
            $group: {
                _id: null,
                fee: { $sum: '$feeOutstanding' },
                charge: { $sum: '$chargeOutstanding' },
                stock: { $sum: '$stockOutstanding' },
                credit: { $sum: '$creditBalance' },
            },
        },
    ]);

    const a = after[0] || {};
    console.log('\nAFTER:');
    console.log(`  feeOutstanding   : ₹${a.fee || 0}`);
    console.log(`  chargeOutstanding: ₹${a.charge || 0}`);
    console.log(`  stockOutstanding : ₹${a.stock || 0}`);
    console.log(`  creditBalance    : ₹${a.credit || 0}`);

    await mongoose.disconnect();
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
