const mongoose = require('mongoose');

const schoolClassSchema = new mongoose.Schema(
    {
        session: { type: String, required: true }, // "2026-27"
        name: { type: String, required: true, trim: true }, // "Class 5"
        section: { type: String, required: true, trim: true, uppercase: true }, // "A"
        // The school's own order — "Class 10" sorts before "Class 2"
        // alphabetically, which looks wrong in every dropdown. Hence explicit order.
        order: { type: Number, required: true },
        monthlyFee: { type: Number, required: true, min: 0 },
        // Denormalised. The roster count appears everywhere (class list, fee
        // report, attendance screen) and running countDocuments each time
        // would mean three extra queries on three screens.
        studentCount: { type: Number, default: 0, min: 0 },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// "Class 5 - A" cannot be created twice in one session
schoolClassSchema.index({ session: 1, name: 1, section: 1 }, { unique: true });
// Every dropdown and roster list, in the school's own order
schoolClassSchema.index({ session: 1, isActive: 1, order: 1 });

// Built in one place so the "Class 5 – A" format is identical everywhere.
schoolClassSchema.virtual('label').get(function label() {
    return `${this.name} – ${this.section}`;
});

schoolClassSchema.set('toJSON', { virtuals: true });
schoolClassSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.SchoolClass || mongoose.model('SchoolClass', schoolClassSchema);
