const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const sessionService = require('../services/session.service');
const classService = require('../services/class.service');
const studentService = require('../services/student.service');
const audit = require('../services/audit.service');

// ---- academic session ----

const listSessions = asyncHandler(async (_req, res) => {
    const data = await sessionService.list();
    return res.status(200).json(new ApiResponse(200, data, 'Sessions'));
});

const getActiveSession = asyncHandler(async (_req, res) => {
    const data = await sessionService.getActiveSession();
    return res.status(200).json(new ApiResponse(200, data, 'Active session'));
});

const createSession = asyncHandler(async (req, res) => {
    const data = await sessionService.create(req.body);
    return res.status(201).json(new ApiResponse(201, data, 'Session created'));
});

const activateSession = asyncHandler(async (req, res) => {
    const data = await sessionService.activate(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'session.activate',
        entity: 'AcademicSession',
        entityId: data._id,
        summary: `${data.name} activated`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Session activated'));
});

const updateSession = asyncHandler(async (req, res) => {
    const data = await sessionService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Session updated'));
});

// ---- classes ----

const listClasses = asyncHandler(async (req, res) => {
    const data = await classService.list(req.query);
    // Classes change rarely — let the browser cache briefly and serve a stale
    // copy while it refreshes in the background. Every screen's class
    // dropdown comes from this one call.
    res.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
    return res.status(200).json(new ApiResponse(200, data, 'Classes'));
});

const createClass = asyncHandler(async (req, res) => {
    const data = await classService.create(req.body);
    return res.status(201).json(new ApiResponse(201, data, 'Class created'));
});

const updateClass = asyncHandler(async (req, res) => {
    const data = await classService.update(req.params.id, req.body);
    return res.status(200).json(new ApiResponse(200, data, 'Class updated'));
});

const deactivateClass = asyncHandler(async (req, res) => {
    const data = await classService.deactivate(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Class deactivated'));
});

// ---- students ----

const listStudents = asyncHandler(async (req, res) => {
    const data = await studentService.list(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Students'));
});

const getStudent = asyncHandler(async (req, res) => {
    const data = await studentService.getById(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student'));
});

const getStudentLedger = asyncHandler(async (req, res) => {
    const data = await studentService.getLedger(req.params.id);
    return res.status(200).json(new ApiResponse(200, data, 'Student ledger'));
});

const createStudent = asyncHandler(async (req, res) => {
    const data = await studentService.create(req.body, req.userId);
    return res.status(201).json(new ApiResponse(201, data, 'Student added'));
});

const updateStudent = asyncHandler(async (req, res) => {
    const data = await studentService.update(req.params.id, req.body, req.userId);
    return res.status(200).json(new ApiResponse(200, data, 'Student updated'));
});

const markStudentLeft = asyncHandler(async (req, res) => {
    const data = await studentService.markLeft(req.params.id);

    audit.log({
        ...audit.fromRequest(req),
        action: 'student.left',
        entity: 'Student',
        entityId: req.params.id,
        summary: `School chhoda - outstanding ₹${data.outstandingCarried}`,
    });

    return res.status(200).json(new ApiResponse(200, data, 'Student marked as Left'));
});

const defaulters = asyncHandler(async (req, res) => {
    const data = await studentService.defaulters(req.query);
    return res.status(200).json(new ApiResponse(200, data, 'Defaulters'));
});

module.exports = {
    listSessions,
    getActiveSession,
    createSession,
    activateSession,
    updateSession,
    listClasses,
    createClass,
    updateClass,
    deactivateClass,
    listStudents,
    getStudent,
    getStudentLedger,
    createStudent,
    updateStudent,
    markStudentLeft,
    defaulters,
};
