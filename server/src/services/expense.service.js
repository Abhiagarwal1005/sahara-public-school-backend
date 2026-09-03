const Expense = require('../models/expense.model');
const ExpenseCategory = require('../models/expenseCategory.model');
const Transaction = require('../models/transaction.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2 } = require('../utils/money');
const { monthKeyIST, startOfDayIST, endOfDayIST } = require('../utils/istDate');
const { assertOwnedPublicId, destroyImage } = require('../config/cloudinary');

// ---- categories ----

const listCategories = () =>
    ExpenseCategory.find({ isActive: true }).sort({ nameLower: 1 }).lean();

const createCategory = async (payload, actorId) => {
    const nameLower = payload.name.toLowerCase().trim();
    const exists = await ExpenseCategory.findOne({ nameLower }).lean();
    if (exists) throw new ApiError(409, 'This category already exists');

    return ExpenseCategory.create({ ...payload, nameLower, createdBy: actorId });
};

const updateCategory = async (id, updates) => {
    const doc = await ExpenseCategory.findByIdAndUpdate(id, { $set: updates }, { new: true });
    if (!doc) throw new ApiError(404, 'Category not found');
    return doc;
};

// ---- expenses ----

const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const { categoryId, title, amount, date, mode, paidTo = '', attachments = [], note = '' } = payload;

    const category = await ExpenseCategory.findById(categoryId).lean();
    if (!category) throw new ApiError(404, 'Category not found');

    // The publicId the client sends must be inside our own folder — otherwise
    // an arbitrary Cloudinary reference could be stored
    for (const a of attachments) assertOwnedPublicId(a.publicId);

    const value = round2(amount);
    const expenseDate = date || new Date();

    return withTransaction(async (mongoSession) => {
        const [expense] = await Expense.create(
            [
                {
                    session,
                    category: category._id,
                    categoryName: category.name,
                    title,
                    amount: value,
                    date: expenseDate,
                    month: monthKeyIST(expenseDate),
                    mode,
                    paidTo,
                    attachments,
                    note,
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        await ledger.record(
            {
                session,
                direction: 'OUT',
                type: 'EXPENSE',
                amount: value,
                mode,
                txnDate: expenseDate,
                party: { kind: 'Other', ref: null, name: paidTo || category.name },
                refModel: 'Expense',
                refId: expense._id,
                note: title,
                attachments,
                recordedBy: actorId,
            },
            mongoSession
        );

        return expense;
    });
};

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session };
    if (query.category) filter.category = query.category;
    if (query.month) filter.month = query.month;
    if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = startOfDayIST(query.from);
        if (query.to) filter.date.$lte = endOfDayIST(query.to);
    }

    return fetchPage(
        Expense.find(filter)
            .select('title categoryName category amount date mode paidTo attachments')
            .sort({ date: -1 }),
        { page, limit }
    );
};

const getById = async (id) => {
    const doc = await Expense.findById(id).lean();
    if (!doc) throw new ApiError(404, 'Expense not found');
    return doc;
};

// Metadata only — changing the amount would make the ledger lie.
// For a wrong amount, delete and re-enter (delete writes a reversal).
const update = async (id, updates) => {
    const expense = await Expense.findById(id);
    if (!expense) throw new ApiError(404, 'Expense not found');

    const allowed = ['title', 'note', 'paidTo', 'attachments'];
    for (const key of Object.keys(updates)) {
        if (!allowed.includes(key)) {
            throw new ApiError(
                400,
                'Amount, date and category are not editable — delete and re-enter instead'
            );
        }
    }

    if (updates.attachments) {
        for (const a of updates.attachments) assertOwnedPublicId(a.publicId);
    }

    Object.assign(expense, updates);
    await expense.save();
    return expense;
};

// ---------------------------------------------------------------------------
// Delete = a reversal in the ledger. The expense row goes (it is only a
// record), but both lines stay in the cash book.
// ---------------------------------------------------------------------------
const remove = async (id, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to delete this');

    const expense = await Expense.findById(id).lean();
    if (!expense) throw new ApiError(404, 'Expense not found');

    const txn = await Transaction.findOne({
        refModel: 'Expense',
        refId: expense._id,
        voided: false,
    }).lean();

    await withTransaction(async (mongoSession) => {
        if (txn) {
            await ledger.reverse(
                { original: txn, reason: reason.trim(), actorId: actor.id },
                mongoSession
            );
        }
        await Expense.deleteOne({ _id: id }, { session: mongoSession });
    });

    // Images are removed afterwards — if that fails only an orphan file is
    // left, which is less bad than the delete failing.
    for (const a of expense.attachments || []) {
        destroyImage(a.publicId).catch(() => {});
    }

    return { deleted: id };
};

// Category-wise monthly total — "how much went on electricity"
const byCategory = async (month) => {
    const session = await sessionService.getActiveSessionName();

    const rows = await Expense.aggregate([
        { $match: { session, month } },
        {
            $group: {
                _id: '$category',
                categoryName: { $first: '$categoryName' },
                total: { $sum: '$amount' },
                count: { $sum: 1 },
            },
        },
        { $sort: { total: -1 } },
    ]);

    return {
        month,
        categories: rows.map((r) => ({
            categoryId: r._id,
            categoryName: r.categoryName,
            total: round2(r.total),
            count: r.count,
        })),
        total: round2(rows.reduce((s, r) => s + r.total, 0)),
    };
};

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    create,
    list,
    getById,
    update,
    remove,
    byCategory,
};
