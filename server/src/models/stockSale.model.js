const mongoose = require('mongoose');

const saleLineSchema = new mongoose.Schema(
    {
        item: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', required: true },
        itemName: { type: String, required: true },
        variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        variantLabel: { type: String, default: '' },
        qty: { type: Number, required: true, min: 1 },
        rate: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const stockSaleSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        billNo: { type: String, required: true }, // from the counter

        // null for a walk-in buyer — not every sale belongs to a student
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
        studentName: { type: String, default: 'Walk-in' },
        class: { type: mongoose.Schema.Types.ObjectId, ref: 'SchoolClass', default: null },
        className: { type: String, default: '' },

        lines: { type: [saleLineSchema], required: true },

        subtotal: { type: Number, required: true, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        total: { type: Number, required: true, min: 0 },
        // These two fields alone decide whether the sale was cash or credit
        paidAmount: { type: Number, default: 0, min: 0 },
        dueAmount: { type: Number, default: 0, min: 0 },
        // Money received against this bill AFTER it was raised (a credit bill
        // being paid off later). Kept apart from paidAmount so a void can tell
        // "paid at the counter on day one" from "settled afterwards".
        duesReceived: { type: Number, default: 0, min: 0 },

        mode: {
            type: String,
            enum: ['Cash', 'UPI', 'Bank', 'Cheque', 'Credit'],
            required: true,
        },
        date: { type: Date, required: true },
        note: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

        voided: { type: Boolean, default: false },
        voidedAt: { type: Date, default: null },
        voidReason: { type: String, default: '' },
    },
    { timestamps: true }
);

stockSaleSchema.index({ session: 1, billNo: 1 }, { unique: true });
// "What has this student bought?"
stockSaleSchema.index({ student: 1, date: -1 });
// Daily sales register
stockSaleSchema.index({ session: 1, date: -1 });

module.exports = mongoose.models.StockSale || mongoose.model('StockSale', stockSaleSchema);
