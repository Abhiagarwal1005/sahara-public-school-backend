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
const attendanceService = require('../server/src/services/attendance.service');
const teacherService = require('../server/src/services/teacher.service');
const sessionService = require('../server/src/services/session.service');
const permissionService = require('../server/src/services/permission.service');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');
const { isSundayIST, sundaysInMonthIST, daysInMonthIST } = require('../server/src/utils/istDate');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
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

  section('Monthly grid marks the Sundays for the UI');
  const grid = await attendanceService.teacherMonthlyGrid(MONTH);
  ok('Grid reports 31 columns', grid.totalDays === 31, `${grid.totalDays}`);
  ok('Grid names every Sunday', JSON.stringify(grid.sundays) === JSON.stringify([2, 9, 16, 23, 30]), JSON.stringify(grid.sundays));

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
