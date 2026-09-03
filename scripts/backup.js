// ---------------------------------------------------------------------------
// Database backup — one gzipped JSON file per collection.
//
// Why this matters: Atlas M0 (free tier) has NO automated backups. This
// database holds a school's fee receipts and payroll. Running it without a
// restore path is not acceptable — one wrong command or cluster issue and
// a year's accounts are gone.
//
// mongodump is not used because it has to be installed separately
// (mongodb-database-tools). This script uses only the driver, so it runs
// anywhere the app runs.
//
//   node scripts/backup.js                    -> into ./backups/
//   node scripts/backup.js /path/to/folder
//
// To run it daily (a VPS or any machine with a system cron):
//   0 2 * * *  cd /path/to/Sps-backend && node scripts/backup.js >> backup.log 2>&1
//
// Restore: see scripts/restore.js (or gunzip the file and insertMany).
// ---------------------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');

// Each run gets its own folder — older backups are never overwritten
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(process.argv[2] || 'backups', stamp);

// How many backups to keep. Daily for 30 days = 30 folders; anything older
// is removed automatically so the disk does not fill up.
const KEEP = Number(process.env.BACKUP_KEEP || 30);

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection.db;

    fs.mkdirSync(outDir, { recursive: true });

    const collections = await db.listCollections().toArray();
    let totalDocs = 0;
    let totalBytes = 0;

    for (const { name } of collections) {
        // Read in batches — pulling a whole collection into memory at once kills
        // the process on a large database.
        const docs = await db.collection(name).find({}).toArray();
        const json = JSON.stringify(docs);
        const gz = zlib.gzipSync(json, { level: 9 });

        const file = path.join(outDir, `${name}.json.gz`);
        fs.writeFileSync(file, gz);

        totalDocs += docs.length;
        totalBytes += gz.length;
        console.log(`  ${name.padEnd(22)} ${String(docs.length).padStart(7)} docs  ${(gz.length / 1024).toFixed(1)} KB`);
    }

    fs.writeFileSync(
        path.join(outDir, '_meta.json'),
        JSON.stringify({ takenAt: new Date().toISOString(), collections: collections.length, docs: totalDocs }, null, 2)
    );

    console.log(`\nBackup: ${outDir}`);
    console.log(`${collections.length} collections, ${totalDocs} docs, ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`);

    // Remove older backups
    const parent = path.dirname(outDir);
    const all = fs
        .readdirSync(parent)
        .filter((d) => fs.statSync(path.join(parent, d)).isDirectory())
        .sort()
        .reverse();

    for (const old of all.slice(KEEP)) {
        fs.rmSync(path.join(parent, old), { recursive: true, force: true });
        console.log(`  removed old backup: ${old}`);
    }

    process.exit(0);
};

run().catch((err) => {
    console.error('Backup fail:', err.message);
    // Non-zero exit so cron or monitoring notices
    process.exit(1);
});
