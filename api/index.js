// ---------------------------------------------------------------------------
// The Vercel entry point.
//
// The ENTIRE app is ONE function, not a file per route. The instinct on
// Vercel is the opposite, but one function means one cold start, one
// connection pool, and one warm instance serving every endpoint. Separate
// functions would mean a cold start and a pool per endpoint — which eats
// M0's 500-connection limit very quickly.
//
// vercel.json rewrites every path to here.
// ---------------------------------------------------------------------------

require('dotenv').config();

const { validateEnv } = require('../server/src/config/env');

// Fail here on bad config — not on the first user's login
validateEnv();

module.exports = require('../server/app');

//test