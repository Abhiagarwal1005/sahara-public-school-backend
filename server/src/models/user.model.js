const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../utils/permissions');

// Only three people sign in. Teachers and students do NOT have accounts —
// they are records. That keeps an entire authentication surface, a
// password-reset flow and a hundred-plus user documents off the free tier.
const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        username: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
            minlength: 3,
        },
        email: { type: String, lowercase: true, trim: true, default: '' },
        phone: { type: String, trim: true, default: '' },
        password: {
            type: String,
            required: true,
            // Not returned by default. Selecting it by accident would leak the hash
            // into logs or responses.
            select: false,
        },
        role: { type: String, enum: ROLES, required: true },
        isActive: { type: Boolean, default: true },
        // An Admin-created account is forced to change its password on first
        // sign-in — otherwise the temporary password lives for months.
        mustChangePassword: { type: Boolean, default: false },
        lastLoginAt: { type: Date, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

// Login lookup — the hottest query, and the first of every session.
userSchema.index({ username: 1 }, { unique: true });
// Settings > Users screen
userSchema.index({ role: 1, isActive: 1 });

userSchema.pre('save', async function hashPassword(next) {
    if (!this.isModified('password')) return next();
    // 10 rounds — about 60ms on Vercel's shared CPU. 12 rounds is ~250ms,
    // which is noticeable on login and unnecessary for a three-user system.
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
