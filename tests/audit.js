// ---------------------------------------------------------------------------
// EDIT HISTORY — who changed what.
//
// Two things are being proved here, and the second matters as much as the
// first:
//
//   1. Every edit leaves a row, with the BEFORE and AFTER of the fields that
//      actually moved — not the whole document, and not just a sentence.
//   2. A save that changed NOTHING leaves no row. Without that guard the
//      screen fills with entries that say nothing, and the real changes become
//      impossible to find — which is the same as having no history at all.
//
// It runs over HTTP because that is where the audit lives: the controllers
// take the before-snapshot, so calling the services directly would prove
// nothing. Its own database, like dues.js and voidfee.js.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_audit?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const app = require('../server/app');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const AuditLog = require('../server/src/models/auditLog.model');
const permissionService = require('../server/src/services/permission.service');
const sessionService = require('../server/src/services/session.service');
const classService = require('../server/src/services/class.service');
const { sessionCache, permissionCache, userCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);

// An audit write is fire-and-forget on purpose — it must never fail the real
// work — so it lands a tick after the response. Tests have to wait for it;
// nothing else does.
const settle = () => new Promise((r) => setTimeout(r, 150));

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear(); userCache.clear();

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  const rows = (filter = {}) => AuditLog.find(filter).sort({ createdAt: -1 }).lean();
  const latest = async (action) => (await AuditLog.find({ action }).sort({ createdAt: -1 }).limit(1).lean())[0];

  section('Setup');
  await permissionService.seedDefaults();
  await User.create({ name: 'School Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const sess = await sessionService.create({ name: '2026-27', startDate: new Date('2026-04-01'), endDate: new Date('2027-03-31') });
  await sessionService.activate(sess._id);
  sessionCache.clear();
  const cls = await classService.create({ name: 'Class 5', section: 'A', order: 5, monthlyFee: 1000 });

  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'test1234' } });
  const admin = login.body?.data?.accessToken;
  ok('Admin signed in', Boolean(admin));

  section('Creating a student is recorded');
  const made = await call('POST', '/students', { token: admin, body: {
    name: 'Aarav Sharma', class: String(cls._id), phone: '9876543210', admissionDate: '2026-04-05',
  }});
  ok('Student created', made.status === 201, made.body?.message);
  const studentId = made.body?.data?._id;
  await settle();

  const createRow = await latest('student.create');
  ok('A student.create row exists', Boolean(createRow));
  ok('...with the actor on it', createRow?.actorName === 'School Admin' && createRow.actorRole === 'Admin', `${createRow?.actorName} / ${createRow?.actorRole}`);
  ok('...and a readable summary', /Aarav Sharma/.test(createRow?.summary || ''), createRow?.summary);

  section('An edit records only what MOVED');
  const before = (await rows()).length;
  const edited = await call('PATCH', `/students/${studentId}`, { token: admin, body: { monthlyFee: 800, phone: '9999911111' } });
  ok('Student updated', edited.status === 200);
  await settle();

  const editRow = await latest('student.update');
  ok('A student.update row exists', Boolean(editRow));
  ok('Before holds the old values', editRow?.before?.monthlyFee === 1000 && editRow?.before?.phone === '9876543210', JSON.stringify(editRow?.before));
  ok('After holds the new ones', editRow?.after?.monthlyFee === 800 && editRow?.after?.phone === '9999911111', JSON.stringify(editRow?.after));
  ok('Untouched fields are NOT recorded', !('name' in (editRow?.after || {})) && !('address' in (editRow?.after || {})), `keys: ${Object.keys(editRow?.after || {}).join(',')}`);
  ok('The summary reads as a change', /monthlyFee: 1000 → 800/.test(editRow?.summary || ''), editRow?.summary);
  ok('Exactly one row was added', (await rows()).length === before + 1);

  section('A save that changed nothing leaves no row');
  const quiet = (await rows()).length;
  const again = await call('PATCH', `/students/${studentId}`, { token: admin, body: { monthlyFee: 800, phone: '9999911111' } });
  ok('The request still succeeds', again.status === 200);
  await settle();
  ok('No history row was written', (await rows()).length === quiet, `${(await rows()).length} vs ${quiet}`);

  section('A salary change is recorded with its before/after');
  const teacher = await call('POST', '/teachers', { token: admin, body: {
    name: 'Meena Joshi', monthlySalary: 20000, joiningDate: '2026-04-01', lateAllowance: 4,
  }});
  ok('Teacher created', teacher.status === 201);
  await settle();
  ok('A teacher.create row exists', Boolean(await latest('teacher.create')));

  await call('PATCH', `/teachers/${teacher.body.data._id}`, { token: admin, body: { monthlySalary: 24000 } });
  await settle();
  const raise = await latest('teacher.salaryChange');
  ok('Salary change recorded', raise?.before?.monthlySalary === 20000 && raise?.after?.monthlySalary === 24000,
     `₹${raise?.before?.monthlySalary} → ₹${raise?.after?.monthlySalary}`);

  section('Reading the history back');
  const all = await call('GET', '/audit', { token: admin });
  ok('GET /audit works', all.status === 200, `${all.body?.data?.items?.length} rows`);
  ok('Newest first', new Date(all.body.data.items[0].createdAt) >= new Date(all.body.data.items[1].createdAt));

  const byEntity = await call('GET', '/audit?entity=Student', { token: admin });
  ok('Filter by entity', byEntity.body.data.items.every((r) => r.entity === 'Student'), `${byEntity.body.data.items.length} student rows`);

  // 'student' is a PREFIX — it has to bring back student.create AND student.update
  const byModule = await call('GET', '/audit?action=student', { token: admin });
  const acts = new Set(byModule.body.data.items.map((r) => r.action));
  ok('Filter by module prefix', acts.has('student.create') && acts.has('student.update'), [...acts].join(', '));

  const trail = await call('GET', `/audit/Student/${studentId}`, { token: admin });
  ok('One record has its own trail', trail.status === 200 && trail.body.data.length === 2, `${trail.body?.data?.length} entries`);

  section('audit.view gates it — and is grantable');
  const acc = await call('POST', '/users', { token: admin, body: { name: 'Sanjay Pawar', username: 'accounts', role: 'Accountant' } });
  const accLogin = await call('POST', '/auth/login', { body: { username: 'accounts', password: acc.body.data.tempPassword } });
  await call('POST', '/auth/change-password', { token: accLogin.body.data.accessToken, body: { currentPassword: acc.body.data.tempPassword, newPassword: 'accounts-pass-1' } });
  const accIn = await call('POST', '/auth/login', { body: { username: 'accounts', password: 'accounts-pass-1' } });
  const accToken = accIn.body.data.accessToken;

  const denied = await call('GET', '/audit', { token: accToken });
  ok('Accountant is refused by default', denied.status === 403, denied.body?.code);

  const grants = await permissionService.getGrants('Accountant');
  await call('PATCH', '/permissions/Accountant', { token: admin, body: { permissions: [...grants, 'audit.view'] } });
  const allowed = await call('GET', '/audit', { token: accToken });
  ok('Admin can grant it — no deploy', allowed.status === 200, `${allowed.body?.data?.items?.length} rows`);

  section('The history itself cannot be edited');
  const tamper = await call('DELETE', `/audit/${(await rows())[0]._id}`, { token: admin });
  ok('There is no route to delete a history row', tamper.status === 404, `${tamper.status}`);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  server.close();
  // The last fire-and-forget writes are still in flight; disconnecting under
  // them prints a harmless error that looks like a failure.
  await settle();
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
