const mongoose = require('mongoose');

// One row per device/session. That allows revoking a single session
// (logout), and revoking all of a user's sessions at once if anything
// looks wrong.
//
// The token is stored HASHED. Even if the database leaked, nobody could
// hijack a session from a hash.
const refreshTokenSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        // The JWT's jti claim — ties this row to that particular token.
        jti: { type: String, required: true },
        tokenHash: { type: String, required: true },
        userAgent: { type: String, default: '' },
        ip: { type: String, default: '' },
        revokedAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true }
);

refreshTokenSchema.index({ jti: 1 }, { unique: true });
refreshTokenSchema.index({ user: 1, revokedAt: 1 });
// TTL index — Mongo removes rows itself once they expire. Without it this
// collection would become the largest within a year, and on M0 storage is
// the real limit.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
    mongoose.models.RefreshToken || mongoose.model('RefreshToken', refreshTokenSchema);
