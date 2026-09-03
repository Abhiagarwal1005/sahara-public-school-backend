// Boot-time env validation. Discovering missing config at runtime
// (while the first user is trying to sign in) is the worst way to find out —
// so the process fails right here, with a clear message.

const REQUIRED = [
    'MONGODB_URI',
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
];

// Cloudinary is OPTIONAL. Attaching a photo to a bill or an expense is a
// convenience, not something the school's accounts depend on — so the app
// must run perfectly well without a Cloudinary account at all.
//
// When these are absent the upload endpoints answer with a clear 503 and the
// UI simply does not show an upload box. Every image field in every schema is
// already `.optional()`, so nothing else changes.
const CLOUDINARY_KEYS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];

// Minimum length for secrets. A short JWT secret makes the whole auth layer
// worthless, and the mistake stays invisible until somebody cracks it.
const MIN_SECRET_LENGTH = 32;

const validateEnv = () => {
    const missing = REQUIRED.filter((key) => !process.env[key]);

    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}. ` +
                'See .env.example — every key is explained there.'
        );
    }

    // Not an error — but it should never be a surprise either. Somebody who
    // set two of the three keys needs to know why uploads are off.
    const cloudinarySet = CLOUDINARY_KEYS.filter((k) => Boolean(process.env[k]));
    if (cloudinarySet.length && cloudinarySet.length < CLOUDINARY_KEYS.length) {
        console.warn(
            '[config] Cloudinary is partially configured — image upload stays OFF. ' +
                `Missing: ${CLOUDINARY_KEYS.filter((k) => !process.env[k]).join(', ')}`
        );
    } else if (!cloudinarySet.length) {
        console.warn('[config] Cloudinary not configured — image upload is disabled (optional feature).');
    }

    const weak = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'].filter(
        (key) => process.env[key].length < MIN_SECRET_LENGTH
    );

    if (weak.length) {
        throw new Error(
            `These secrets are too short (need ${MIN_SECRET_LENGTH}+ chars): ${weak.join(', ')}. ` +
                'Generate with: openssl rand -base64 48'
        );
    }

    if (process.env.ACCESS_TOKEN_SECRET === process.env.REFRESH_TOKEN_SECRET) {
        throw new Error(
            'ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must not be the same — ' +
                'otherwise an access token could be used as a refresh token.'
        );
    }
};

const config = {
    isProd: process.env.NODE_ENV === 'production',
    port: Number(process.env.PORT) || 8000,

    accessSecret: process.env.ACCESS_TOKEN_SECRET,
    refreshSecret: process.env.REFRESH_TOKEN_SECRET,
    accessExpiry: process.env.ACCESS_TOKEN_EXPIRY || '15m',
    refreshExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d',

    // Multiple origins, comma-separated. Trailing slashes are stripped
    // because a browser never sends the Origin header with one.
    origins: (process.env.FRONTEND_URL || '')
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),

    cloudinary: {
        // All three or none. A partial config is treated as "off" — half-set
        // credentials would fail at upload time with a confusing Cloudinary
        // error rather than a clear "not configured" from us.
        enabled: CLOUDINARY_KEYS.every((k) => Boolean(process.env[k])),
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        apiSecret: process.env.CLOUDINARY_API_SECRET,
        folder: process.env.CLOUDINARY_FOLDER || 'sps',
    },

    cookie: {
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        domain: process.env.COOKIE_DOMAIN || undefined,
    },
};

module.exports = { validateEnv, config };
