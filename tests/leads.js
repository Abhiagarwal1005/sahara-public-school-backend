// ---------------------------------------------------------------------------
// Enquiries (leads).
//
// The module's whole promise is that it is an island: a lead has not joined
// the school, so nothing it does may reach the students, the fees, the ledger
// or any rollup. Half of this suite exists to prove that — including the
// case that would be most tempting to wire up, marking a lead Admitted.
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_leads?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.FRONTEND_URL = 'http://localhost:5173';

const mongoose = require('mongoose');
const connectDB = require('../server/src/config/db');
const User = require('../server/src/models/user.model');
const Lead = require('../server/src/models/lead.model');
const Student = require('../server/src/models/student.model');
const FeeDemand = require('../server/src/models/feeDemand.model');
const Transaction = require('../server/src/models/transaction.model');
const MonthlyRollup = require('../server/src/models/monthlyRollup.model');
const leadService = require('../server/src/services/lead.service');
const permissionService = require('../server/src/services/permission.service');
const { DEFAULT_GRANTS, PERMISSION_KEYS } = require('../server/src/utils/permissions');
const { sessionCache, permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };
const section = (t) => console.log(`\n== ${t}`);
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const daysOut = (n) => new Date(Date.now() + n * 86400000);

(async () => {
  await connectDB();
  await mongoose.connection.dropDatabase();
  sessionCache.clear(); permissionCache.clear();
  await permissionService.seedDefaults();

  const admin = await User.create({ name: 'Admin', username: 'admin', role: 'Admin', password: 'test1234' });
  const actor = { id: admin._id, name: 'Admin' };

  section('Permissions');
  ok('lead.view / lead.manage are in the catalogue', PERMISSION_KEYS.has('lead.view') && PERMISSION_KEYS.has('lead.manage'));
  ok('Principal gets both by default', DEFAULT_GRANTS.Principal.includes('lead.view') && DEFAULT_GRANTS.Principal.includes('lead.manage'));
  ok('Accountant gets both (the front desk takes enquiries)', DEFAULT_GRANTS.Accountant.includes('lead.manage'));

  section('Taking an enquiry');
  const lead = await leadService.create({
    name: 'Kabir Mehta', guardianName: 'Nikhil Mehta', phone: '9876500011',
    address: 'Civil Lines', classInterested: 'Class 1', source: 'Walk-in',
    note: 'Asked about the bus route', nextFollowUp: daysOut(-1),
  }, actor.id);
  ok('Lead saved', Boolean(lead._id), lead.name);
  ok('Starts as New', lead.status === 'New', lead.status);
  ok('Class is stored as plain text, not a reference', typeof lead.classInterested === 'string', lead.classInterested);
  ok('Phone normalised to 10 digits', lead.phone === '9876500011', lead.phone);

  section('The follow-up queue');
  const due = await leadService.list({ due: 'true' });
  ok('An overdue lead shows up', due.items.length === 1 && due.items[0].name === 'Kabir Mehta');

  const notDue = await leadService.create({ name: 'Aarohi Singh', phone: '9876500022', nextFollowUp: daysOut(10) }, actor.id);
  const due2 = await leadService.list({ due: 'true' });
  ok('One due next week does NOT', due2.items.length === 1, `${due2.items.length} due`);
  const open = await leadService.list({ open: 'true' });
  ok('Both are open', open.items.length === 2, `${open.items.length}`);

  section('Search');
  ok('By name prefix', (await leadService.list({ search: 'kab' })).items.length === 1);
  ok('Prefix only — mid-word does not match', (await leadService.list({ search: 'mehta' })).items.length === 0);
  ok('By phone, exact', (await leadService.list({ search: '9876500022' })).items[0].name === 'Aarohi Singh');
  ok('Same number rings again -> existing enquiry surfaced', (await leadService.findByPhone('9876500011')).length === 1);

  section('Chasing it');
  let l = await leadService.addFollowUp(lead._id, { note: 'Called, visiting Saturday', outcome: 'Contacted', nextFollowUp: daysOut(3) }, actor);
  ok('Status moved to Contacted', l.status === 'Contacted', l.status);
  ok('History has 1 entry', l.followUps.length === 1);
  ok('Entry records who logged it', l.followUps[0].byName === 'Admin');
  ok('Next date moved forward', new Date(l.nextFollowUp) > new Date());
  ok('It left the due list', (await leadService.list({ due: 'true' })).items.length === 0);

  l = await leadService.addFollowUp(lead._id, { note: 'Visited the campus', outcome: 'Visited', nextFollowUp: daysOut(2) }, actor);
  ok('History appends, never replaces', l.followUps.length === 2, `${l.followUps.length} entries`);

  section('Closing');
  l = await leadService.addFollowUp(lead._id, { note: 'Joined — admitted in person', outcome: 'Admitted' }, actor);
  ok('Marked Admitted', l.status === 'Admitted');
  ok('Follow-up date cleared', l.nextFollowUp === null);
  ok('Closing reason kept', l.closeReason === 'Joined — admitted in person');
  ok('Gone from the open list', (await leadService.list({ open: 'true' })).items.length === 1);

  const e = await throws(() => leadService.addFollowUp(lead._id, { note: 'again', outcome: 'Contacted', nextFollowUp: daysOut(1) }, actor));
  ok('A closed lead refuses more follow-ups', e && e.statusCode === 409, e && e.message);

  section('ISOLATION — the point of the module');
  ok('No Student was created', (await Student.countDocuments()) === 0);
  ok('No fee row was created', (await FeeDemand.countDocuments()) === 0);
  ok('No ledger entry was written', (await Transaction.countDocuments()) === 0);
  ok('No rollup was touched', (await MonthlyRollup.countDocuments()) === 0);

  const stored = await Lead.findById(lead._id).lean();
  const refFields = Object.entries(stored).filter(
    ([k, v]) => v instanceof mongoose.Types.ObjectId && !['_id', 'createdBy'].includes(k)
  );
  ok('The document holds no reference to any other collection', refFields.length === 0,
     refFields.length ? refFields.map(([k]) => k).join(', ') : 'only _id and createdBy');
  ok('Admitting a lead did NOT make it a student', (await Student.countDocuments()) === 0);

  section('Summary counts');
  const sum = await leadService.summary();
  ok('1 open', sum.open === 1, `${sum.open}`);
  ok('1 admitted', sum.counts.Admitted === 1);
  ok('Total 2', sum.total === 2, `${sum.total}`);

  section('Deleting');
  await leadService.remove(notDue._id);
  ok('Lead removed', (await Lead.countDocuments()) === 1);
  const gone = await throws(() => leadService.getById(notDue._id));
  ok('And it is really gone', gone && gone.statusCode === 404);
  ok('Deleting a lead left everything else alone', (await Transaction.countDocuments()) === 0 && (await Student.countDocuments()) === 0);

  console.log('\n' + '='.repeat(50));
  console.log(`PASS: ${pass}   FAIL: ${fail}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, '\n', e); process.exit(1); });
