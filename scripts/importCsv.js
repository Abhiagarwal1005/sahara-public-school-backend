// ---------------------------------------------------------------------------
// Load a class's students from a CSV into the database.
//
//   node scripts/importCsv.js "path/to/Pre Nursery – A.csv"            (dry run)
//   node scripts/importCsv.js "path/to/Pre Nursery – A.csv" --write    (do it)
//
// Always run it WITHOUT --write first and read the plan. Running it twice is
// safe: anybody already on the roll is skipped, so nobody is admitted or
// numbered twice.
//
// COLUMNS, matched by header name:
//
//   Students Name · DOB · fathers name · Mother name · contact · Class
//
// A "Class ID" column is deliberately IGNORED. The sheet the school keeps had a
// different, incrementing value on every row and only the first one was a real
// class id — matching on it would have scattered a class across ids that do not
// exist. The class NAME is what gets looked up.
//
// Two phone numbers in one cell separated by "/" become the phone and the
// alternate. Dates are read DAY FIRST (22/03/2023). A blank date is fine.
//
// This script is deliberately SELF-CONTAINED: it talks to the models directly
// rather than going through a service, so it keeps working whatever else
// changes in the app.
// ---------------------------------------------------------------------------

require('dotenv').config();

const fs = require('fs');
const mongoose = require('mongoose');

const connectDB = require('../server/src/config/db');
const AcademicSession = require('../server/src/models/academicSession.model');
const SchoolClass = require('../server/src/models/schoolClass.model');
const Student = require('../server/src/models/student.model');
const User = require('../server/src/models/user.model');
const { Counter } = require('../server/src/models/counter.model');

const WRITE = process.argv.includes('--write');
const FILE = process.argv[2];

// ---- the admission date comes from the "Adm" column ----
//
// A NEW admission joined when THIS session opened. A RE-ADMISSION is a child
// who was already at the school and came back on the roll — they joined a year
// earlier, and that earlier date is the one a transfer certificate has to
// print.
//
// Anything that is not marked as a re-admission is treated as new, which is the
// safe way round: a blank cell in a sheet of new admissions still gets the
// right date.
const DATE_NEW = new Date('2026-04-01T00:00:00.000Z');
const DATE_READMISSION = new Date('2025-04-01T00:00:00.000Z');

// "Re Admission", "re-admission", "readmission", "RE ADM" — the sheet is typed
// by hand, so the spelling is not something to rely on. Spaces, hyphens and
// case are stripped and anything starting with "re" counts.
const isReadmission = (raw) => /^re/.test(String(raw || '').toLowerCase().replace(/[\s\-_.]/g, ''));

// Day-first, as the sheet is written. Blank is fine.
const parseDob = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return { value: null };

    const m = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
    if (!m) throw new Error(`date "${text}" not understood`);

    const [, d, mo, rawYear] = m;
    // "30/7/25" is how a hurried hand writes 2025. Every date in this sheet is
    // a child's date of birth, so a two-digit year is always this century —
    // there is no 1925 four-year-old.
    const y = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const probe = new Date(`${iso}T00:00:00Z`);
    // 31 February would pass a range check and then silently become 3 March.
    if (probe.getUTCMonth() + 1 !== Number(mo) || probe.getUTCDate() !== Number(d)) {
        throw new Error(`"${text}" is not a real date`);
    }
    // ---- a date of birth that cannot be right ----
    //
    // "30/7/25" reads as 2025, and for an L.K.G child that would mean a
    // one-year-old. Two-digit years are where this goes wrong most often (25
    // typed for 21), so an implausible age is called out rather than stored
    // quietly — the date of birth is what a transfer certificate prints.
    const years = (Date.now() - probe.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (years < 2) {
        return { value: probe, doubt: years < 0 ? 'a date in the FUTURE' : `that makes the child ${years.toFixed(1)} years old` };
    }

    return { value: probe };
};

