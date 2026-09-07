const AcademicSession = require('../models/academicSession.model');
const ApiError = require('../utils/ApiError');
const { sessionCache } = require('../utils/ttlCache');
const { isValidMonthKey } = require('../utils/istDate');

const ACTIVE_KEY = 'active';

// ---------------------------------------------------------------------------
// The active session is the app's partition key — every service asks for
// it. Hence the cache and the long TTL: it changes once a year but is
// read on every request.
// ---------------------------------------------------------------------------
const getActiveSession = async () => {
    const cached = sessionCache.get(ACTIVE_KEY);
    if (cached) return cached;

    const doc = await AcademicSession.findOne({ isActive: true })
        .select('name startDate endDate feeMonths idCardFee')
        .lean();

    if (!doc) {
        throw new ApiError(
            409,
            'There is no active academic session — an Admin must create one in Settings'
        ).withCode('NO_ACTIVE_SESSION');
    }

    sessionCache.set(ACTIVE_KEY, doc);
    return doc;
};

// When only the name is needed (which is 90% of cases)
const getActiveSessionName = async () => (await getActiveSession()).name;

const list = () => AcademicSession.find().sort({ startDate: -1 }).lean();

const create = async (payload) => {
    const { name, startDate, endDate, feeMonths, idCardFee } = payload;

    if (new Date(endDate) <= new Date(startDate)) {
        throw new ApiError(400, 'End date must be after the start date');
    }

    const badMonths = (feeMonths || []).filter((m) => !isValidMonthKey(m));
    if (badMonths.length) {
        throw new ApiError(400, `Invalid month format (expected YYYY-MM): ${badMonths.join(', ')}`);
    }

    const created = await AcademicSession.create({
        name,
        startDate,
        endDate,
        feeMonths: feeMonths || [],
        idCardFee: idCardFee || 0,
        isActive: false,
    });

    return created;
};

// ---------------------------------------------------------------------------
// Only one session is active at a time. Deactivating the old and
// activating the new is two writes, so deactivate first — a failure in
// between leaves "no active session" (which fails loudly) rather than
// "two active sessions", which would quietly corrupt every query.
// ---------------------------------------------------------------------------
const activate = async (id) => {
    const target = await AcademicSession.findById(id);
    if (!target) throw new ApiError(404, 'Session not found');

    await AcademicSession.updateMany(
        { isActive: true, _id: { $ne: target._id } },
        { $set: { isActive: false } }
    );

    target.isActive = true;
    await target.save();

    sessionCache.invalidate(ACTIVE_KEY);
    return target;
};

const update = async (id, updates) => {
    const doc = await AcademicSession.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
    );
    if (!doc) throw new ApiError(404, 'Session not found');

    sessionCache.invalidate(ACTIVE_KEY);
    return doc;
};

module.exports = { getActiveSession, getActiveSessionName, list, create, activate, update };
