const mongoose = require('mongoose');

// Audit trail for quantity. The live number lives on the item
// (StockItem.currentStock / variant.currentStock); these rows explain how it got there.
//
// When the year-end physical count does not match, this collection is what
// answers "where did those 5 pieces go".
const stockMovementSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        item: { type: mongoose.Schema.Types.ObjectId, ref: 'StockItem', required: true },
        itemName: { type: String, required: true }, // denormalised
        variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        variantLabel: { type: String, default: '' },

        type: {
            type: String,
            enum: ['PURCHASE_IN', 'SALE_OUT', 'RETURN_IN', 'ADJUST', 'OPENING'],
            required: true,
        },
        // Signed — positive coming in, negative going out. Keeping one field means
        // summing to a balance is straightforward — no adding two columns
        // together.
        qty: { type: Number, required: true },
        rate: { type: Number, default: 0, min: 0 },
        // What remained after this movement. Not needed for recompute, but it is
        // the most-read column on the history screen.
        balanceAfter: { type: Number, default: 0 },

        refModel: { type: String, default: '' }, // StockSale / Purchase
        refId: { type: mongoose.Schema.Types.ObjectId, default: null },
        note: { type: String, default: '' },
        date: { type: Date, required: true },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// "Show this item's movement history"
stockMovementSchema.index({ item: 1, date: -1 });
// All sales / all purchases in a period
stockMovementSchema.index({ session: 1, type: 1, date: -1 });
// Recompute script — the full ledger for one item
stockMovementSchema.index({ item: 1, variantId: 1, date: 1 });

module.exports =
    mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
