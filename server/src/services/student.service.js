const mongoose = require('mongoose');
const Student = require('../models/student.model');
const FeeDemand = require('../models/feeDemand.model');
const StockSale = require('../models/stockSale.model');
const Transaction = require('../models/transaction.model');
const SchoolClass = require('../models/schoolClass.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { prefixMatch, isPhoneLike, normalisePhone } = require('../utils/search');
const { round2 } = require('../utils/money');

// These are the fields every list response returns — never the whole document.
// A small query and a small payload, so it parses quickly on the shared
// laptop in the school office.
const LIST_FIELDS =
    'admissionNo name className class phone guardianName monthlyFee feeOutstanding stockOutstanding status idCard';

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, status: query.status || 'Active' };

    if (query.class) filter.class = query.class;
    if (query.hasDues === 'true') filter.feeOutstanding = { $gt: 0 };

    // "Who in 5-B has not taken their ID card yet." A flag, so this is an
    // indexed equality — the same read as the plain roster, not a second query.
    if (query.idCard === 'issued') filter['idCard.issued'] = true;
    if (query.idCard === 'pending') filter['idCard.issued'] = { $ne: true };

    // A full phone number is an exact match (index hit); otherwise an anchored
    // name prefix — both use an index. See utils/search.js.
    const term = (query.search || '').trim();
    if (term) {
        if (isPhoneLike(term)) {
            filter.phone = normalisePhone(term);
        } else {
            const rx = prefixMatch(term);
            if (rx) filter.nameLower = rx;
        }
    }

    // The sort field is the last part of the index — filter and sort both come
    // from one index, with no in-memory sort.
    const sort = filter.feeOutstanding ? { feeOutstanding: -1 } : { nameLower: 1 };

    return fetchPage(Student.find(filter).select(LIST_FIELDS).sort(sort), { page, limit, withTotal: true });
};

const getById = async (id) => {
    const doc = await Student.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Student not found');
    return doc;
};

// ---------------------------------------------------------------------------
// A student's full ledger — fee demands, receipts and stock purchases
// together, in date order. This is the data behind "print statement".
// ---------------------------------------------------------------------------
const getLedger = async (studentId) => {
    const student = await getById(studentId);

    const [demands, sales, payments] = await Promise.all([
        FeeDemand.find({ student: studentId })
            .select('month amount discount paidAmount status dueDate')
            .sort({ month: -1 })
            .lean(),
        StockSale.find({ student: studentId, voided: false })
            .select('billNo date total paidAmount dueAmount lines')
            .sort({ date: -1 })
            .limit(50)
            .lean(),
        Transaction.find({
            'party.kind': 'Student',
            'party.ref': studentId,
            voided: false,
        })
            .select(
                'type amount mode txnDate receiptNo note direction party voided ' +
                    'verified verifiedAt verifiedByName'
            )
            .sort({ txnDate: -1 })
            .limit(100)
            .lean(),
    ]);

    return {
        student,
        demands,
        sales,
        // Same flag, same single source as the day book — see report.service.
        payments: payments.map((p) => ({ ...p, verifiable: Transaction.isVerifiable(p) })),
        // These two numbers are not counted from documents — they are maintained
        // on the Student. That is why this screen is as fast at 3,000 students as
        // at 3000.
        summary: {
            feeOutstanding: student.feeOutstanding,
            stockOutstanding: student.stockOutstanding,
            totalOutstanding: student.feeOutstanding + student.stockOutstanding,
        },
    };
};

const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();

    const cls = await SchoolClass.findOne({ _id: payload.class, session }).lean();
    if (!cls) throw new ApiError(404, 'Class not found');

    return withTransaction(async (mongoSession) => {
        const seq = await getNextSequence('admissionNo', session, mongoSession);

        const [student] = await Student.create(
            [
                {
                    ...payload,
                    session,
                    admissionNo: formatCode('ADM', seq),
                    nameLower: payload.name.toLowerCase().trim(),
                    className: `${cls.name} – ${cls.section}`,
                    // Falls back to the class default — override it for cases like a
                    // sibling concession.
                    monthlyFee: payload.monthlyFee ?? cls.monthlyFee,
                    createdBy: actorId,
                },
            ],
            { session: mongoSession }
        );

        await SchoolClass.updateOne(
            { _id: cls._id },
            { $inc: { studentCount: 1 } },
            { session: mongoSession }
        );

        return student;
    });
};