// "8958635075/7668831922" — both numbers live in one cell.
//
// A REAL prefix is stripped: +91, 0091 and a leading 0 are dialling prefixes,
// not part of the number. Anything else that is the wrong length is a TYPO, and
// this refuses to guess which digit is the wrong one.
//
// That distinction matters. The first version just took the last ten digits,
// which turned "83759422788" (eleven digits — one too many, somewhere) into
// "3759422788" by silently chopping the leading 8. It then rejected THAT for
// starting with a 3 — so a number the sheet had wrong was reported as a
// different number that was wrong in a different way, and nobody reading the
// output could tell what had actually been typed.
const parsePhones = (raw) => {
    const good = [];
    const bad = [];

    for (const piece of String(raw || '').split(/[/,;]/)) {
        const digits = piece.replace(/\D/g, '');
        if (!digits) continue;

        let n = digits;
        let assumed = '';

        // Real dialling prefixes come off the FRONT.
        if (n.length === 13 && n.startsWith('091')) n = n.slice(3);
        else if (n.length === 12 && n.startsWith('91')) n = n.slice(2);
        else if (n.length === 11 && n.startsWith('0')) n = n.slice(1);
        // One digit too many on a number that already starts 6-9 is a slipped
        // keystroke at the END, not a prefix at the front — "83759422788" is
        // 8375942278 with the 8 typed twice. Taking the LAST ten here was the
        // bug: it chopped the leading 8 and left a number starting with 3,
        // which then failed for a reason that had nothing to do with the typo.
        else if (n.length === 11 && /^[6-9]/.test(n)) {
            assumed = `extra digit at the end, read as ${n.slice(0, 10)}`;
            n = n.slice(0, 10);
        }

        if (/^[6-9]\d{9}$/.test(n)) {
            good.push(n);
            if (assumed) bad.push({ raw: digits, why: assumed, kept: true });
            // 9999999999 is NOT flagged. The office types it deliberately when a
            // number is missing or wrong, precisely so the record stands out and
            // can be corrected later — it is their marker, not a mistake, and
            // warning about it every run would bury the warnings that matter.
            continue;
        }

        bad.push({
            raw: digits,
            why: n.length > 10 ? `${n.length} digits — ${n.length - 10} too many`
                : n.length < 10 ? `only ${n.length} digits — ${10 - n.length} missing`
                : `starts with ${n[0]}, not 6-9`,
        });
    }

    return { phone: good[0], altPhone: good[1] || '', bad };
};

// ---- splitting a CSV line ----
//
// A plain split(',') is NOT enough, and getting that wrong is invisible rather
// than loud. Most rows write two phone numbers as "9559459223/8882427847", but
// a few write them as "8126439124, 9634246843" — a comma INSIDE a quoted field.
// Splitting on every comma tore that one cell into two, shifted every later
// column one place right, and the Class column ended up reading the monthly fee
// ("1000"). The row was rejected for being in a different class, which is a
// baffling thing to be told about a row whose class is right there.
//
// So quotes are honoured: a comma inside them is part of the value, and "" is
// an escaped quote.
const cells = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];

        if (quoted) {
            if (ch !== '"') { cur += ch; continue; }
            if (line[i + 1] === '"') { cur += '"'; i += 1; continue; }
            quoted = false;
            continue;
        }

        if (ch === '"') { quoted = true; continue; }
        if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }

    out.push(cur.trim());
    return out;
};

// ---- comparing a class name ----
//
// The app writes the label with an EN DASH ("Nursery – A"), which nobody types
// by hand and Excel will happily turn into a plain hyphen. So every comparison
// is done on a flattened form: any kind of dash becomes one character, spaces
// collapse, and case stops mattering. "nursery a", "Nursery-A" and
// "Nursery – A" are all the same class.
// Dashes AND spaces are stripped, not normalised to one another — otherwise
// "Nursery-A" flattens to "nursery-a" while "Nursery A" flattens to "nurserya",
// and the two spellings of one class still fail to match.
const flatten = (v) => String(v || '').toLowerCase().replace(/[–—\-\s.]+/g, '');

