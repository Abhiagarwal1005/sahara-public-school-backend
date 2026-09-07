// ---------------------------------------------------------------------------
// STUDENT ID CARDS — a flag, and the money that comes with it.
//
// What makes this worth its own suite is that it is TWO things at once: a flag
// on the student, and cash at the counter. The failure that matters is the two
// disagreeing — a card marked issued with no money recorded, or a ledger row
// against a student whose flag never moved.
//
// So the assertions here are mostly cross-checks: after every action, the flag,
// the ledger and the rollup are all read back and compared.
//
// Its own database, like dues.js and voidfee.js.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_idcard?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const { monthKeyIST } = require('../server/src/utils/istDate');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const card = async (id) => (await Student.findById(id).lean()).idCard;
const school = () => MonthlyRollup.findOne({ session: '2026-27', month: monthKeyIST(), scope: 'SCHOOL', class: null }).lean();
const classRollup = (classId) => MonthlyRollup.findOne({ session: '2026-27', month: monthKeyIST(), scope: 'CLASS', class: classId }).lean();

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();

  section('Setup — the fee is set once, on the session');
  await permissionService.seedDefaults();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin', role: 'Admin' };
  const sess = await sessionService.create({
    name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31'), idCardFee: 150,
  });
  await sessionService.activate(sess._id);
  sessionCache.clear();
  ok('Session carries the ID card fee', (await sessionService.getActiveSession()).idCardFee === 150, '₹150');

  const c5 = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });
  const c6 = await classService.create({ name: 'Class 6', section: 'A', order: 6, monthlyFee: 1200 });

  const mk = (name, cls, phone) => studentService.create(
    { name, class: cls._id, phone, admissionDate: new Date('2026-04-05') }, actor.id);

  const aarav = await mk('Aarav Sharma', c5, '9876543210');
  const bhavna = await mk('Bhavna Rao', c5, '9876543211');
  const chetan = await mk('Chetan Patel', c5, '9876543212');
  const divya = await mk('Divya Nair', c6, '9876543213');
  ok('4 students across 2 classes', Boolean(aarav && bhavna && chetan && divya));

  section('Every card starts NOT issued');
  ok('The flag defaults to false', (await card(aarav._id)).issued === false);
  const fresh = await studentService.idCardSummary();
  ok('Summary shows all 4 pending', fresh.school.issued === 0 && fresh.school.pending === 4, `${fresh.school.issued} issued, ${fresh.school.pending} pending`);
  ok('A class with students still lists', fresh.classes.length === 2, `${fresh.classes.length} classes`);

  section('Issuing takes the money in the same breath');
  const r1 = await studentService.issueIdCard(String(aarav._id), { mode: 'Cash' }, actor);
  ok("Amount falls back to the session's fee", r1.amount === 150, `₹${r1.amount}`);

  const c1 = await card(aarav._id);
  ok('Flag set', c1.issued === true);
  ok('Amount recorded on the student', c1.amount === 150);
  ok('The ledger row is linked from the flag', String(c1.txn) === String(r1.transactionId));

  const txn = await Transaction.findById(r1.transactionId).lean();
  ok('Ledger row is IN / ID_CARD', txn.direction === 'IN' && txn.type === 'ID_CARD' && txn.amount === 150);
  ok('...carrying the class, so class-wise reports work', String(txn.class) === String(c5._id), txn.className);

  const s1 = await school();
  ok('Rollup: its own head, not lumped into other income', s1.idCardCollected === 150 && !s1.otherIncome, `idCardCollected ₹${s1.idCardCollected}`);
  ok('Rollup: counted as cash in', s1.cashIn === 150, `cashIn ₹${s1.cashIn}`);
  const cr1 = await classRollup(c5._id);
  ok('Class rollup moved too', cr1.idCardCollected === 150, `₹${cr1.idCardCollected}`);

  section('The same card cannot be issued twice');
  const e1 = await throws(() => studentService.issueIdCard(String(aarav._id), {}, actor));
  ok('Second issue refused (409)', e1 && e1.statusCode === 409, e1 && e1.message);
  ok('Nothing moved', (await school()).idCardCollected === 150);

  section('A free card sets the flag and writes NO ledger row');
  const r2 = await studentService.issueIdCard(String(bhavna._id), { amount: 0, note: 'staff child' }, actor);
  ok('Issued at ₹0', r2.amount === 0);
  ok('Flag still set', (await card(bhavna._id)).issued === true);
  ok('No transaction written', r2.transactionId === null);
  ok('Collection unchanged — no cash moved', (await school()).idCardCollected === 150, `₹${(await school()).idCardCollected}`);

  section('The fee can be overridden per student');
  const r3 = await studentService.issueIdCard(String(chetan._id), { amount: 200, mode: 'UPI' }, actor);
  ok('Charged ₹200, not the ₹150 default', r3.amount === 200);
  ok('Collection now ₹350', (await school()).idCardCollected === 350, `₹${(await school()).idCardCollected}`);

  section('Class-wise: who has taken theirs, who has not');
  const sum = await studentService.idCardSummary();
  const cls5 = sum.classes.find((c) => c.className === 'Class 5 – A');
  const cls6 = sum.classes.find((c) => c.className === 'Class 6 – A');
  ok('Class 5: 3 students, 3 issued, 0 pending', cls5.total === 3 && cls5.issued === 3 && cls5.pending === 0, JSON.stringify(cls5));
  ok('Class 5 collected ₹350 (one was free)', cls5.collected === 350, `₹${cls5.collected}`);
  ok('Class 5 is at 100%', cls5.percent === 100);
  ok('Class 6: 1 student, none issued', cls6.total === 1 && cls6.issued === 0 && cls6.pending === 1, JSON.stringify(cls6));
  ok('Class 6 is at 0%', cls6.percent === 0);
  ok('School: 3 of 4', sum.school.issued === 3 && sum.school.pending === 1 && sum.school.percent === 75, JSON.stringify(sum.school));

  section('Filtering the roster by who has one');
  const pending = await studentService.list({ idCard: 'pending' });
  ok('Pending list has only Divya', pending.items.length === 1 && pending.items[0].name === 'Divya Nair', pending.items.map((s) => s.name).join(', '));
  const issued = await studentService.list({ idCard: 'issued' });
  ok('Issued list has the other 3', issued.items.length === 3, issued.items.map((s) => s.name).join(', '));
  const inClass = await studentService.list({ class: String(c5._id), idCard: 'issued' });
  ok('Filter works INSIDE a class', inClass.items.length === 3 && inClass.items.every((s) => s.className === 'Class 5 – A'));
  const noFilter = await studentService.list({});
  ok('No filter still returns everyone', noFilter.items.length === 4);

  section('Cancelling reverses the money — never deletes it');
  const cancel = await studentService.cancelIdCard(String(aarav._id), 'card printed wrong', actor);
  ok('₹150 reported as reversed', cancel.refunded === 150);
  ok('Flag cleared', (await card(aarav._id)).issued === false);
  ok('Amount cleared from the student', (await card(aarav._id)).amount === 0);

  const original = await Transaction.findById(r1.transactionId).lean();
  ok('The original row still exists, marked void', original.voided === true, original.voidReason);
  const rev = await Transaction.findOne({ type: 'REVERSAL', reversalOf: r1.transactionId }).lean();
  ok('An opposing row was written', Boolean(rev) && rev.direction === 'OUT' && rev.amount === 150);
  ok('Collection came back down to ₹200', (await school()).idCardCollected === 200, `₹${(await school()).idCardCollected}`);

  section('Cancelling a FREE card touches no ledger');
  const before = await Transaction.countDocuments({});
  const c2 = await studentService.cancelIdCard(String(bhavna._id), 'not required', actor);
  ok('Nothing to reverse', c2.refunded === 0);
  ok('Flag cleared', (await card(bhavna._id)).issued === false);
  ok('No new ledger rows', (await Transaction.countDocuments({})) === before);

  section('Guards');
  const e2 = await throws(() => studentService.cancelIdCard(String(aarav._id), 'again', actor));
  ok('Cancelling a card that is not issued -> 409', e2 && e2.statusCode === 409, e2 && e2.message);
  const e3 = await throws(() => studentService.cancelIdCard(String(chetan._id), '', actor));
  ok('Cancelling without a reason -> 400', e3 && e3.statusCode === 400, e3 && e3.message);
  ok("...and it did not go through", (await card(chetan._id)).issued === true);

  section('Ledger vs rollup — no drift');
  const rows = await Transaction.find({ session: '2026-27' }).lean();
  const byId = new Map(rows.map((t) => [String(t._id), t]));
  const derived = rows.reduce((sum, t) => {
    if (t.type === 'ID_CARD') return sum + t.amount;
    if (t.type === 'REVERSAL' && byId.get(String(t.reversalOf))?.type === 'ID_CARD') return sum - t.amount;
    return sum;
  }, 0);
  ok('Rollup matches the ledger', derived === (await school()).idCardCollected, `derived ₹${derived} vs rollup ₹${(await school()).idCardCollected}`);

  const flagged = await Student.find({ 'idCard.issued': true }).lean();
  const onFlags = flagged.reduce((sum, s) => sum + (s.idCard.amount || 0), 0);
  ok('Flags match the rollup too', onFlags === (await school()).idCardCollected, `flags ₹${onFlags}`);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
