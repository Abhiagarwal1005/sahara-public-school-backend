process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sps_smoke?directConnection=true';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = '123';
process.env.CLOUDINARY_API_SECRET = 'secret';
process.env.FRONTEND_URL = 'http://localhost:5173';

const app = require('../server/app');
const User = require('../server/src/models/user.model');
const RolePermission = require('../server/src/models/rolePermission.model');
const { DEFAULT_GRANTS } = require('../server/src/utils/permissions');
const { permissionCache } = require('../server/src/utils/ttlCache');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`)); };

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/v1`;

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

  console.log('\n== Auth');
  const noAuth = await call('GET', '/reports/dashboard');
  ok('No token -> 401', noAuth.status === 401, noAuth.body?.code);

  const badLogin = await call('POST', '/auth/login', { body: { username: 'admin', password: 'wrongpass' } });
  ok('Wrong password -> 401', badLogin.status === 401, badLogin.body?.code);

  // the smoke test created admin with password 'test1234'
  const login = await call('POST', '/auth/login', { body: { username: 'admin', password: 'test1234' } });
  ok('Admin login 200', login.status === 200);
  const adminToken = login.body?.data?.accessToken;
  ok('Access token received', Boolean(adminToken));
  ok('Permissions came through too', Array.isArray(login.body?.data?.permissions) && login.body.data.permissions.length > 40,
     `${login.body?.data?.permissions?.length} keys`);

  const dash = await call('GET', '/reports/dashboard', { token: adminToken });
  ok('Admin dashboard 200', dash.status === 200, `outstanding ₹${dash.body?.data?.outstanding?.total}`);

  console.log('\n== Create an Accountant');
  await User.deleteOne({ username: 'accounts' });
  const created = await call('POST', '/users', { token: adminToken, body: { name: 'Sanjay Pawar', username: 'accounts', role: 'Accountant' } });
  ok('User created (201)', created.status === 201);
  const tempPass = created.body?.data?.tempPassword;
  ok('Temp password received', Boolean(tempPass));

  const accLogin1 = await call('POST', '/auth/login', { body: { username: 'accounts', password: tempPass } });
  ok('Login with the temporary password', accLogin1.status === 200);
  ok('mustChangePassword flag on', accLogin1.body?.data?.user?.mustChangePassword === true);

  const blocked = await call('GET', '/students', { token: accLogin1.body.data.accessToken });
  ok('Everything else blocked until the password is changed', blocked.status === 403, blocked.body?.code);

  const changed = await call('POST', '/auth/change-password', {
    token: accLogin1.body.data.accessToken,
    body: { currentPassword: tempPass, newPassword: 'accounts@2026' },
  });
  ok('Password change 200', changed.status === 200);

  const accLogin = await call('POST', '/auth/login', { body: { username: 'accounts', password: 'accounts@2026' } });
  const accToken = accLogin.body?.data?.accessToken;
  ok('Login with the new password', accLogin.status === 200);

  // Reset to defaults to keep the test repeatable — the previous run
  // leaves salary.view granted (which is exactly what should persist).
  await RolePermission.updateOne({ role: 'Accountant' }, { $set: { permissions: DEFAULT_GRANTS.Accountant } });
  permissionCache.clear();

  console.log('\n== Permission enforcement');
  const feeList = await call('GET', '/fees/demands', { token: accToken });
  ok('Accountant can view fees (200)', feeList.status === 200);

  const salary = await call('GET', '/salary/slips', { token: accToken });
  ok('Accountant gets 403 on salary', salary.status === 403, salary.body?.code);

  const usersAsAcc = await call('GET', '/users', { token: accToken });
  ok('Accountant gets 403 on user management', usersAsAcc.status === 403, usersAsAcc.body?.code);

  const adjust = await call('POST', '/stock/adjust', { token: accToken, body: { itemId: '6a8aa77f2b55a25767517a03', delta: -1, reason: 'test' } });
  ok('Accountant gets 403 on stock adjust', adjust.status === 403, adjust.body?.code);

  console.log('\n== Admin grants access (with no deploy)');
  const grant = await call('PATCH', '/permissions/Accountant', {
    token: adminToken,
    body: { permissions: [...new Set([...(await (await fetch(`${base}/permissions`, { headers: { authorization: `Bearer ${adminToken}` } })).json()).data.grants.Accountant.permissions, 'salary.view'])] },
  });
  ok('Permission update 200', grant.status === 200, `v${grant.body?.data?.version}`);

  const salaryAgain = await call('GET', '/salary/slips', { token: accToken });
  ok('Accountant can NOW view salary (200)', salaryAgain.status === 200,
     `${salaryAgain.body?.data?.slips?.length} slips — same token, no restart`);

  console.log('\n== Locked permission');
  const tryLocked = await call('PATCH', '/permissions/Principal', {
    token: adminToken, body: { permissions: ['permission.manage'] },
  });
  ok('permission.manage grant blocked', tryLocked.status === 403, tryLocked.body?.code);

  const tryAdminRole = await call('PATCH', '/permissions/Admin', { token: adminToken, body: { permissions: [] } });
  ok('Changing Admin permissions is blocked', tryAdminRole.status === 400);

  console.log('\n== Validation');
  const badBody = await call('POST', '/students', { token: adminToken, body: { name: 'X', phone: '123' } });
  ok('Zod validation 400', badBody.status === 400, `${badBody.body?.errors?.length} field errors`);

  const badId = await call('GET', '/students/not-an-id', { token: adminToken });
  ok('Bad ObjectId -> 400', badId.status === 400);

  const nsqli = await call('POST', '/auth/login', { body: { username: { $ne: null }, password: { $ne: null } } });
  ok('NoSQL injection blocked', nsqli.status === 400 || nsqli.status === 401, `status ${nsqli.status}`);

  console.log(`\n${'='.repeat(50)}\nPASS: ${pass}   FAIL: ${fail}`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH:', e.message, e.stack); process.exit(1); });
