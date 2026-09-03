const SchoolClass = require('../models/schoolClass.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');

const list = async ({ includeInactive = false } = {}) => {
    const session = await sessionService.getActiveSessionName();

    const filter = { session };
    if (!includeInactive) filter.isActive = true;

    // In the school's own order — "Class 10" sorts before "Class 2"
    // alphabetically, which looks wrong in every dropdown.
    return SchoolClass.find(filter).sort({ order: 1 }).lean();
};

const getById = async (id) => {
    const doc = await SchoolClass.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Class not found');
    return doc;
};

const create = async (payload) => {
    const session = await sessionService.getActiveSessionName();

    // if no order was given, append at the end
    let { order } = payload;
    if (order === undefined || order === null) {
        const last = await SchoolClass.findOne({ session }).sort({ order: -1 }).select('order').lean();
        order = (last?.order || 0) + 1;
    }

    // A duplicate "Class 5 - A" is blocked at the DB level too (unique index),
    // but a clear message here is better.
    const exists = await SchoolClass.exists({
        session,
        name: payload.name,
        section: payload.section.toUpperCase(),
    });
    if (exists) throw new ApiError(409, `${payload.name} – ${payload.section} already exists`);

    return SchoolClass.create({ ...payload, session, order });
};

const update = async (id, updates) => {
    const doc = await SchoolClass.findById(id);
    if (!doc) throw new ApiError(404, 'Class not found');

    // Changing monthlyFee applies only to FUTURE months. Demands already
    // raised stay as they are — otherwise last month's raised amount would
    // change today and the report would quietly tell a different story.
    Object.assign(doc, updates);
    await doc.save();
    return doc;
};

// A class is never deleted, only deactivated — and only when it holds no
// active students.
const deactivate = async (id) => {
    const doc = await SchoolClass.findById(id);
    if (!doc) throw new ApiError(404, 'Class not found');

    const active = await Student.countDocuments({ class: id, status: 'Active' });
    if (active > 0) {
        throw new ApiError(
            409,
            `This class has ${active} active students — move them elsewhere first`
        );
    }

    doc.isActive = false;
    await doc.save();
    return doc;
};

module.exports = { list, getById, create, update, deactivate };
