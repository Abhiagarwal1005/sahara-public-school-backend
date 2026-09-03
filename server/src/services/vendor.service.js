const Vendor = require('../models/vendor.model');
const Purchase = require('../models/purchase.model');
const VendorPayment = require('../models/vendorPayment.model');
const ApiError = require('../utils/ApiError');
const ledger = require('./ledger.service');
const sessionService = require('./session.service');
const withTransaction = require('../utils/withTransaction');
const { round2, allocate } = require('../utils/money');
const { daysBetweenIST } = require('../utils/istDate');
const { prefixMatch } = require('../utils/search');

const list = async (query = {}) => {
    const filter = { isActive: true };
    const rx = prefixMatch(query.search);
    if (rx) filter.nameLower = rx;

    // Largest outstanding first — this is the screen the Principal uses to
    // decide who gets released this week. The sort field is part of the
    // index, so there is no in-memory sort.
    return Vendor.find(filter)
        .select('name phone gstin outstanding totalPurchased totalPaid')
        .sort({ outstanding: -1 })
        .lean();
};

const getById = async (id) => {
    const vendor = await Vendor.findById(id).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');
    return vendor;
};

const create = async (payload, actorId) => {
    const nameLower = payload.name.toLowerCase().trim();

    // The same vendor entered under two names is the most common reason an
    // outstanding looks wrong — hence the unique index on nameLower, and a clear message here.
    const exists = await Vendor.findOne({ nameLower }).lean();
    if (exists) throw new ApiError(409, 'A vendor with this name already exists');

    return Vendor.create({ ...payload, nameLower, createdBy: actorId });
};

const update = async (id, updates) => {
    const vendor = await Vendor.findById(id);
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    // Balances are never edited by hand — they move only through purchases
    // and payments.
    delete updates.outstanding;
    delete updates.totalPurchased;
    delete updates.totalPaid;

    Object.assign(vendor, updates);
    await vendor.save();
    return vendor;
};

