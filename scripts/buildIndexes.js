// Run once after deploying, and again after any schema or index change.
//
// autoIndex is OFF in production (config/db.js), so building indexes is a
// deliberate step. Running syncIndexes on every cold start can lock a
// collection on a shared-CPU cluster and slow the boot down.
//
//   npm run build:indexes

require('dotenv').config();
const mongoose = require('mongoose');

const models = [
    require('../server/src/models/user.model'),
    require('../server/src/models/rolePermission.model'),
    require('../server/src/models/refreshToken.model'),
    require('../server/src/models/counter.model').Counter,
    require('../server/src/models/academicSession.model'),
    require('../server/src/models/schoolClass.model'),
    require('../server/src/models/student.model'),
    require('../server/src/models/lead.model'),
    require('../server/src/models/feeDemand.model'),
    require('../server/src/models/transaction.model'),
    require('../server/src/models/monthlyRollup.model'),
    require('../server/src/models/stockItem.model'),
    require('../server/src/models/stockMovement.model'),
    require('../server/src/models/stockSale.model'),
    require('../server/src/models/vendor.model'),
    require('../server/src/models/purchase.model'),
    require('../server/src/models/vendorPayment.model'),
    require('../server/src/models/teacher.model'),
    require('../server/src/models/teacherAttendance.model'),
    require('../server/src/models/classAttendance.model'),
    require('../server/src/models/salarySlip.model'),
    require('../server/src/models/expense.model'),
    require('../server/src/models/expenseCategory.model'),
    require('../server/src/models/auditLog.model'),
];

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected. Building indexes...\n');

    for (const model of models) {
        await model.syncIndexes();
        const idx = await model.collection.indexes();
        console.log(`  OK  ${model.modelName.padEnd(20)} ${idx.length} indexes`);
    }

    console.log('\nAll indexes built.');
    process.exit(0);
};

run().catch((err) => {
    console.error('Index build fail:', err.message);
    process.exit(1);
});
