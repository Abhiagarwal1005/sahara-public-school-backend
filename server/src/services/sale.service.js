const StockSale = require('../models/stockSale.model');
const StockItem = require('../models/stockItem.model');
const StockMovement = require('../models/stockMovement.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const stockService = require('./stock.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { getNextSequence, formatCode } = require('../models/counter.model');
const { getPaginationParams, fetchPage } = require('../utils/paginate');
const { round2, allocate } = require('../utils/money');
const { startOfDayIST, endOfDayIST } = require('../utils/istDate');

// ---------------------------------------------------------------------------
// Selling uniform / books.
//
// The key decision here is `paidAmount`. Whatever was paid goes into the
// cash ledger; whatever was not goes onto the student's stockOutstanding
// and is collected along with the fees. One screen therefore handles both
// a cash sale and a credit sale.
// ---------------------------------------------------------------------------
const create = async (payload, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const { studentId = null, lines, discount = 0, paidAmount = 0, mode, date, note = '' } = payload;

    if (!lines?.length) throw new ApiError(400, 'At least one item is required');

    // All items in one query — not N queries for N lines
    const itemIds = [...new Set(lines.map((l) => l.item))];
    const items = await StockItem.find({ _id: { $in: itemIds } }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    let student = null;
    if (studentId) {
        student = await Student.findById(studentId).select('name class className').lean();
        if (!student) throw new ApiError(404, 'Student not found');
    }

    // Validate every line AND check stock — all of it before any write
    // begins. Nothing is worse than a half-completed sale.
    const resolved = [];
    for (const line of lines) {
        const item = itemMap.get(line.item.toString());
        if (!item) throw new ApiError(404, 'Item not found');

        const target = stockService.resolveStockTarget(item, line.variantId);

        if (line.qty > target.currentStock) {
            throw new ApiError(
                400,
                `${item.name}${target.variantLabel ? ` (${target.variantLabel})` : ''} has only ${target.currentStock} in stock`
            );
        }

        const rate = line.rate ?? target.sellPrice;
        resolved.push({
            item: item._id,
            itemName: item.name,
            variantId: line.variantId || null,
            variantLabel: target.variantLabel,
            qty: line.qty,
            rate: round2(rate),
            amount: round2(rate * line.qty),
            balanceAfter: target.currentStock - line.qty,
        });
    }

    const subtotal = round2(resolved.reduce((s, l) => s + l.amount, 0));
    const total = round2(subtotal - discount);

    if (total < 0) throw new ApiError(400, 'Discount cannot exceed the total');
    if (paidAmount > total) throw new ApiError(400, 'Paid amount cannot exceed the total');

    const dueAmount = round2(total - paidAmount);

    if (dueAmount > 0 && !studentId) {
        // There is no way to carry credit for a walk-in — who would we chase?
        throw new ApiError(400, 'A walk-in sale must be paid in full');
    }

    return withTransaction(async (mongoSession) => {
        const seq = await getNextSequence('billNo', session, mongoSession);
        const billNo = formatCode('SAL', seq, 5);
        const saleDate = date || new Date();

        const [sale] = await StockSale.create(
            [
                {
                    session,
                    billNo,
                    student: studentId,
                    studentName: student?.name || 'Walk-in',
                    class: student?.class || null,
                    className: student?.className || '',
                    lines: resolved.map(({ balanceAfter, ...l }) => l),
                    subtotal,
                    discount: round2(discount),
                    total,
                    paidAmount: round2(paidAmount),
                    dueAmount,
                    mode: dueAmount > 0 && paidAmount === 0 ? 'Credit' : mode,
                    date: saleDate,
                    note,
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        // Reduce stock and write a movement for each line
        for (const line of resolved) {
            await stockService.applyStockDelta(
                { itemId: line.item, variantId: line.variantId, delta: -line.qty },
                mongoSession
            );
        }

        await StockMovement.insertMany(
            resolved.map((l) => ({
                session,
                item: l.item,
                itemName: l.itemName,
                variantId: l.variantId,
                variantLabel: l.variantLabel,
                type: 'SALE_OUT',
                qty: -l.qty,
                rate: l.rate,
                balanceAfter: l.balanceAfter,
                refModel: 'StockSale',
                refId: sale._id,
                date: saleDate,
                by: actorId,
            })),
            { session: mongoSession }
        );

        // Only what was paid enters the cash ledger. The credit portion writes
        // no transaction yet — that comes when the money does.
        if (paidAmount > 0) {
            await ledger.record(
                {
                    session,
                    direction: 'IN',
                    type: 'STOCK_SALE',
                    amount: round2(paidAmount),
                    mode,
                    txnDate: saleDate,
                    party: {
                        kind: 'Student',
                        ref: studentId,
                        name: student?.name || 'Walk-in',
                    },
                    classId: student?.class || null,
                    className: student?.className || '',
                    refModel: 'StockSale',
                    refId: sale._id,
                    note: `Bill ${billNo}`,
                    recordedBy: actorId,
                },
                mongoSession
            );
        }

        if (dueAmount > 0 && studentId) {
            await Student.updateOne(
                { _id: studentId },
                { $inc: { stockOutstanding: dueAmount } },
                { session: mongoSession }
            );
        }

        return sale;
    });
};

const list = async (query) => {
    const session = await sessionService.getActiveSessionName();
    const { page, limit } = getPaginationParams(query);

    const filter = { session, voided: false };
    if (query.student) filter.student = query.student;
    if (query.date) {
        filter.date = { $gte: startOfDayIST(query.date), $lte: endOfDayIST(query.date) };
    } else if (query.from || query.to) {
        filter.date = {};
        if (query.from) filter.date.$gte = startOfDayIST(query.from);
        if (query.to) filter.date.$lte = endOfDayIST(query.to);
    }

    return fetchPage(
        StockSale.find(filter)
            .select('billNo studentName className total paidAmount dueAmount mode date lines')
            .sort({ date: -1 }),
        { page, limit, withTotal: true }
    );
};

const getById = async (id) => {
    const sale = await StockSale.findById(id).lean();
    if (!sale) throw new ApiError(404, 'Bill not found');
    return sale;
};

// ---------------------------------------------------------------------------
// Voiding a sale — stock back, outstanding back, and the cash portion
// reversed in the ledger.
// ---------------------------------------------------------------------------
const voidSale = async (id, reason, actor) => {
    if (!reason?.trim()) throw new ApiError(400, 'A reason is required to void this');

    const sale = await StockSale.findById(id).lean();
    if (!sale) throw new ApiError(404, 'Bill not found');
    if (sale.voided) throw new ApiError(409, 'This bill has already been voided');

    // Money has come in against this bill since it was raised. Voiding it now
    // would silently strand that receipt — the cash was counted, the ledger
    // says so, and no reversal covers it. The office has to deal with the
    // receipt first, which is a decision for a person, not for this function.
    if ((sale.duesReceived || 0) > 0) {
        throw new ApiError(
            409,
            `₹${sale.duesReceived} has already been received against this bill — it cannot be voided`
        );
    }

    const Transaction = require('../models/transaction.model');

    return withTransaction(async (mongoSession) => {
        await StockSale.updateOne(
            { _id: id, voided: false },
            { $set: { voided: true, voidedAt: new Date(), voidReason: reason.trim() } },
            { session: mongoSession }
        );

        // Stock goes back in
        for (const line of sale.lines) {
            await stockService.applyStockDelta(
                { itemId: line.item, variantId: line.variantId, delta: line.qty },
                mongoSession
            );
        }

        await StockMovement.insertMany(
            sale.lines.map((l) => ({
                session: sale.session,
                item: l.item,
                itemName: l.itemName,
                variantId: l.variantId,
                variantLabel: l.variantLabel,
                type: 'RETURN_IN',
                qty: l.qty,
                rate: l.rate,
                refModel: 'StockSale',
                refId: sale._id,
                note: `Void: ${reason.trim()}`,
                date: new Date(),
                by: actor.id,
            })),
            { session: mongoSession }
        );

        if (sale.dueAmount > 0 && sale.student) {
            await Student.updateOne(
                { _id: sale.student },
                { $inc: { stockOutstanding: -sale.dueAmount } },
                { session: mongoSession }
            );
        }

        // A dues receipt also carries refModel 'StockSale' and this same refId,
        // so the filter has to be narrower than "anything pointing at this
        // bill" — only the sale itself is written without a receipt number.
        const txn = await Transaction.findOne({
            refModel: 'StockSale',
            refId: sale._id,
            receiptNo: null,
            voided: false,
        })
            .sort({ createdAt: 1 })
            .lean();

        if (txn) {
            await ledger.reverse(
                { original: txn, reason: reason.trim(), actorId: actor.id },
                mongoSession
            );
        }

        return { voided: sale._id };
    });
};

// ---------------------------------------------------------------------------
// Stock dues — the other half of a credit sale.
//
// Selling on credit puts money on the student's head (Student.stockOutstanding).
// Until this existed that balance could only ever be CREATED — a uniform sold
// on credit stayed outstanding forever, because nothing but a void could
// bring it back down. This is the receiving side.
//
// It deliberately mirrors fee.service.collect() line for line: same oldest-
// first allocation, same receipt series, same single transaction. The office
// counter does one thing, so it should work one way.
// ---------------------------------------------------------------------------

// The unpaid bills behind a student's stock balance, oldest first.
const unpaidBills = (studentId) =>
    StockSale.find({ student: studentId, voided: false, dueAmount: { $gt: 0 } })
        .sort({ date: 1 })
        .lean();

const duesForStudent = async (studentId) => {
    const student = await Student.findById(studentId)
        .select('name admissionNo className stockOutstanding')
        .lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const bills = await unpaidBills(studentId);

    return {
        student: {
            id: student._id,
            name: student.name,
            admissionNo: student.admissionNo,
            className: student.className,
        },
        totalDue: round2(bills.reduce((acc, b) => acc + (b.dueAmount || 0), 0)),
        bills: bills.map((b) => ({
            id: b._id,
            billNo: b.billNo,
            date: b.date,
            total: b.total,
            paidAmount: b.paidAmount,
            dueAmount: b.dueAmount,
            items: b.lines
                .map((l) => `${l.itemName}${l.variantLabel ? ` (${l.variantLabel})` : ''} x ${l.qty}`)
                .join(', '),
        })),
    };
};

const collectDues = async ({ studentId, amount, mode, txnDate, note = '' }, actor) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const student = await Student.findById(studentId).lean();
    if (!student) throw new ApiError(404, 'Student not found');

    const bills = await unpaidBills(studentId);
    const totalDue = round2(bills.reduce((acc, b) => acc + (b.dueAmount || 0), 0));

    if (totalDue <= 0) throw new ApiError(400, 'This student has no stock dues outstanding');

    // Never take more than is owed — an extra zero would leave a negative
    // balance, and those only ever get fixed by hand afterwards.
    if (value > totalDue) {
        throw new ApiError(
            400,
            `Only ₹${totalDue} is outstanding — you cannot collect more than that`
        );
    }

    const splits = allocate(value, bills.map((b) => b.dueAmount || 0));

    return withTransaction(async (mongoSession) => {
        // The same receipt series as fees on purpose: the counter keeps one
        // receipt book, so two receipts must never share a number.
        const seq = await getNextSequence('receiptNo', session, mongoSession);
        const receiptNo = formatCode('RCP', seq, 5);

        const ops = [];
        const covered = [];

        bills.forEach((b, i) => {
            const take = splits[i];
            if (take <= 0) return;

            ops.push({
                updateOne: {
                    filter: { _id: b._id },
                    update: { $inc: { paidAmount: take, dueAmount: -take, duesReceived: take } },
                },
            });
            covered.push({ billNo: b.billNo, amount: take });
        });

        await StockSale.bulkWrite(ops, { session: mongoSession, ordered: true });

        // The field the student card, the outstanding report and the
        // defaulters list all read directly.
        await Student.updateOne(
            { _id: studentId },
            { $inc: { stockOutstanding: -value } },
            { session: mongoSession }
        );

        const txn = await ledger.record(
            {
                session,
                direction: 'IN',
                type: 'STOCK_SALE',
                amount: value,
                mode,
                txnDate: txnDate || new Date(),
                party: { kind: 'Student', ref: student._id, name: student.name },
                classId: student.class,
                className: student.className,
                refModel: 'StockSale',
                refId: bills[0]?._id || null,
                receiptNo,
                note: note || `Stock dues: ${covered.map((c) => c.billNo).join(', ')}`,
                recordedBy: actor.id,
            },
            mongoSession
        );

        return {
            receiptNo,
            transactionId: txn._id,
            amount: value,
            mode,
            date: txn.txnDate,
            student: {
                id: student._id,
                name: student.name,
                admissionNo: student.admissionNo,
                className: student.className,
            },
            covered,
            balanceAfter: round2(totalDue - value),
        };
    });
};

module.exports = { create, list, getById, voidSale, duesForStudent, collectDues };

