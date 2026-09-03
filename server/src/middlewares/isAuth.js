const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/tokens');
const { userCache } = require('../utils/ttlCache');
const User = require('../models/user.model');

// Verifies the access token and sets req.user / req.userId / req.role.
//
// Cache-first: this used to run a User.findById on every authenticated
// request — an extra DB round trip on every call. Now most requests
// are served from cache. On deactivation or a role change auth.service
// invalidates explicitly, and the TTL is only 30 seconds anyway — so the
// window for stale data is very small.
const isAuth = asyncHandler(async (req, _res, next) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        throw new ApiError(401, 'Login required').withCode('NO_TOKEN');
    }

    let decoded;
    try {
        decoded = verifyAccessToken(header.slice(7));
    } catch {
        // A deliberately distinct code here: the frontend interceptor uses it to
        // refresh silently and replay the request. Any other 401 sends the user
        // straight to the login screen.
        throw new ApiError(401, 'Session expired').withCode('TOKEN_EXPIRED');
    }

    let user = userCache.get(decoded.id);

    if (!user) {
        // .lean() — we want a plain object, not the overhead of a mongoose
        // document (no document method is ever called on req.user).
        user = await User.findById(decoded.id)
            .select('name username role isActive mustChangePassword')
            .lean();

        if (!user) throw new ApiError(401, 'This account no longer exists').withCode('NO_USER');
        userCache.set(decoded.id, user);
    }

    if (!user.isActive) {
        // A deactivated user could still be sitting in the cache — evict them,
        // otherwise they keep being served until the TTL expires.
        userCache.invalidate(decoded.id);
        throw new ApiError(403, 'This account has been deactivated').withCode('DEACTIVATED');
    }

    req.userId = user._id.toString();
    req.role = user.role;
    req.user = user;

    next();
});

// A user whose password is still temporary may only change that password
// — everything else is a 403. Otherwise the temporary password the Admin
// handed over keeps working for months.
const requirePasswordChanged = (req, _res, next) => {
    if (req.user?.mustChangePassword) {
        throw new ApiError(403, 'Please change your password first').withCode('MUST_CHANGE_PASSWORD');
    }
    next();
};

module.exports = { isAuth, requirePasswordChanged };
