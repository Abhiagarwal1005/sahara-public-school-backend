const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');

const connectDB = require('./src/config/db');
const { config } = require('./src/config/env');
const asyncHandler = require('./src/utils/asyncHandler');
const errorHandler = require('./src/middlewares/errorHandler');
const { generalLimiter } = require('./src/middlewares/rateLimiter');
const ApiError = require('./src/utils/ApiError');

const app = express();

// Vercel sends the real client IP in x-forwarded-for. Without this every
// request would appear to come from one proxy IP and the rate limiter
// would block the whole school at once.
app.set('trust proxy', 1);
// x-powered-by: Express — no benefit in advertising the server's stack
app.disable('x-powered-by');

// ---------- security & core ----------
app.use(
    helmet({
        // This is a pure JSON API and serves no HTML — CSP has no role here
        // (it belongs to the frontend's deployment).
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
    })
);

app.use(compression());

app.use(
    cors({
        // Allow-list. A missing Origin (server-to-server, curl) is allowed too —
        // it is not a browser request, and auth is token-based anyway.
        origin: (origin, cb) => {
            if (!origin || config.origins.includes(origin)) return cb(null, true);
            cb(new ApiError(403, 'Requests from this origin are not allowed'));
        },
        // The refresh token lives in an httpOnly cookie — without this it is never sent
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    })
);

// The body limit is deliberately small. Images never pass through the
// server (the browser uploads straight to Cloudinary), so the largest
// payload is a bulk attendance sheet — well under 100KB.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser());

// NoSQL injection — strips operators like { "$gt": "" }. It belongs at the HTTP layer
// rather than mongoose's sanitizeFilter: that one also breaks the
// legitimate operators we write ourselves ($in, $gt).
app.use(mongoSanitize());

app.use(generalLimiter);

// ---------- DB ----------
// Called on every invocation, but on a warm instance it returns the cached
// promise — no new connection. See config/db.js.
app.use(
    asyncHandler(async (_req, _res, next) => {
        await connectDB();
        next();
    })
);

// ---------- health ----------
// For verifying a deploy. It sits AFTER the DB middleware, so it only
// returns 200 when the database is genuinely reachable.
app.get('/health', (_req, res) => {
    res.status(200).json({
        success: true,
        service: 'Sahara Public School API',
        env: process.env.NODE_ENV || 'development',
        time: new Date().toISOString(),
    });
});

// ---------- routes ----------
app.use('/api/v1', require('./src/routes/v1'));

// ---------- 404 ----------
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ---------- error handler (always last) ----------
app.use(errorHandler);

module.exports = app;
