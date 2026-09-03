// Local development server. Vercel does not use this — there api/index.js
// is the entry point (see vercel.json).

require('dotenv').config();

const { validateEnv, config } = require('./src/config/env');
validateEnv();

const connectDB = require('./src/config/db');
const app = require('./app');

const start = async () => {
    await connectDB();

    const server = app.listen(config.port, () => {
        console.log(`SPS API running at http://localhost:${config.port} [${process.env.NODE_ENV || 'development'}]`);
    });

    const shutdown = (signal) => {
        console.log(`${signal} received — shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
};

start().catch((err) => {
    console.error('Server failed to start:', err.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});
