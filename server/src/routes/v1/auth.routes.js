const router = require('express').Router();

const c = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const { isAuth } = require('../../middlewares/isAuth');
const { authLimiter } = require('../../middlewares/rateLimiter');
const { loginSchema, changePasswordSchema } = require('../../validators/auth.validator');

// authLimiter on these three only — the general limiter covers the rest
router.post('/login', authLimiter, validate(loginSchema), c.login);
router.post('/refresh', authLimiter, c.refresh);
router.post('/logout', c.logout);

// requirePasswordChanged is NOT applied to password change — otherwise the user
// who needs to change their password could not do it.
router.post('/change-password', isAuth, validate(changePasswordSchema), c.changePassword);
router.get('/me', isAuth, c.me);

module.exports = router;
