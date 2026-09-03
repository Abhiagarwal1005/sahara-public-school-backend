const router = require('express').Router();

const c = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const { adminOnly } = require('../../middlewares/can');
const { createUserSchema, updateUserSchema, idParamSchema } = require('../../validators/auth.validator');

// ---------------------------------------------------------------------------
// User and permission management sit outside the permission SYSTEM —
// adminOnly, not a grantable key. If 'user.manage' were a normal permission
// the Principal could grant it to themselves, and the system would be pointless.
// ---------------------------------------------------------------------------
router.use(adminOnly);

router.get('/', c.listUsers);
router.post('/', validate(createUserSchema), c.createUser);
router.patch('/:id', validate(idParamSchema, 'params'), validate(updateUserSchema), c.updateUser);
router.post('/:id/reset-password', validate(idParamSchema, 'params'), c.resetUserPassword);

module.exports = router;
