// ---------------------------------------------------------------------------
// Voiding a fee receipt when the student has MORE THAN ONE.
//
// This is the case the old void got wrong. Collection allocates oldest-first,
// so voiding used to unwind the student's NEWEST paid months on the reasoning
// that this is the inverse. It is — but only while the student has one
// receipt. With two, voiding the older one took the money back off the months
// the newer one had paid.
//
// What made it survive: every TOTAL still agreed. The student's outstanding,
// the rollups, and recomputeBalances all matched, because only the attribution
// was wrong. So the assertions here are per-month, not per-total — a suite
// that only checked the balance would have passed throughout.
//
// Its own database, for the reason dues.js has one: smoke.js is a single long
// story whose later numbers depend on its earlier ones.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_voidfee?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const Transaction = require('../server/src/models/transaction.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const feeService = require('../server/src/services/fee.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); } };
const section = (t) => console.log(`\n== ${t}`);

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];

// One student's months as { "2026-04": { paid, status } }, so an assertion can
// name the month it is talking about.
const sheet = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).sort({ month: 1 }).lean();
  return Object.fromEntries(rows.map((d) => [d.month, { paid: d.paidAmount, status: d.status }]));
};

const feeOf = async (id) => (await Student.findById(id).lean()).feeOutstanding;

// What the demands themselves say is still owed. The stored balance has to
// equal this or recomputeBalances would report drift.
const derivedDue = async (studentId) => {
  const rows = await FeeDemand.find({ student: studentId }).lean();
  return rows.reduce((sum, d) => sum + Math.max(0, d.amount - d.discount - d.paidAmount), 0);
};

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };
  const sess = await sessionService.create({ name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31') }, actor.id);
  await sessionService.activate(sess._id);
  sessionCache.clear();
  const cls = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 }, actor.id);
  const stu = await studentService.create({ name: 'Aarav Sharma', class: cls._id, phone: '9876543210', admissionDate: new Date('2026-04-05') }, actor.id);

  for (const m of MONTHS) await feeService.generateMonth({ month: m }, actor.id);
  ok('Four months raised at ₹1000', (await feeOf(stu._id)) === 4000, `feeOutstanding ₹${await feeOf(stu._id)}`);

  section('Two receipts, oldest-first each time');
  const r1 = await feeService.collect({ studentId: String(stu._id), amount: 2000, mode: 'Cash' }, actor);
  ok('Receipt 1 covers April + May', r1.covered.map((c) => c.month).join(',') === '2026-04,2026-05', r1.covered.map((c) => c.month).join(','));

  const r2 = await feeService.collect({ studentId: String(stu._id), amount: 2000, mode: 'Cash' }, actor);
  ok('Receipt 2 covers June + July', r2.covered.map((c) => c.month).join(',') === '2026-06,2026-07', r2.covered.map((c) => c.month).join(','));
  ok('Nothing outstanding now', (await feeOf(stu._id)) === 0);

  section('The allocation is stored on the receipt');
  const t1 = await Transaction.findById(r1.transactionId).lean();
  ok('Receipt 1 recorded 2 covered lines', t1.covered?.length === 2, `${t1.covered?.length} line(s)`);
  ok('...with the months it paid', t1.covered.map((c) => c.month).join(',') === '2026-04,2026-05', t1.covered.map((c) => c.month).join(','));
  ok('...and ₹1000 on each', t1.covered.every((c) => c.amount === 1000));
  ok('...pointing at real demands', t1.covered.every((c) => c.demand));

  section('Void receipt 1 — it must unwind APRIL and MAY, not June and July');
  await feeService.voidReceipt(String(r1.transactionId), 'cheque bounced', actor);
  const s = await sheet(stu._id);

  ok('April went back to Unpaid', s['2026-04'].status === 'Unpaid' && s['2026-04'].paid === 0, `${s['2026-04'].status}, paid ₹${s['2026-04'].paid}`);
  ok('May went back to Unpaid', s['2026-05'].status === 'Unpaid' && s['2026-05'].paid === 0, `${s['2026-05'].status}, paid ₹${s['2026-05'].paid}`);
  ok('June is STILL Paid — receipt 2 stands', s['2026-06'].status === 'Paid' && s['2026-06'].paid === 1000, `${s['2026-06'].status}, paid ₹${s['2026-06'].paid}`);
  ok('July is STILL Paid — receipt 2 stands', s['2026-07'].status === 'Paid' && s['2026-07'].paid === 1000, `${s['2026-07'].status}, paid ₹${s['2026-07'].paid}`);

  section('And the totals still add up');
  ok('Outstanding back to ₹2000', (await feeOf(stu._id)) === 2000, `₹${await feeOf(stu._id)}`);
  ok('Stored balance matches the demands — no drift', (await derivedDue(stu._id)) === (await feeOf(stu._id)), `derived ₹${await derivedDue(stu._id)} vs stored ₹${await feeOf(stu._id)}`);
  ok('Receipt 2 untouched', !(await Transaction.findById(r2.transactionId).lean()).voided);
  ok('Receipt 1 marked void', (await Transaction.findById(r1.transactionId).lean()).voided);
  const rev = await Transaction.find({ type: 'REVERSAL' }).lean();
  ok('One reversal, for ₹2000', rev.length === 1 && rev[0].amount === 2000, `${rev.length} reversal(s)`);

  section('Collecting again picks the right months back up');
  const r3 = await feeService.collect({ studentId: String(stu._id), amount: 1000, mode: 'Cash' }, actor);
  ok('Next collection starts at April', r3.covered[0].month === '2026-04', r3.covered[0].month);

  section('A receipt written before `covered` existed is still voidable');
  // Simulate pre-upgrade data: the allocation was never stored.
  const t3 = await Transaction.findById(r3.transactionId).lean();
  await Transaction.updateOne({ _id: t3._id }, { $unset: { covered: '' } });
  ok('Legacy receipt has no allocation', !(await Transaction.findById(t3._id).lean()).covered?.length);

  const before = await feeOf(stu._id);
  await feeService.voidReceipt(String(t3._id), 'legacy void', actor);
  ok('Void still works', (await Transaction.findById(t3._id).lean()).voided);
  ok('Outstanding rose by the full ₹1000', (await feeOf(stu._id)) === before + 1000, `₹${before} -> ₹${await feeOf(stu._id)}`);
  ok('Still no drift after the fallback path', (await derivedDue(stu._id)) === (await feeOf(stu._id)), `derived ₹${await derivedDue(stu._id)} vs stored ₹${await feeOf(stu._id)}`);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
