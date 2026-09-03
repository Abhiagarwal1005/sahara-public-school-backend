const router = require('express').Router();

const c = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const { adminOnly } = require('../../middlewares/can');
const { updatePermissionsSchema } = require('../../validators/auth.validator');

// This is the screen where the Admin grants or revokes anything for any
// role — with no code change and no deploy.
router.get('/', adminOnly, c.getPermissions);
router.patch('/:role', adminOnly, validate(updatePermissionsSchema), c.updatePermissions);

module.exports = router;
