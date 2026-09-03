const mongoose = require('mongoose');

const purchaseLineSchema = new mongoose.Schema(
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

// A vendor's bill — brings stock in and creates the outstanding.
//
// Worth noting: a credit purchase writes NO Transaction row. No cash has
// moved yet — only stock went up and the vendor's balance went up.
// The ledger row appears when the vendor is actually paid.
const purchaseSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
        vendorName: { type: String, required: true }, // denormalised

        billNo: { type: String, required: true, trim: true },
        billDate: { type: Date, required: true },

        lines: { type: [purchaseLineSchema], required: true },

        subtotal: { type: Number, required: true, min: 0 },
        tax: { type: Number, default: 0, min: 0 },
        otherCharges: { type: Number, default: 0, min: 0 },
        total: { type: Number, required: true, min: 0 },
        paidAmount: { type: Number, default: 0, min: 0 },
        dueAmount: { type: Number, default: 0, min: 0 },

        status: { type: String, enum: ['Unpaid', 'Partial', 'Paid'], default: 'Unpaid' },

        billImage: {
            publicId: { type: String, default: '' },
            width: Number,
            height: Number,
            format: String,
            bytes: Number,
        },
        note: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// ---------------------------------------------------------------------------
// The same bill cannot be entered twice. That is the most common way a
// purchase register goes wrong — somebody re-enters a bill and the
// vendor's outstanding doubles. Blocked at the database level.
// ---------------------------------------------------------------------------
purchaseSchema.index({ vendor: 1, billNo: 1 }, { unique: true });

// Unpaid bills, newest first
purchaseSchema.index({ session: 1, status: 1, billDate: -1 });
// Vendor statement + ageing buckets
purchaseSchema.index({ vendor: 1, billDate: -1 });
// Payment allocation — oldest unpaid first
purchaseSchema.index({ vendor: 1, status: 1, billDate: 1 });

module.exports = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);