// ---------------------------------------------------------------------------
// Vendor statement — bills and payments in date order with a running
// balance. This is the shape the vendor keeps in their own ledger, so in
// a dispute the two can be compared line by line.
// ---------------------------------------------------------------------------
const statement = async (vendorId) => {
    const vendor = await getById(vendorId);

    const [bills, payments] = await Promise.all([
        Purchase.find({ vendor: vendorId })
            .select('billNo billDate total paidAmount dueAmount status')
            .sort({ billDate: 1 })
            .lean(),
        VendorPayment.find({ vendor: vendorId })
            .select('amount mode refNo date allocations')
            .sort({ date: 1 })
            .lean(),
    ]);

    const rows = [
        ...bills.map((b) => ({
            date: b.billDate,
            particulars: `Bill ${b.billNo}`,
            bill: b.total,
            payment: 0,
            ref: b._id,
        })),
        ...payments.map((p) => ({
            date: p.date,
            particulars: `Payment${p.refNo ? ` · ${p.refNo}` : ''} · ${p.mode}`,
            bill: 0,
            payment: p.amount,
            ref: p._id,
        })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = 0;
    for (const row of rows) {
        balance = round2(balance + row.bill - row.payment);
        row.balance = balance;
    }

    return { vendor, rows, closingBalance: balance };
};

// ---------------------------------------------------------------------------
// Ageing — 0-30 / 31-60 / 60+. This is what tells you which vendor is
// about to stop supplying.
// ---------------------------------------------------------------------------
const ageing = async () => {
    const session = await sessionService.getActiveSessionName();

    const unpaid = await Purchase.find({
        session,
        status: { $in: ['Unpaid', 'Partial'] },
    })
        .select('vendor vendorName billNo billDate dueAmount')
        .lean();

    const byVendor = new Map();

    for (const bill of unpaid) {
        const age = daysBetweenIST(bill.billDate);
        const key = bill.vendor.toString();

        if (!byVendor.has(key)) {
            byVendor.set(key, {
                vendorId: bill.vendor,
                vendorName: bill.vendorName,
                bucket0_30: 0,
                bucket31_60: 0,
                bucket60plus: 0,
                total: 0,
                oldestDays: 0,
            });
        }

        const row = byVendor.get(key);
        const amount = round2(bill.dueAmount);

        if (age <= 30) row.bucket0_30 = round2(row.bucket0_30 + amount);
        else if (age <= 60) row.bucket31_60 = round2(row.bucket31_60 + amount);
        else row.bucket60plus = round2(row.bucket60plus + amount);

        row.total = round2(row.total + amount);
        row.oldestDays = Math.max(row.oldestDays, age);
    }

    const vendors = [...byVendor.values()].sort((a, b) => b.total - a.total);

    const totals = vendors.reduce(
        (acc, v) => ({
            bucket0_30: round2(acc.bucket0_30 + v.bucket0_30),
            bucket31_60: round2(acc.bucket31_60 + v.bucket31_60),
            bucket60plus: round2(acc.bucket60plus + v.bucket60plus),
            total: round2(acc.total + v.total),
        }),
        { bucket0_30: 0, bucket31_60: 0, bucket60plus: 0, total: 0 }
    );

    return { vendors, totals };
};

// ---------------------------------------------------------------------------
// Paying a vendor.
//
// `allocations` is required — a floating payment tied to no bill cannot be
// explained six months later. The user can pick the bills; if they do not,
// it allocates oldest-first automatically.
// ---------------------------------------------------------------------------
const pay = async ({ vendorId, amount, mode, refNo = '', date, allocations = [], attachment = null, note = '' }, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const value = round2(amount);

    if (!(value > 0)) throw new ApiError(400, 'Amount must be greater than zero');

    const vendor = await Vendor.findById(vendorId).lean();
    if (!vendor) throw new ApiError(404, 'Vendor not found');

    if (value > vendor.outstanding) {
        throw new ApiError(
            400,
            `Only ₹${vendor.outstanding} is outstanding for this vendor — you cannot allocate more`
        );
    }

    // Unpaid bills, oldest first
    const openBills = await Purchase.find({
        vendor: vendorId,
        status: { $in: ['Unpaid', 'Partial'] },
    })
        .sort({ billDate: 1 })
        .lean();

    let finalAllocations;

    if (allocations.length) {
        const billMap = new Map(openBills.map((b) => [b._id.toString(), b]));
        let sum = 0;

        finalAllocations = allocations.map((a) => {
            const bill = billMap.get(a.purchase.toString());
            if (!bill) throw new ApiError(400, 'That bill is not an open bill for this vendor');
            if (a.amount > bill.dueAmount) {
                throw new ApiError(400, `Bill ${bill.billNo} has only ₹${bill.dueAmount} outstanding`);
            }
            sum = round2(sum + a.amount);
            return { purchase: bill._id, billNo: bill.billNo, amount: round2(a.amount) };
        });

        if (sum !== value) {
            throw new ApiError(400, `Allocation total (₹${sum}) does not match the payment (₹${value})`);
        }
    } else {
        const splits = allocate(value, openBills.map((b) => b.dueAmount));
        finalAllocations = openBills
            .map((b, i) => ({ purchase: b._id, billNo: b.billNo, amount: splits[i] }))
            .filter((a) => a.amount > 0);
    }

    return withTransaction(async (mongoSession) => {
        const payDate = date || new Date();

        const [payment] = await VendorPayment.create(
            [
                {
                    session,
                    vendor: vendorId,
                    vendorName: vendor.name,
                    amount: value,
                    mode,
                    refNo,
                    date: payDate,
                    allocations: finalAllocations,
                    attachment: attachment || undefined,
                    note,
                    by: actorId,
                },
            ],
            { session: mongoSession }
        );

        // Update paid/due on each bill — one bulkWrite
        const billMap = new Map(openBills.map((b) => [b._id.toString(), b]));

        await Purchase.bulkWrite(
            finalAllocations.map((a) => {
                const bill = billMap.get(a.purchase.toString());
                const newPaid = round2(bill.paidAmount + a.amount);
                const newDue = round2(bill.total - newPaid);
                return {
                    updateOne: {
                        filter: { _id: a.purchase },
                        update: {
                            $set: {
                                paidAmount: newPaid,
                                dueAmount: newDue,
                                status: newDue <= 0 ? 'Paid' : 'Partial',
                            },
                        },
                    },
                };
            }),
            { session: mongoSession, ordered: false }
        );

        await Vendor.updateOne(
            { _id: vendorId },
            { $inc: { outstanding: -value, totalPaid: value } },
            { session: mongoSession }
        );

        await ledger.record(
            {
                session,
                direction: 'OUT',
                type: 'VENDOR_PAY',
                amount: value,
                mode,
                txnDate: payDate,
                party: { kind: 'Vendor', ref: vendorId, name: vendor.name },
                refModel: 'VendorPayment',
                refId: payment._id,
                note: note || `Bills: ${finalAllocations.map((a) => a.billNo).join(', ')}`,
                recordedBy: actorId,
            },
            mongoSession
        );

        return payment;
    });
};

const listPayments = async (vendorId) =>
    VendorPayment.find({ vendor: vendorId }).sort({ date: -1 }).limit(100).lean();

module.exports = { list, getById, create, update, statement, ageing, pay, listPayments };
