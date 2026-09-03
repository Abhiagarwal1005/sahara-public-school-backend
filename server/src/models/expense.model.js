const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ExpenseCategory',
            required: true,
        },
        categoryName: { type: String, required: true }, // denormalised

        title: { type: String, required: true, trim: true },
        amount: { type: Number, required: true, min: 0 },
        date: { type: Date, required: true },
        month: { type: String, required: true }, // "2026-08"

        mode: { type: String, enum: ['Cash', 'UPI', 'Bank', 'Cheque'], required: true },
        paidTo: { type: String, default: '', trim: true },

        // The bill or invoice photo. Only the publicId is stored, never a full
        // URL — the frontend builds URLs with f_auto,q_auto and asks for a small
        // thumbnail in lists. That makes the Cloudinary free plan last years
        // rather than months.
        attachments: [
            {
                publicId: { type: String, required: true },
                width: Number,
                height: Number,
                format: String,
                bytes: Number,
            },
        ],

        note: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

// Expense register, newest first
expenseSchema.index({ session: 1, date: -1 });
// Category-wise monthly spend — "how much went on electricity"
expenseSchema.index({ session: 1, month: 1, category: 1 });

module.exports = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
