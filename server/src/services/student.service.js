const mongoose = require('mongoose');
const Student = require('../models/student.model');
const SchoolClass = require('../models/schoolClass.model');
const FeeDemand = require('../models/feeDemand.model');
const StockSale = require('../models/stockSale.model');
const Transaction = require('../models/transaction.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { prefixMatch, isPhoneLike, normalisePhone } = require('../utils/search');

// These are the fields every list response returns — never the whole document.
// A small query and a small payload, so it parses quickly on the shared
// laptop in the school office.
const LIST_FIELDS =
    'admissionNo name className class phone guardianName monthlyFee feeOutstanding stockOutstanding status';

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, status: query.status || 'Active' };

    if (query.class) filter.class = query.class;
    if (query.hasDues === 'true') filter.feeOutstanding = { $gt: 0 };

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

    return fetchPage(Student.find(filter).select(LIST_FIELDS).sort(sort), { page, limit });
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
            .select('type amount mode txnDate receiptNo note direction')
            .sort({ txnDate: -1 })
            .limit(100)
            .lean(),
    ]);

    return {
        student,
        demands,
        sales,
        payments,
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
// dikhne lagti.
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
        { page, limit }
    );
};

module.exports = { list, getById, getLedger, create, update, markLeft, defaulters, LIST_FIELDS };
