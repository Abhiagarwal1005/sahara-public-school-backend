process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/sps-test';
process.env.ACCESS_TOKEN_SECRET = 'a'.repeat(48);
process.env.REFRESH_TOKEN_SECRET = 'b'.repeat(48);
process.env.CLOUDINARY_CLOUD_NAME = 'demo';
process.env.CLOUDINARY_API_KEY = '123';
process.env.CLOUDINARY_API_SECRET = 'secret';
process.env.FRONTEND_URL = 'http://localhost:5173';

const { validateEnv } = require('../server/src/config/env');
validateEnv();

const app = require('../server/app');

const routes = [];
const clean = (re) => {
  if (!re) return '';
  let s = re.source;
  if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)$') return '';
  s = s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '');
  return s.replace(/\\\//g, '/');
};
const walk = (stack, prefix = '') => {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase()).join(',');
      routes.push(`${methods.padEnd(11)} ${prefix}${layer.route.path}`.replace(/\/$/, ''));
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + clean(layer.regexp));
    }
  }
};
walk(app._router.stack);
console.log(`APP LOADED OK — ${routes.length} routes\n`);
console.log([...new Set(routes)].sort().join('\n'));
