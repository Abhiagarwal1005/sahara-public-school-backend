const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const permissionService = require('../services/permission.service');
const audit = require('../services/audit.service');

const meta = (req) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

// The refresh token goes in a cookie (JS cannot touch it), the access
// token in the response body (the client keeps it in memory). That split
// reduces both XSS and CSRF risk.
const sendAuth = (res, result, status = 200, message = 'Success') => {
    const { refreshToken, ...body } = result;
    res.cookie('sps_rt', refreshToken, authService.refreshCookieOptions());
    return res.status(status).json(new ApiResponse(status, body, message));
};

const login = asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, meta(req));
    return sendAuth(res, result, 200, 'Signed in');
});

const refresh = asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.cookies?.sps_rt, meta(req));
    return sendAuth(res, result, 200, 'Session refreshed');
});

const logout = asyncHandler(async (req, res) => {
    await authService.logout(req.cookies?.sps_rt);
    // It must be cleared with the same options — on a mismatch the browser
    // keeps the cookie and logout quietly stops working.
    res.clearCookie('sps_rt', authService.clearCookieOptions());
    return res.status(200).json(new ApiResponse(200, null, 'Signed out'));
});

const changePassword = asyncHandler(async (req, res) => {
    const result = await authService.changePassword(req.userId, req.body);
    res.clearCookie('sps_rt', authService.clearCookieOptions());
    return res
        .status(200)
        .json(new ApiResponse(200, result, 'Password changed — please sign in again'));
});

const me = asyncHandler(async (req, res) => {
    const result = await authService.getMe(req.userId);
    return res.status(200).json(new ApiResponse(200, result, 'Profile'));
});

// ---- users (Admin only) ----

const listUsers = asyncHandler(async (_req, res) => {
    const users = await userService.list();
    return res.status(200).json(new ApiResponse(200, users, 'Users'));
});

const createUser = asyncHandler(async (req, res) => {
    const result = await userService.create(req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'user.create',
        entity: 'User',
        entityId: result.user.id,
        summary: `${result.user.name} (${result.user.role}) banaya`,
    });

    // tempPassword is shown only here — the Admin should hand it over now
    return res.status(201).json(new ApiResponse(201, result, 'User created'));
});

const updateUser = asyncHandler(async (req, res) => {
    const user = await userService.update(req.params.id, req.body, req.userId);

    audit.log({
        ...audit.fromRequest(req),
        action: 'user.update',
        entity: 'User',
        entityId: user._id,
        summary: `${user.name} updated`,
        after: req.body,
    });

    return res.status(200).json(new ApiResponse(200, user, 'User updated'));
});

const resetUserPassword = asyncHandler(async (req, res) => {
    const result = await userService.resetPassword(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'user.resetPassword',
        entity: 'User',
        entityId: req.params.id,
        summary: 'Password reset',
    });

    return res.status(200).json(new ApiResponse(200, result, 'New temporary password generated'));
});

// ---- permissions (Admin only) ----

const getPermissions = asyncHandler(async (_req, res) => {
    const data = await permissionService.getCatalogue();
    return res.status(200).json(new ApiResponse(200, data, 'Permissions'));
});

const updatePermissions = asyncHandler(async (req, res) => {
    const before = await permissionService.getGrants(req.params.role);
    const updated = await permissionService.updateGrants(
        req.params.role,
        req.body.permissions,
        req.userId
    );

    audit.log({
        ...audit.fromRequest(req),
        action: 'permission.update',
        entity: 'RolePermission',
        entityId: updated._id,
        summary: `permissions updated for ${req.params.role}`,
        before: [...before],
        after: updated.permissions,
    });

    return res.status(200).json(new ApiResponse(200, updated, 'Permissions update ho gayin'));
});

module.exports = {
    login,
    refresh,
    logout,
    changePassword,
    me,
    listUsers,
    createUser,
    updateUser,
    resetUserPassword,
    getPermissions,
    updatePermissions,
};
