const router = require('express').Router();

const c = require('../../controllers/academic.controller');
const validate = require('../../middlewares/validate');
const { can } = require('../../middlewares/can');
const { createSessionSchema, updateSessionSchema, idParamSchema } = require('../../validators/academic.validator');

// Every module reads the active session, so this is open to all
router.get('/active', c.getActiveSession);

router.get('/', can('session.manage'), c.listSessions);
router.post('/', can('session.manage'), validate(createSessionSchema), c.createSession);
router.patch('/:id', can('session.manage'), validate(idParamSchema, 'params'), validate(updateSessionSchema), c.updateSession);
router.post('/:id/activate', can('session.manage'), validate(idParamSchema, 'params'), c.activateSession);

module.exports = router;
