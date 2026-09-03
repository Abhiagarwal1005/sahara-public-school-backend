const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const permissionService = require('../services/permission.service');

// ---------------------------------------------------------------------------
// All authorisation in the app goes through here.
//
// A route declares the CAPABILITY it needs, not the ROLE that is
// allowed:
//
//   router.post('/', isAuth, can('student.create'), validate(...), controller)
//
// This is what lets the Admin grant or revoke anything for any role from
// the Settings screen — no code change, no deploy. With roleGuard(['Admin'])
// here, every permission change would be a code change.
//
// The frontend hides buttons too, but that is only UX. This is the real
// gate — a stale browser tab or a hand-made request stops right here.
// ---------------------------------------------------------------------------

const can = (permissionKey) =>
    asyncHandler(async (req, _res, next) => {
        // Admin is outside every check. It also means an Admin can never lock
        // themselves out of their own permissions.
        if (req.role === 'Admin') return next();

        const grants = await permissionService.getGrants(req.role);

        if (!grants.has(permissionKey)) {
            throw new ApiError(
                403,
                'You do not have permission to do this — ask an Admin to grant it'
            ).withCode('PERMISSION_DENIED');
        }

        next();
    });

// Some routes accept any one of several capabilities (a dashboard that
// opens on either fee or expense access, for instance).
const canAny = (...keys) =>
    asyncHandler(async (req, _res, next) => {
        if (req.role === 'Admin') return next();

        const grants = await permissionService.getGrants(req.role);

        if (!keys.some((k) => grants.has(k))) {
            throw new ApiError(403, 'You do not have permission to do this').withCode(
                'PERMISSION_DENIED'
            );
        }
        next();
    });

// Admin only — for user and permission management. This deliberately sits
// OUTSIDE the permission system: if 'user.manage' were a normal grantable
// key, the Principal could grant it to themselves.
const adminOnly = (req, _res, next) => {
    if (req.role !== 'Admin') {
        throw new ApiError(403, 'Only an Admin can do this').withCode('ADMIN_ONLY');
    }
    next();
};

module.exports = { can, canAny, adminOnly };