(async () => {
    if (!FILE) {
        const dl = `${process.env.HOME}/Downloads`;
        const found = fs.existsSync(dl)
            ? fs.readdirSync(dl).filter((f) => f.toLowerCase().endsWith('.csv'))
            : [];

        console.log('Kaise chalana hai:\n');
        console.log('  node scripts/importCsv.js "<file ka path>"            <- preview');
        console.log('  node scripts/importCsv.js "<file ka path>" --write    <- asli mein daalo\n');
        console.log('Tip: path type mat karo — Terminal mein file ko DRAG karke chhod do,');
        console.log('     path apne aap aa jayega.\n');

        if (found.length) {
            console.log('Downloads mein yeh CSV files hain:\n');
            found.slice(0, 15).forEach((f) => console.log(`  node scripts/importCsv.js "${dl}/${f}"`));
        }
        process.exit(1);
    }

    await connectDB();

    const session = await AcademicSession.findOne({ isActive: true }).lean();
    if (!session) throw new Error('there is no active session');

    const admin = await User.findOne({ role: 'Admin' }).sort({ createdAt: 1 }).lean();
    if (!admin) throw new Error('no Admin user to record as the creator');

    console.log(`database : ${mongoose.connection.name}`);
    console.log(`session  : ${session.name}`);
    console.log(`actor    : ${admin.name} (${admin.username})`);
    console.log(`file     : ${FILE}\n`);

    const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    const header = cells(lines[0]);
    const idx = (want) => header.findIndex((h) => h.toLowerCase().replace(/\s+/g, '') === want);

    const col = {
        name: idx('studentsname'),
        dob: idx('dob'),
        father: idx('fathersname'),
        mother: idx('mothername'),
        contact: idx('contact'),
        adm: idx('adm'),
        klass: idx('class'),
    };

    if (col.name < 0) throw new Error('no "Students Name" column in this file');
    if (col.klass < 0) throw new Error('no "Class" column in this file');

    const rows = [];
    const problems = [];
    let className = null;

    for (const line of lines.slice(1)) {
        const c = cells(line);
        const name = (c[col.name] || '').trim();
        if (!name) continue;

        try {
            const parsedDob = parseDob(c[col.dob]);
            const dob = parsedDob.value;
            if (parsedDob.doubt) {
                console.log(`  CHECK THE SHEET: ${name} — date of birth "${c[col.dob].trim()}" → `
                    + `${dob.toISOString().slice(0, 10)}, ${parsedDob.doubt}`);
            }
            const { phone, altPhone, bad } = parsePhones(c[col.contact]);
            if (!phone) {
                throw new Error(bad.length
                    ? `no usable phone — ${bad.map((b) => `"${b.raw}" (${b.why})`).join(', ')}`
                    : 'the contact cell is empty');
            }

            const label = (c[col.klass] || '').trim();
            // Flattened, so a sheet where somebody typed the same class two
            // different ways is not refused for a difference that is not one.
            if (className && flatten(label) !== flatten(className)) {
                throw new Error(`mixed classes in one file: "${className}" and "${label}"`);
            }
            className = className || label;

            // Said loudly, with the reason, because the sheet is what needs
            // fixing — not this run.
            if (bad.length) {
                bad.forEach((b) => console.log(
                    b.kept
                        ? `  CHECK THE SHEET: ${name} — "${b.raw}" ${b.why}`
                        : `  CHECK THE SHEET: ${name} — "${b.raw}" ${b.why}; using ${phone} instead`
                ));
            }

            const readmitted = col.adm >= 0 && isReadmission(c[col.adm]);

            rows.push({
                name,
                guardianName: (c[col.father] || '').trim(),
                motherName: (c[col.mother] || '').trim(),
                dob,
                phone,
                altPhone,
                readmitted,
                admissionDate: readmitted ? DATE_READMISSION : DATE_NEW,
            });
        } catch (err) {
            problems.push(`${name}: ${err.message}`);
        }
    }

    // ---- rows that cannot be read ----
    //
    // These are LISTED, not fatal. Refusing a whole class because one cell is
    // blank means the office fixes one number and re-types nothing — it means
    // they run the whole thing again and wonder whether the first attempt did
    // anything. The good rows go in, the rest are named, and re-running after
    // the fix admits exactly the ones that were missed.
    if (problems.length) {
        console.log('\nTHESE ROWS ARE BEING LEFT OUT — fix them in the sheet and run again:');
        problems.forEach((p) => console.log('   ', p));
    }

    if (!rows.length) {
        console.log('\nNothing readable in this file.');
        await mongoose.disconnect();
        process.exit(1);
    }

    const all = await SchoolClass.find({ session: session.name }).sort({ order: 1 }).lean();
    const cls = all.find((c) => flatten(`${c.name}-${c.section}`) === flatten(className));

    if (!cls) {
        throw new Error(
            `no class named "${className}" in ${session.name}.\n  Classes that exist: `
            + all.map((c) => `${c.name} – ${c.section}`).join(', ')
        );
    }

    const readmits = rows.filter((r) => r.readmitted).length;

    console.log(`\nclass    : ${className}  (${cls._id})  fee ₹${cls.monthlyFee}`);
    console.log(`admitted : new ${DATE_NEW.toISOString().slice(0, 10)}`
        + (readmits ? `  ·  re-admission ${DATE_READMISSION.toISOString().slice(0, 10)} (${readmits})` : '')
        + '\n');

    console.log('NAME                     DOB         PHONE       ALT          ADMITTED    ADM');
    rows.forEach((r) => console.log(
        r.name.padEnd(24),
        (r.dob ? r.dob.toISOString().slice(0, 10) : '—').padEnd(11),
        r.phone.padEnd(11),
        (r.altPhone || '—').padEnd(12),
        r.admissionDate.toISOString().slice(0, 10),
        r.readmitted ? ' RE-ADM' : ' new'
    ));

    // ---- who is already on the roll ----
    //
    // Matched on name AND phone together. Name alone would refuse a second
    // Aarav Sharma, which a school of four hundred certainly has; phone alone
    // would refuse his sister.
    const existing = await Student.find({ session: session.name })
        .select('nameLower phone admissionNo className')
        .lean();

    const seen = new Map(existing.map((s) => [`${s.nameLower}|${s.phone}`, s]));

    const fresh = [];
    const dupes = [];

    for (const r of rows) {
        const key = `${r.name.toLowerCase()}|${r.phone}`;
        const clash = seen.get(key);
        if (clash) {
            dupes.push({ ...r, was: clash });
            continue;
        }
        // Against THIS sheet too — the same child twice in one file is at least
        // as common as running the file twice.
        seen.set(key, { admissionNo: '(in this file)', className });
        fresh.push(r);
    }

    console.log(`\n${rows.length} rows read · ${fresh.length} would be admitted`
        + (dupes.length ? ` · ${dupes.length} already on the roll` : ''));
    dupes.forEach((d) => console.log(`   skip: ${d.name} — already ${d.was.admissionNo} in ${d.was.className}`));

    if (!WRITE) {
        // The exact command, with this file's own path already in it. Telling
        // somebody to "add --write" means they have to retype a path with
        // spaces and an en dash in it; printing the line they can copy means
        // they do not.
        console.log('\n' + '='.repeat(64));
        console.log('NOTHING WAS SAVED — this was only a preview.');
        console.log('\nAgar upar sab theek lag raha hai, toh yeh command copy karke chalao:\n');
        console.log(`  node scripts/importCsv.js "${FILE}" --write`);
        console.log('\n' + '='.repeat(64));
        await mongoose.disconnect();
        return;
    }

    if (!fresh.length) {
        console.log('\nNothing to do — everybody in this file is already on the roll.');
        await mongoose.disconnect();
        return;
    }

    // ---- the admission numbers ----
    //
    // One $inc reserves the whole run, so the numbers are consecutive and
    // nobody admitting a child at the counter can be handed one of them.
    const counterId = `${session.name}:admissionNo`;
    const counter = await Counter.findByIdAndUpdate(
        counterId,
        { $inc: { seq: fresh.length } },
        { new: true, upsert: true }
    );
    const firstSeq = counter.seq - fresh.length + 1;
    const code = (n) => `ADM${String(n).padStart(4, '0')}`;

    const docs = fresh.map((r, i) => ({
        session: session.name,
        admissionNo: code(firstSeq + i),
        name: r.name,
        nameLower: r.name.toLowerCase().trim(),
        guardianName: r.guardianName,
        motherName: r.motherName,
        dob: r.dob,
        phone: r.phone,
        altPhone: r.altPhone,
        address: '',
        class: cls._id,
        className,
        monthlyFee: cls.monthlyFee,
        status: 'Active',
        admissionDate: r.admissionDate,
        feeOutstanding: 0,
        stockOutstanding: 0,
        chargeOutstanding: 0,
        creditBalance: 0,
        createdBy: admin._id,
    }));

    console.log('\nwriting...');
    // Written straight to the collection so that every field above lands as
    // given, whatever the schema happens to know about today.
    await Student.collection.insertMany(
        docs.map((d) => ({ ...d, createdAt: new Date(), updatedAt: new Date(), __v: 0 }))
    );

    console.log(`${docs.length} admitted to ${className}`);
    console.log(`admission numbers ${docs[0].admissionNo} – ${docs[docs.length - 1].admissionNo}`);

    // ---- headcounts ----
    //
    // studentCount is a denormalised figure, so it is rebuilt from the students
    // themselves rather than nudged — that also repairs any class that was
    // already out of step.
    console.log('\nrechecking class headcounts against the roll:');
    let fixed = 0;
    for (const c of await SchoolClass.find({ session: session.name }).lean()) {
        const actual = await Student.countDocuments({ session: session.name, class: c._id, status: 'Active' });
        if (actual !== c.studentCount) {
            await SchoolClass.updateOne({ _id: c._id }, { $set: { studentCount: actual } });
            console.log(`   FIXED  ${c.name} – ${c.section}: ${c.studentCount} -> ${actual}`);
            fixed += 1;
        }
    }
    if (!fixed) console.log('   all correct');

    // Repeated at the bottom on purpose: on a forty-row sheet the warning at
    // the top has scrolled away by the time the write finishes.
    if (problems.length) {
        console.log(`\n⚠  ${problems.length} student(s) were NOT admitted:`);
        problems.forEach((p) => console.log('   ', p));
        console.log('    Fix them in the sheet and run this again — nobody already in will be added twice.');
    }

    await mongoose.disconnect();
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
