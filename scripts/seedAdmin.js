// The first Admin plus default role permissions. Run once, at install.
//
//   npm run seed:admin
//
// A password can be passed as an argument, otherwise one is generated:
//   node scripts/seedAdmin.js "MeraStrongPassword"

require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../server/src/models/user.model');
const permissionService = require('../server/src/services/permission.service');
const { generateTempPassword } = require('../server/src/services/user.service');

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const existing = await User.findOne({ role: 'Admin' }).lean();

    if (existing) {
        console.log(`Admin already exists: ${existing.username}`);
    } else {
        const password = process.argv[2] || generateTempPassword();

        const admin = await User.create({
            name: 'School Admin',
            username: 'admin',
            role: 'Admin',
            password,
            // A generated password must be changed. Even a supplied one should be —
            // forcing a change on first sign-in is simply better.
            mustChangePassword: true,
        });

        console.log('\n  Admin created');
        console.log(`  username : ${admin.username}`);
        console.log(`  password : ${password}`);
        console.log('  (must be changed on first sign-in)\n');
    }

    const seeded = await permissionService.seedDefaults();
    for (const r of seeded) {
        console.log(`  ${r.created ? 'BANA' : 'PEHLE SE'}  ${r.role}${r.count ? ` (${r.count} permissions)` : ''}`);
    }

    process.exit(0);
};

run().catch((err) => {
    console.error('Seed fail:', err.message);
    process.exit(1);
});
