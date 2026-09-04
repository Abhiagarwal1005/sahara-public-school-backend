// ---------------------------------------------------------------------------
// Payroll: the calendar-day rule.
//
// The month is paid on its calendar days — 31, 30 or 28 — not on working
// days, and Sundays sit inside that count as paid days. So a teacher who
// works every working day takes home exactly their monthly salary, and
// nobody has to mark a Sunday for that to happen.
//
// The awkward cases are the ones worth pinning down: a Sunday marked
// Present by accident must not change the pay, and a Sunday marked Absent
// must not dock anybody.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_sunday?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const salaryService = require('../server/src/services/salary.service');
const Transaction = require('../server/src/models/transaction.model');
const attendanceService = require('../server/src/services/attendance.service');
const teacherService = require('../server/src/services/teacher.service');
const sessionService = require('../server/src/services/session.service');
const permissionService = require('../server/src/services/permission.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');
const { isSundayIST, sundaysInMonthIST, daysInMonthIST } = require('../server/src/utils/istDate');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const section = (t) => console.log(`\n== ${t}`);

// Build a month of marks: every non-Sunday Present, Sundays as given.
const buildMarks = (month, { sundayStatus = null, overrides = {} } = {}) => {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let d = 1; d <= daysInMonthIST(month); d += 1) {
    const date = new Date(Date.UTC(y, m - 1, d) - 5.5 * 3600 * 1000);
    const sunday = isSundayIST(date);
    if (sunday && sundayStatus === null) continue;         // Sunday simply not marked
    out.push({ date, status: overrides[d] || (sunday ? sundayStatus : 'Present') });
  }
  return out;
};

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();
  await permissionService.seedDefaults();

  const MONTH = '2026-08';
  const teacher = { name: 'Rajesh Kumar', monthlySalary: 10000 };

  section(`Calendar facts for ${MONTH}`);
  ok('31 days in the month', daysInMonthIST(MONTH) === 31, `${daysInMonthIST(MONTH)}`);
  ok('5 Sundays in the month', sundaysInMonthIST(MONTH) === 5, `${sundaysInMonthIST(MONTH)}`);

  section('Sundays never marked — full attendance');
  const a = salaryService.computeSlip({ teacher, month: MONTH, marks: buildMarks(MONTH) });
  ok('Divisor is the whole month, 31', a.monthDays === 31, `${a.monthDays}`);
  ok('Per-day rate ₹322.58 (10000/31)', a.perDayRate === 322.58, `₹${a.perDayRate}`);
  ok('All 31 days are payable', a.payableDays === 31, `${a.payableDays}`);
  ok('Earns exactly ₹10,000', a.earned === 10000, `₹${a.earned}`);
  ok('5 Sundays shown as paid', a.sundayDays === 5, `${a.sundayDays}`);
  ok('Working days shown for information — 26', a.workingDays === 26, `${a.workingDays}`);

  section('Sundays marked Holiday — must match exactly');
  const b = salaryService.computeSlip({ teacher, month: MONTH, marks: buildMarks(MONTH, { sundayStatus: 'Holiday' }) });
  ok('Divisor still 31', b.monthDays === 31, `${b.monthDays}`);
  ok('Same salary either way', b.earned === a.earned, `₹${b.earned}`);
  ok('Sundays did not become school holidays', b.holidayDays === 0, `${b.holidayDays}`);

  section('Sundays wrongly marked Present — must change nothing');
  const c = salaryService.computeSlip({ teacher, month: MONTH, marks: buildMarks(MONTH, { sundayStatus: 'Present' }) });
  ok('Divisor still 31', c.monthDays === 31, `${c.monthDays}`);
  ok('Salary unchanged at ₹10,000', c.earned === 10000, `₹${c.earned}`);

  section('Sundays wrongly marked Absent — teacher must not be docked');
  const d = salaryService.computeSlip({ teacher, month: MONTH, marks: buildMarks(MONTH, { sundayStatus: 'Absent' }) });
  ok('Absent count ignores Sundays', d.absentDays === 0, `${d.absentDays} absent`);
  ok('Still exactly ₹10,000', d.earned === 10000, `₹${d.earned}`);

  section('2 absent, 1 half day, 1 leave (Aug 3,4 absent · 5 half · 6 leave)');
  const e = salaryService.computeSlip({ teacher, month: MONTH,
    marks: buildMarks(MONTH, { overrides: { 3: 'Absent', 4: 'Absent', 5: 'HalfDay', 6: 'Leave' } }) });
  ok('Absent 2 · Half 1 · Leave 1', e.absentDays === 2 && e.halfDays === 1 && e.leaveDays === 1);
  ok('Payable 28.5 (31 − 2 − 0.5)', e.payableDays === 28.5, `${e.payableDays}`);
  ok('Leave was NOT deducted', e.payableDays === 31 - 2 - 0.5);
  ok('Earned ₹9,193.55', e.earned === 9193.55, `₹${e.earned}`);

  section('A school holiday (15 Aug) is paid, and is not a working day');
  const f = salaryService.computeSlip({ teacher, month: MONTH, marks: buildMarks(MONTH, { overrides: { 15: 'Holiday' } }) });
  ok('Divisor unchanged at 31', f.monthDays === 31, `${f.monthDays}`);
  ok('Working days drop to 25', f.workingDays === 25, `${f.workingDays}`);
  ok('Still exactly ₹10,000', f.earned === 10000, `₹${f.earned}`);

  section('A 30-day month divides by 30');
  const sep = salaryService.computeSlip({ teacher, month: '2026-09', marks: buildMarks('2026-09') });
  ok('September divisor is 30', sep.monthDays === 30, `${sep.monthDays}`);
  ok('Rate ₹333.33', sep.perDayRate === 333.33, `₹${sep.perDayRate}`);
  ok('Still exactly ₹10,000', sep.earned === 10000, `₹${sep.earned}`);

  section('February divides by 28');
  const feb = salaryService.computeSlip({ teacher, month: '2027-02', marks: buildMarks('2027-02') });
  ok('February divisor is 28', feb.monthDays === 28, `${feb.monthDays}`);
  ok('Still exactly ₹10,000', feb.earned === 10000, `₹${feb.earned}`);

  section('Only 1 day marked in September — the real slip that started this');
  // Ayushi: ₹10,000, September 2026. One day marked Present, nothing else.
  // 1 worked day + 4 Sundays = 5 payable days, NOT 30.
  const one = salaryService.computeSlip({
    teacher, month: '2026-09',
    marks: [{ date: new Date(Date.UTC(2026, 8, 1) - 5.5 * 3600 * 1000), status: 'Present' }],
  });
  ok('Divisor is still the whole month, 30', one.monthDays === 30, `${one.monthDays}`);
  ok('Present 1', one.presentDays === 1, `${one.presentDays}`);
  ok('4 Sundays added automatically', one.sundayDays === 4, `${one.sundayDays}`);
  ok('Payable = 1 + 4 = 5 days', one.payableDays === 5, `${one.payableDays}`);
  ok('25 days flagged as unmarked', one.unmarkedDays === 25, `${one.unmarkedDays}`);
  ok('Earned ₹1,666.67, not ₹10,000', one.earned === 1666.67, `₹${one.earned}`);

  section('No attendance at all is refused');
  let refused = false;
  try { salaryService.computeSlip({ teacher, month: MONTH, marks: [] }); } catch { refused = true; }
  ok('A month with nothing marked cannot generate a slip', refused);

  section('The attendance sheet itself');
  const sess = await sessionService.create({ name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31') }, new mongoose.Types.ObjectId());
  await sessionService.activate(sess._id); sessionCache.clear();
  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin' };
  await teacherService.create({ name: 'Rajesh Kumar', monthlySalary: 10000, joiningDate: new Date('2026-04-01') }, admin._id);

  const sun = await attendanceService.getTeacherSheet('2026-08-02'); // a Sunday
  ok('Sheet knows it is a Sunday', sun.isSunday === true);
  ok('Rows default to Holiday, not Present', sun.rows[0].status === 'Holiday', sun.rows[0].status);
  const mon = await attendanceService.getTeacherSheet('2026-08-03'); // a Monday
  ok('Monday still defaults to Present', mon.isSunday === false && mon.rows[0].status === 'Present', mon.rows[0].status);

  section('A draft can be discarded and rebuilt');
  const t2 = await teacherService.create({ name: 'Ayushi Verma', monthlySalary: 10000, joiningDate: new Date('2026-04-01') }, admin._id);
  await attendanceService.markTeachers({ date: new Date('2026-09-01T06:00:00Z'), entries: [{ teacher: t2._id, status: 'Present' }] }, admin._id);

  const g1 = await salaryService.generate({ month: '2026-09' }, admin._id);
  ok('Slips generated', g1.created >= 1, `${g1.created}`);
  let slip = (await salaryService.list({ month: '2026-09' })).slips.find((x) => x.teacherName === 'Ayushi Verma');
  ok('1 present + 4 Sundays = 5 days paid', slip.payableDays === 5, `${slip.payableDays}`);
  ok('Earned ₹1,666.67', slip.earned === 1666.67, `₹${slip.earned}`);

  // the register gets filled in properly afterwards
  for (let d = 2; d <= 30; d += 1) {
    const date = new Date(Date.UTC(2026, 8, d, 6, 0, 0));
    if (isSundayIST(date)) continue;
    await attendanceService.markTeachers({ date, entries: [{ teacher: t2._id, status: 'Present' }] }, admin._id);
  }

  const stale = (await salaryService.list({ month: '2026-09' })).slips.find((x) => x.teacherName === 'Ayushi Verma');
  ok('The existing draft does NOT move on its own (it is a snapshot)', stale.earned === 1666.67, `₹${stale.earned}`);

  const again = await salaryService.generate({ month: '2026-09' }, admin._id);
  ok('Re-generating will not overwrite it either', again.created === 0, `${again.created} created`);

  await salaryService.discard(slip._id);
  await salaryService.generate({ month: '2026-09' }, admin._id);
  slip = (await salaryService.list({ month: '2026-09' })).slips.find((x) => x.teacherName === 'Ayushi Verma');
  ok('After discard + generate the slip is rebuilt', slip.payableDays === 30, `${slip.payableDays} days`);
  ok('Now the full ₹10,000', slip.earned === 10000, `₹${slip.earned}`);
  ok('Nothing left unmarked', slip.unmarkedDays === 0, `${slip.unmarkedDays}`);

  await salaryService.approve(slip._id, admin._id);
  let lockedOut = false;
  try { await salaryService.discard(slip._id); } catch { lockedOut = true; }
  ok('An approved slip cannot be discarded', lockedOut);

  section('Bonus, arrear, fine — hand-entered lines');
  const t3 = await teacherService.create({ name: 'Meera Joshi', monthlySalary: 12000, joiningDate: new Date('2026-04-01') }, admin._id);
  for (let d = 1; d <= 30; d += 1) {
    const date = new Date(Date.UTC(2026, 8, d, 6, 0, 0));
    if (isSundayIST(date)) continue;
    await attendanceService.markTeachers({ date, entries: [{ teacher: t3._id, status: 'Present' }] }, admin._id);
  }
  await salaryService.generate({ month: '2026-09' }, admin._id);
  let ms = (await salaryService.list({ month: '2026-09' })).slips.find((x) => x.teacherName === 'Meera Joshi');
  ok('Starts at the full ₹12,000', ms.netPayable === 12000, `₹${ms.netPayable}`);

  let updated = await salaryService.addAdjustment(ms._id, { kind: 'Add', label: 'Diwali bonus', amount: 2000 }, actor);
  ok('A bonus raises the net', updated.netPayable === 14000, `₹${updated.netPayable}`);
  ok('The reason is stored', updated.adjustments[0].label === 'Diwali bonus');
  ok('So is who added it', updated.adjustments[0].byName === 'Admin');

  updated = await salaryService.addAdjustment(ms._id, { kind: 'Deduct', label: 'Breakage recovery', amount: 500 }, actor);
  ok('A deduction lowers it', updated.netPayable === 13500, `₹${updated.netPayable}`);
  ok('Both lines are kept', updated.adjustments.length === 2);

  const tooBig = await throws(() => salaryService.addAdjustment(ms._id, { kind: 'Deduct', label: 'Mistake', amount: 99999 }, actor));
  ok('A deduction cannot take the net below zero', tooBig && tooBig.statusCode === 400, tooBig && tooBig.message);
  ok('And nothing was written', (await salaryService.getById(ms._id)).netPayable === 13500);

  section('Advance still stacks on top');
  await salaryService.update(ms._id, { advance: 1500 });
  ms = await salaryService.getById(ms._id);
  ok('12000 + 2000 - 500 - 1500 = 12000', ms.netPayable === 12000, `₹${ms.netPayable}`);

  section('Removing a line');
  const bonusId = ms.adjustments.find((a) => a.label === 'Diwali bonus')._id;
  updated = await salaryService.removeAdjustment(ms._id, bonusId);
  ok('The bonus is gone', updated.adjustments.length === 1);
  ok('And the net came back down', updated.netPayable === 10000, `₹${updated.netPayable}`);
  const missing = await throws(() => salaryService.removeAdjustment(ms._id, new mongoose.Types.ObjectId()));
  ok('Removing a line that is not there -> 404', missing && missing.statusCode === 404);

  section('Approval freezes the lines too');
  await salaryService.approve(ms._id, admin._id);
  const locked = await throws(() => salaryService.addAdjustment(ms._id, { kind: 'Add', label: 'Late bonus', amount: 100 }, actor));
  ok('No adjustment after approval', locked && locked.statusCode === 409, locked && locked.code);
  const lockedRm = await throws(() => salaryService.removeAdjustment(ms._id, ms.adjustments[0]._id));
  ok('And none can be removed either', lockedRm && lockedRm.statusCode === 409);

  section('Payment uses the adjusted figure');
  const paidOut = await salaryService.pay(ms._id, { mode: 'Cash' }, admin._id);
  ok('Paid the adjusted net, not the earned', paidOut.paid === 10000, `₹${paidOut.paid}`);
  ok('Nothing remaining', paidOut.remaining === 0);
  const salTxn = await Transaction.findOne({ refModel: 'SalarySlip', refId: ms._id, type: 'SALARY' }).lean();
  ok('Ledger records the chosen payment mode', salTxn.mode === 'Cash', salTxn.mode);
  ok('Ledger amount matches the net', salTxn.amount === 10000, `₹${salTxn.amount}`);

  section('Monthly grid marks the Sundays for the UI');
  const grid = await attendanceService.teacherMonthlyGrid(MONTH);
  ok('Grid reports 31 columns', grid.totalDays === 31, `${grid.totalDays}`);
  ok('Grid names every Sunday', JSON.stringify(grid.sundays) === JSON.stringify([2, 9, 16, 23, 30]), JSON.stringify(grid.sundays));

  // -------------------------------------------------------------------------
  // Over real HTTP, not the service layer.
  //
  // The service-level checks above all passed while DELETE was broken in
  // production: validate() assigns the parsed object back over req.params and
  // zod strips what the schema does not name, so :adjustmentId vanished before
  // the controller saw it. Only a request through the router catches that.
  // -------------------------------------------------------------------------
  section('The adjustment routes, over HTTP');
  const app = require('../server/app');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (m, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method: m,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, body: j };
  };

  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'test1234' } });
  const token = login.body?.data?.accessToken;
  ok('Signed in for the HTTP checks', Boolean(token));

  const t4 = await teacherService.create({ name: 'Neha Bhatt', monthlySalary: 9000, joiningDate: new Date('2026-04-01') }, admin._id);
  for (let d = 1; d <= 31; d += 1) {
    const date = new Date(Date.UTC(2026, 9, d, 6, 0, 0));
    if (isSundayIST(date)) continue;
    await attendanceService.markTeachers({ date, entries: [{ teacher: t4._id, status: 'Present' }] }, admin._id);
  }
  await salaryService.generate({ month: '2026-10' }, admin._id);
  const nb = (await salaryService.list({ month: '2026-10' })).slips.find((x) => x.teacherName === 'Neha Bhatt');

  const added = await call('POST', `/salary/slips/${nb._id}/adjustment`, { token, body: { kind: 'Add', label: 'Exam duty', amount: 1200 } });
  ok('POST adjustment -> 201', added.status === 201, `net ₹${added.body?.data?.netPayable}`);
  ok('Net rose by the bonus', added.body?.data?.netPayable === 10200, `₹${added.body?.data?.netPayable}`);

  const bad = await call('POST', `/salary/slips/${nb._id}/adjustment`, { token, body: { kind: 'Add', label: 'x', amount: 100 } });
  ok('A one-letter reason is rejected', bad.status === 400);

  const adjId = added.body.data.adjustments[0]._id;
  const removed = await call('DELETE', `/salary/slips/${nb._id}/adjustment/${adjId}`, { token });
  ok('DELETE adjustment -> 200', removed.status === 200, removed.body?.message);
  ok('The line is really gone', removed.body?.data?.adjustments?.length === 0);
  ok('And the net came back down', removed.body?.data?.netPayable === 9000, `₹${removed.body?.data?.netPayable}`);

  const badId = await call('DELETE', `/salary/slips/${nb._id}/adjustment/not-an-id`, { token });
  ok('A malformed adjustment id -> 400', badId.status === 400);

  server.close();

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
