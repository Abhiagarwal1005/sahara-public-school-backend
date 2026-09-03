// Creates the academic session and its classes.
//
//   node scripts/seedSession.js 2026-27
//
// The classes here are samples — replace this array with the school's real
// pass it in, or create the session from the app's Settings screen.

require('dotenv').config();
const mongoose = require('mongoose');

const AcademicSession = require('../server/src/models/academicSession.model');
const SchoolClass = require('../server/src/models/schoolClass.model');

const CLASSES = [
    { name: 'Nursery', section: 'A', monthlyFee: 900 },
    { name: 'LKG', section: 'A', monthlyFee: 950 },
    { name: 'UKG', section: 'A', monthlyFee: 1000 },
    { name: 'Class 1', section: 'A', monthlyFee: 1100 },
    { name: 'Class 2', section: 'A', monthlyFee: 1100 },
    { name: 'Class 3', section: 'A', monthlyFee: 1150 },
    { name: 'Class 4', section: 'A', monthlyFee: 1150 },
    { name: 'Class 5', section: 'A', monthlyFee: 1200 },
    { name: 'Class 6', section: 'A', monthlyFee: 1300 },
    { name: 'Class 7', section: 'A', monthlyFee: 1400 },
    { name: 'Class 8', section: 'A', monthlyFee: 1500 },
];

const run = async () => {
    const name = process.argv[2] || '2026-27';
    const [startYear] = name.split('-').map(Number);

    await mongoose.connect(process.env.MONGODB_URI);

    let session = await AcademicSession.findOne({ name });

    if (!session) {
        // April to March — India's standard academic year
        const feeMonths = [];
        for (let i = 0; i < 12; i += 1) {
            const m = ((3 + i) % 12) + 1;
            const y = 3 + i < 12 ? startYear : startYear + 1;
            feeMonths.push(`${y}-${String(m).padStart(2, '0')}`);
        }

        session = await AcademicSession.create({
            name,
            startDate: new Date(Date.UTC(startYear, 3, 1)),
            endDate: new Date(Date.UTC(startYear + 1, 2, 31)),
            feeMonths,
            isActive: true,
        });

        await AcademicSession.updateMany({ _id: { $ne: session._id } }, { $set: { isActive: false } });
        console.log(`Session ${name} created and active (${session.feeMonths.length} fee months)`);
    } else {
        console.log(`Session ${name} already exists`);
    }

    let created = 0;
    for (const [i, cls] of CLASSES.entries()) {
        const exists = await SchoolClass.findOne({ session: name, name: cls.name, section: cls.section });
        if (exists) continue;

        await SchoolClass.create({ ...cls, session: name, order: i + 1 });
        created += 1;
    }

    console.log(`${created} classes created (${CLASSES.length - created} already existed)`);
    process.exit(0);
};

run().catch((err) => {
    console.error('Seed fail:', err.message);
    process.exit(1);
});
