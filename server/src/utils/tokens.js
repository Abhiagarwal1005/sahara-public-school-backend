const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { config } = require('../config/env');

// Access token — short-lived, held in client memory, sent in the
// Authorization header. The role is embedded only for logging and debugging;
// authorisation decisions always use the fresh user from DB/cache, otherwise
// a role change would not take effect until the old token expired.
const signAccessToken = (user) =>
    jwt.sign({ id: user._id.toString(), role: user.role }, config.accessSecret, {
        expiresIn: config.accessExpiry,
    });

// Refresh token — long-lived, in an httpOnly cookie. The `jti` gives each
// device its own row in the DB so a single session can be revoked.
const signRefreshToken = (user) => {
    const jti = crypto.randomUUID();
    const token = jwt.sign({ id: user._id.toString(), jti }, config.refreshSecret, {
        expiresIn: config.refreshExpiry,
    });
    return { token, jti };
};

const verifyAccessToken = (token) => jwt.verify(token, config.accessSecret);
const verifyRefreshToken = (token) => jwt.verify(token, config.refreshSecret);

// Refresh tokens are never stored in plain form. If the database leaked,
// nobody could hijack a session from the hashes.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    hashToken,
};