// ---------------------------------------------------------------------------
// Update. Changing class is the delicate case: both class counts move and
// the denormalised className has to be rewritten.
//
// Old receipts keep their className — they stay filed under the class they
// were issued in, otherwise last month's class-wise report would quietly
// change.
// ---------------------------------------------------------------------------
const update = async (id, updates, actorId) => {
    const student = await Student.findById(id);
    if (!student) throw new ApiError(404, 'Student not found');

    const changingClass = updates.class && updates.class.toString() !== student.class.toString();

    if (!changingClass) {
        Object.assign(student, updates);
        await student.save();
        return student;
    }

    const cls = await SchoolClass.findById(updates.class).lean();
    if (!cls) throw new ApiError(404, 'The new class was not found');

    const oldClassId = student.class;

    return withTransaction(async (mongoSession) => {
        Object.assign(student, updates, { className: `${cls.name} – ${cls.section}` });
        await student.save({ session: mongoSession });

        await SchoolClass.bulkWrite(
            [
                { updateOne: { filter: { _id: oldClassId }, update: { $inc: { studentCount: -1 } } } },
                { updateOne: { filter: { _id: cls._id }, update: { $inc: { studentCount: 1 } } } },
            ],
            { session: mongoSession }
        );

        // Future unpaid demands move to the new class — otherwise the new class's
        // next month's class-wise report would still show the old class.
        await FeeDemand.updateMany(
            { student: id, status: { $ne: 'Paid' } },
            { $set: { class: cls._id, className: `${cls.name} – ${cls.section}` } },
            { session: mongoSession }
        );

        return student;
    });
};

// Never deleted — status becomes Left. The full history is kept.
const markLeft = async (id) => {
    const student = await Student.findById(id);
    if (!student) throw new ApiError(404, 'Student not found');
    if (student.status === 'Left') return student;

    const due = student.feeOutstanding + student.stockOutstanding;

    return withTransaction(async (mongoSession) => {
        student.status = 'Left';
        student.leftAt = new Date();
        await student.save({ session: mongoSession });

        await SchoolClass.updateOne(
            { _id: student.class },
            { $inc: { studentCount: -1 } },
            { session: mongoSession }
        );

        // The outstanding survives — a student leaving is not a way for dues to
        // disappear. They keep showing on the outstanding report.
        return { student, outstandingCarried: due };
    });
};

// Defaulters — no aggregation, just an indexed read
const defaulters = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, status: 'Active', feeOutstanding: { $gt: 0 } };
    if (query.class) filter.class = query.class;

    return fetchPage(
        Student.find(filter)
            .select('admissionNo name className phone guardianName feeOutstanding stockOutstanding')
            .sort({ feeOutstanding: -1 }),
        { page, limit, withTotal: true }
    );
};

// ---------------------------------------------------------------------------
// ID CARDS
//
// Issuing is one act at the counter: the card is handed over and the money is
// taken. So this sets the flag AND writes the ledger row, in one transaction —
// a card marked issued with no money recorded, or money recorded against no
// card, are both worse than the operation failing outright.
//
// A free card (staff child, replacement covered by the school) is `amount: 0`.
// That sets the flag and writes NO ledger row, because no cash moved — the same
// rule a discount follows.
// ---------------------------------------------------------------------------
const issueIdCard = async (studentId, { amount, mode = 'Cash', date, note = '' }, actor) => {
    const session = await sessionService.getActiveSession();

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    if (student.idCard?.issued) {
        throw new ApiError(409, `${student.name} has already been given an ID card`).withCode('IDCARD_ISSUED');
    }

    // Falls back to the school-wide fee for the year, so the counter types a
    // number only when this particular card is an exception.
    const value = round2(amount ?? session.idCardFee ?? 0);
    if (!(value >= 0)) throw new ApiError(400, 'Amount cannot be negative');

    const issuedAt = date || new Date();

    return withTransaction(async (mongoSession) => {
        let txn = null;

        if (value > 0) {
            txn = await ledger.record(
                {
                    session: session.name,
                    direction: 'IN',
                    type: 'ID_CARD',
                    amount: value,
                    mode,
                    txnDate: issuedAt,
                    party: { kind: 'Student', ref: student._id, name: student.name },
                    // Carried so the class-wise collection report works off the
                    // same rollup every other class figure comes from.
                    classId: student.class,
                    className: student.className,
                    refModel: 'Student',
                    refId: student._id,
                    note: note || 'ID card',
                    recordedBy: actor.id,
                },
                mongoSession
            );
        }

        await Student.updateOne(
            { _id: studentId, 'idCard.issued': { $ne: true } },
            {
                $set: {
                    'idCard.issued': true,
                    'idCard.issuedAt': issuedAt,
                    'idCard.amount': value,
                    'idCard.issuedBy': actor.id,
                    'idCard.txn': txn?._id || null,
                    'idCard.note': note,
                },
            },
            { session: mongoSession }
        );

        return {
            studentId,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
            amount: value,
            mode: value > 0 ? mode : 'Adjustment',
            issuedAt,
            transactionId: txn?._id || null,
        };
    });
};

