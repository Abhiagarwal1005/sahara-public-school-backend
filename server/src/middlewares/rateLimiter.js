const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Stated honestly: on serverless this limiter counts in per-instance
// memory. If Vercel is running 3 instances the effective limit is three
// times higher, and the counter resets when an instance recycles. This is
// a speed bump, not DDoS protection.
//
// It is still here because what it does stop is real: a script guessing a
// thousand passwords against one warm instance. Actual DDoS is handled by
// Vercel's edge layer, not by our function layer.
//
// If distributed limiting is ever genuinely needed, Upstash Redis (free
// tier) is the lowest-effort route — nothing outside this file would
// change.
// ---------------------------------------------------------------------------

const common = {
    standardHeaders: true,
    legacyHeaders: false,
    // Vercel sends the real client IP in x-forwarded-for; app.set('trust proxy')
    // is set in app.js so every request does not look like one IP.
    message: { success: false, message: 'Too many requests — please try again shortly' },
};

// Applies to every API route
const generalLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, max: 600 });

// Login / refresh — against credential stuffing
const authLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    max: 20,
    // A successful login is not counted — a busy office's whole morning comes
    // from one IP, and locking them out would be wrong. Only failed attempts
    // spend the budget.
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many failed attempts — try again in 15 minutes' },
});

// Upload signature — each signature is an upload slot
const uploadLimiter = rateLimit({ ...common, windowMs: 10 * 60 * 1000, max: 60 });

// Heavy write operations (fee generation, salary generation) — these
// run once per school, and there is no valid reason to repeat them.
const heavyLimiter = rateLimit({ ...common, windowMs: 10 * 60 * 1000, max: 20 });

module.exports = { generalLimiter, authLimiter, uploadLimiter, heavyLimiter };
