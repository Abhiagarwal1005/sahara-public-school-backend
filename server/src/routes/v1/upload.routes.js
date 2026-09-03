const router = require('express').Router();

const c = require('../../controllers/misc.controller');
const { uploadLimiter } = require('../../middlewares/rateLimiter');

// ---------------------------------------------------------------------------
// The server only SIGNS — bytes never pass through it.
//
// The browser takes the signature and uploads straight to Cloudinary. That
// bypasses Vercel's 4.5MB body limit, avoids paying for bandwidth twice,
// and keeps the API secret away from the client.
// ---------------------------------------------------------------------------
router.get('/signature', uploadLimiter, c.uploadSignature);

// For removing an orphaned image when a form is cancelled
router.post('/destroy', uploadLimiter, c.destroyUpload);

module.exports = router;
