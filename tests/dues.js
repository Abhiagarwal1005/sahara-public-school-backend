// ---------------------------------------------------------------------------
// Stock dues: the money a student still owes after buying on credit.
//
// This lives apart from smoke.js on purpose. smoke.js runs one long story
// against one database and later assertions depend on the balances earlier
// ones leave behind — dropping a collection into the middle of it would
// quietly move those numbers. This suite owns its own database instead.
//
// What it is really guarding: a credit sale used to be a one-way door. The
// balance could be created and never received, so a uniform sold on credit
// stayed outstanding forever.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_dues?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Student = require('../server/src/models/student.model');
const StockSale = require('../server/src/models/stockSale.model');
const Transaction = require('../server/src/models/transaction.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const studentService = require('../server/src/services/student.service');
const stockService = require('../server/src/services/stock.service');
const saleService = require('../server/src/services/sale.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`); } };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const stockOf = async (id) => (await Student.findById(id).lean()).stockOutstanding;

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
  const stu = await studentService.create({ name: 'Aarav Sharma', class: cls._id, fatherName: 'R Sharma', phone: '9876543210', admissionDate: new Date('2026-04-05') }, actor.id);
  const item = await stockService.createItem({ name: 'Uniform Shirt', category: 'Uniform', sellPrice: 500, costPrice: 300, currentStock: 100 }, actor.id);
  ok('Setup done', Boolean(stu._id && item._id));

  section('Credit sale creates a balance');
  const sale1 = await saleService.create({ studentId: String(stu._id), lines: [{ item: String(item._id), qty: 2 }], paidAmount: 200, mode: 'Cash' }, actor.id);
  ok('Bill raised', sale1.total === 1000, `total ₹${sale1.total}, paid ₹${sale1.paidAmount}, due ₹${sale1.dueAmount}`);
  ok('Student now owes it', (await stockOf(stu._id)) === 800, `stockOutstanding ₹${await stockOf(stu._id)}`);

  section('The dues screen can see it');
  const dues = await saleService.duesForStudent(String(stu._id));
  ok('Total due reported', dues.totalDue === 800, `₹${dues.totalDue}`);
  ok('Bill listed with its items', dues.bills.length === 1 && dues.bills[0].items.includes('Uniform Shirt'), dues.bills[0].items);

  section('Overpaying is refused');
  const e1 = await throws(() => saleService.collectDues({ studentId: String(stu._id), amount: 900, mode: 'Cash' }, actor));
  ok('₹900 against ₹800 blocked', e1 && e1.statusCode === 400, e1 && e1.message);
  ok('Balance untouched after the refusal', (await stockOf(stu._id)) === 800);

  section('Partial collection');
  const r1 = await saleService.collectDues({ studentId: String(stu._id), amount: 300, mode: 'Cash' }, actor);
  ok('Receipt issued', /^RCP\d{5}$/.test(r1.receiptNo), r1.receiptNo);
  ok('Balance came down', (await stockOf(stu._id)) === 500, `₹${await stockOf(stu._id)}`);
  ok('Balance reported back correctly', r1.balanceAfter === 500, `₹${r1.balanceAfter}`);
  const b1 = await StockSale.findById(sale1._id).lean();
  ok('Bill due reduced', b1.dueAmount === 500, `due ₹${b1.dueAmount}`);
  ok('Bill paid raised', b1.paidAmount === 500, `paid ₹${b1.paidAmount}`);
  ok('duesReceived tracked apart', b1.duesReceived === 300, `₹${b1.duesReceived}`);
  const led = await Transaction.findOne({ receiptNo: r1.receiptNo }).lean();
  ok('Ledger row written IN/STOCK_SALE', led && led.direction === 'IN' && led.type === 'STOCK_SALE' && led.amount === 300);
  ok('Bill named on the receipt', led.note.includes(sale1.billNo), led.note);

  section('Voiding a bill that took money is refused');
  const e2 = await throws(() => saleService.voidSale(String(sale1._id), 'wrong size', actor));
  ok('Void blocked with 409', e2 && e2.statusCode === 409, e2 && e2.message);
  ok('Nothing moved', (await stockOf(stu._id)) === 500);

  section('Settling the rest');
  const r2 = await saleService.collectDues({ studentId: String(stu._id), amount: 500, mode: 'UPI' }, actor);
  ok('Cleared to zero', (await stockOf(stu._id)) === 0, `₹${await stockOf(stu._id)}`);
  ok('Receipt numbers advance', r2.receiptNo !== r1.receiptNo, `${r1.receiptNo} -> ${r2.receiptNo}`);
  const duesAfter = await saleService.duesForStudent(String(stu._id));
  ok('Bill gone from the dues list', duesAfter.totalDue === 0 && duesAfter.bills.length === 0);
  const e3 = await throws(() => saleService.collectDues({ studentId: String(stu._id), amount: 100, mode: 'Cash' }, actor));
  ok('Collecting with nothing owed is refused', e3 && e3.statusCode === 400, e3 && e3.message);

  section('A clean credit bill can still be voided');
  const sale2 = await saleService.create({ studentId: String(stu._id), lines: [{ item: String(item._id), qty: 1 }], paidAmount: 0, mode: 'Cash' }, actor.id);
  ok('Second bill owes ₹500', (await stockOf(stu._id)) === 500);
  await saleService.voidSale(String(sale2._id), 'returned same day', actor);
  ok('Void cleared the balance', (await stockOf(stu._id)) === 0, `₹${await stockOf(stu._id)}`);
  // A fully-credit bill never wrote a cash row, so there is nothing to reverse.
  ok('No reversal for a bill that took no money', (await Transaction.find({ type: 'REVERSAL' }).lean()).length === 0);

  section('Void reverses the sale row, not a dues receipt');
  const sale3 = await saleService.create({ studentId: String(stu._id), lines: [{ item: String(item._id), qty: 1 }], paidAmount: 200, mode: 'Cash' }, actor.id);
  ok('Third bill: ₹200 paid, ₹300 owed', (await stockOf(stu._id)) === 300, `stockOutstanding ₹${await stockOf(stu._id)}`);
  await saleService.voidSale(String(sale3._id), 'wrong item', actor);
  const rev = await Transaction.find({ type: 'REVERSAL' }).lean();
  ok('One reversal raised', rev.length === 1, `${rev.length} reversal(s)`);
  ok('It reversed the ₹200 sale, not either ₹300/₹500 receipt', rev[0] && rev[0].amount === 200, `₹${rev[0] && rev[0].amount}`);
  ok('Void cleared the remaining ₹300', (await stockOf(stu._id)) === 0, `₹${await stockOf(stu._id)}`);
  const paidReceipts = await Transaction.find({ receiptNo: { $ne: null } }).lean();
  ok('Both dues receipts still stand', paidReceipts.length === 2 && paidReceipts.every((t) => !t.voided), `${paidReceipts.length} receipts`);

  section('Ledger vs balances');
  const sales = await StockSale.aggregate([{ $match: { session: '2026-27', voided: false, student: { $ne: null } } }, { $group: { _id: '$student', due: { $sum: '$dueAmount' } } }]);
  const derived = sales.length ? sales[0].due : 0;
  ok('stockOutstanding matches SUM(dueAmount) — no drift', derived === (await stockOf(stu._id)), `derived ₹${derived} vs stored ₹${await stockOf(stu._id)}`);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
