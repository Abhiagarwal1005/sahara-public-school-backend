const mongoose = require('mongoose');

// A small Admin-managed list — Electricity, Repairs, Transport, Events...
// Not hardcoded, because every school has its own heads — and this is the
// list the year-end expense account is built on.
const expenseCategorySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        nameLower: { type: String, required: true, lowercase: true, trim: true },
        isActive: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

expenseCategorySchema.index({ nameLower: 1 }, { unique: true });
expenseCategorySchema.index({ isActive: 1, nameLower: 1 });

expenseCategorySchema.pre('validate', function syncNameLower(next) {
    if (this.isModified('name') && this.name) this.nameLower = this.name.toLowerCase().trim();
    next();
});

module.exports =
    mongoose.models.ExpenseCategory || mongoose.model('ExpenseCategory', expenseCategorySchema);
