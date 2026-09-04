const Lead = require('../models/lead.model');
const ApiError = require('../utils/ApiError');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { prefixMatch, normalisePhone, isPhoneLike } = require('../utils/search');
const { startOfDayIST, endOfDayIST } = require('../utils/istDate');

const { STATUSES, OPEN_STATUSES } = Lead;

// The list stays deliberately lean — no note, no address, and above all no
// followUps array, which grows with every call made. The detail view fetches
// the full document instead.
const LIST_FIELDS = 'name guardianName phone classInterested source status nextFollowUp createdAt';

// A lead is closed once it is Admitted or Lost — it drops out of the chase.
const isClosed = (status) => status === 'Admitted' || status === 'Lost';

const list = async (query = {}) => {
    const { page, limit } = getPaginationParams(query);
    const filter = {};

    if (query.status) filter.status = query.status;
    else if (query.open === 'true') filter.status = { $in: OPEN_STATUSES };

    // "Who do I have to call today?" — everything open and due, including
    // anything already overdue. This is the screen the front desk lives on.
    if (query.due === 'true') {
        filter.status = { $in: OPEN_STATUSES };
        filter.nextFollowUp = { $ne: null, $lte: endOfDayIST(query.on || new Date()) };
    }

    const term = String(query.search || '').trim();
    if (term) {
        // A phone number is an exact match; a name is a prefix match. Same
        // rule as the student search, for the same indexing reasons.
        if (isPhoneLike(term)) filter.phone = normalisePhone(term);
        else {
            const rx = prefixMatch(term);
            if (rx) filter.nameLower = rx;
        }
    }

    // Due-first screens sort by the date they are due; everything else shows
    // the newest enquiry first.
    const sort = query.due === 'true' ? { nextFollowUp: 1 } : { createdAt: -1 };

    return fetchPage(Lead.find(filter).select(LIST_FIELDS).sort(sort), { page, limit });
};

const getById = async (id) => {
    const lead = await Lead.findById(id).lean();
    if (!lead) throw new ApiError(404, 'Lead not found');
    return lead;
};

// Counts for the tab badges. One grouped query rather than six counts.
const summary = async () => {
    const [byStatus, dueCount] = await Promise.all([
        Lead.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        Lead.countDocuments({
            status: { $in: OPEN_STATUSES },
            nextFollowUp: { $ne: null, $lte: endOfDayIST(new Date()) },
        }),
    ]);

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    byStatus.forEach((r) => {
        counts[r._id] = r.n;
    });

    const open = OPEN_STATUSES.reduce((sum, s) => sum + counts[s], 0);

    return { counts, open, due: dueCount, total: open + counts.Admitted + counts.Lost };
};

const create = async (payload, actorId) => {
    const lead = await Lead.create({
        ...payload,
        phone: normalisePhone(payload.phone),
        altPhone: payload.altPhone ? normalisePhone(payload.altPhone) : '',
        nameLower: payload.name.toLowerCase().trim(),
        createdBy: actorId,
    });

    return lead;
};

// Somebody rang the same number twice. Not blocked — a family can enquire
// about two children — but the desk should be told before they type it all
// in again.
const findByPhone = async (phone) =>
    Lead.find({ phone: normalisePhone(phone) })
        .select('name guardianName status nextFollowUp createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

const update = async (id, updates) => {
    const lead = await Lead.findById(id);
    if (!lead) throw new ApiError(404, 'Lead not found');

    Object.assign(lead, updates);
    if (updates.name) lead.nameLower = updates.name.toLowerCase().trim();
    if (updates.phone) lead.phone = normalisePhone(updates.phone);
    if (updates.altPhone !== undefined) {
        lead.altPhone = updates.altPhone ? normalisePhone(updates.altPhone) : '';
    }

    await lead.save();
    return lead;
};

// ---------------------------------------------------------------------------
// Logging a follow-up. This is the one write that matters.
//
// It does three things at once, because in practice they are one action:
// records what was said, moves the lead's status, and sets the next date.
// Splitting them into three screens is how follow-ups stop being logged.
// ---------------------------------------------------------------------------
const addFollowUp = async (id, { note, outcome, nextFollowUp }, actor) => {
    const lead = await Lead.findById(id);
    if (!lead) throw new ApiError(404, 'Lead not found');

    if (isClosed(lead.status)) {
        throw new ApiError(
            409,
            `This lead is already marked ${lead.status} — reopen it before logging a follow-up`
        );
    }

    lead.followUps.push({
        at: new Date(),
        note: note.trim(),
        outcome,
        by: actor.id,
        byName: actor.name || '',
    });

    lead.status = outcome;

    if (isClosed(outcome)) {
        // A closed lead has nothing left to chase.
        lead.nextFollowUp = null;
        lead.closedAt = new Date();
        lead.closeReason = note.trim();
    } else {
        lead.nextFollowUp = nextFollowUp ? startOfDayIST(nextFollowUp) : null;
        lead.closedAt = null;
        lead.closeReason = '';
    }

    await lead.save();
    return lead;
};

// Called by mistake, or a duplicate. A lead owns no money and appears in no
// report, so deleting one has no consequence anywhere else — which is
// exactly why this module can offer a delete at all.
const remove = async (id) => {
    const lead = await Lead.findById(id).lean();
    if (!lead) throw new ApiError(404, 'Lead not found');

    await Lead.deleteOne({ _id: id });
    return { deleted: id, name: lead.name };
};

module.exports = { list, getById, summary, create, findByPhone, update, addFollowUp, remove };
