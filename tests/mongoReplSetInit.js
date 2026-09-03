const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient('mongodb://127.0.0.1:27018/?directConnection=true');
  await c.connect();
  const admin = c.db('admin');
  try {
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] } });
    console.log('replSetInitiate sent');
  } catch (e) {
    if (!/already initialized/i.test(e.message)) throw e;
    console.log('already initialized');
  }
  for (let i = 0; i < 40; i++) {
    const s = await admin.command({ hello: 1 });
    if (s.isWritablePrimary) { console.log(`PRIMARY ready after ${i * 0.5}s`); await c.close(); return; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('primary never came up');
})().catch(e => { console.error('RS init fail:', e.message); process.exit(1); });