// Marked by mistake. The flag clears and, if money was taken, the ledger row is
// REVERSED — never deleted. Both lines stay in the day book, like every other
// correction in this app.
const cancelIdCard = async (studentId, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to cancel this');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');
    if (!student.idCard?.issued) throw new ApiError(409, 'No ID card has been issued to this student');

    // The exact row this issue wrote — not "a transaction that mentions this
    // student", which would pick up a fee receipt.
    const txn = student.idCard.txn
        ? await Transaction.findOne({ _id: student.idCard.txn, voided: false }).lean()
        : null;

    return withTransaction(async (mongoSession) => {
        if (txn) {
            await ledger.reverse(
                { original: txn, reason: reason.trim(), actorId: actor.id },
                mongoSession
            );
        }

        await Student.updateOne(
            { _id: studentId },
            {
                $set: {
                    'idCard.issued': false,
                    'idCard.issuedAt': null,
                    'idCard.amount': 0,
                    'idCard.issuedBy': null,
                    'idCard.txn': null,
                    'idCard.note': '',
                },
            },
            { session: mongoSession }
        );

        return { studentId, name: student.name, refunded: txn ? txn.amount : 0 };
    });
};

// ---------------------------------------------------------------------------
// Class-wise: how many have taken theirs, how many have not, and what came in.
//
// One aggregation over Student — a few hundred documents with the flag on an
// index — not a scan of the ledger. Same reasoning as the outstanding report.
// ---------------------------------------------------------------------------
const idCardSummary = async () => {
    const session = await sessionService.getActiveSessionName();

    const [rows, classes] = await Promise.all([
        Student.aggregate([
            { $match: { session, status: 'Active' } },
            {
                $group: {
                    _id: '$class',
                    className: { $first: '$className' },
                    total: { $sum: 1 },
                    issued: { $sum: { $cond: [{ $eq: ['$idCard.issued', true] }, 1, 0] } },
                    collected: { $sum: { $cond: [{ $eq: ['$idCard.issued', true] }, '$idCard.amount', 0] } },
                },
            },
        ]),
        // Classes with no students still belong on the report — a class missing
        // from the list reads as "done", which is the opposite of the truth.
        SchoolClass.find({ session, isActive: true }).select('name section order').sort({ order: 1 }).lean(),
    ]);

    const byClass = new Map(rows.map((r) => [String(r._id), r]));

    const list = classes.map((c) => {
        const row = byClass.get(String(c._id)) || { total: 0, issued: 0, collected: 0 };
        const pending = row.total - row.issued;
        return {
            classId: c._id,
            className: `${c.name} – ${c.section}`,
            total: row.total,
            issued: row.issued,
            pending,
            collected: round2(row.collected),
            percent: row.total ? Math.round((row.issued / row.total) * 100) : 0,
        };
    });

    const school = list.reduce(
        (acc, c) => ({
            total: acc.total + c.total,
            issued: acc.issued + c.issued,
            pending: acc.pending + c.pending,
            collected: round2(acc.collected + c.collected),
        }),
        { total: 0, issued: 0, pending: 0, collected: 0 }
    );

    return {
        classes: list,
        school: { ...school, percent: school.total ? Math.round((school.issued / school.total) * 100) : 0 },
    };
};

module.exports = {
    list, getById, getLedger, create, update, markLeft, defaulters,
    issueIdCard, cancelIdCard, idCardSummary,
    LIST_FIELDS,
};
