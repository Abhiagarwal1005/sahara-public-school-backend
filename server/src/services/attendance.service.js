const TeacherAttendance = require('../models/teacherAttendance.model');
const ClassAttendance = require('../models/classAttendance.model');
const Teacher = require('../models/teacher.model');
const SchoolClass = require('../models/schoolClass.model');
const SalarySlip = require('../models/salarySlip.model');
const ApiError = require('../utils/ApiError');
const sessionService = require('./session.service');
const {
    startOfDayIST,
    monthKeyIST,
    monthRangeIST,
    isValidMonthKey,
    isSundayIST,
    daysInMonthIST,
    dayOfMonthIST,
} = require('../utils/istDate');

// ---------------------------------------------------------------------------
// TEACHER ATTENDANCE
// ---------------------------------------------------------------------------

// One day's sheet: all active staff, with anything already marked pre-filled.
// Two queries, both indexed.
const getTeacherSheet = async (dateInput) => {
    const session = await sessionService.getActiveSessionName();
    const date = startOfDayIST(dateInput || new Date());

    const [teachers, marks] = await Promise.all([
        Teacher.find({ status: 'Active' })
            .select('name designation employeeCode')
            .sort({ nameLower: 1 })
            .lean(),
        TeacherAttendance.find({ session, date }).select('teacher status note').lean(),
    ]);

    const markMap = new Map(marks.map((m) => [m.teacher.toString(), m]));

    // Sunday is the weekly off, so the sheet opens on Holiday rather than
    // Present. Without this, opening a Sunday and pressing save would mark
    // the whole staff present on their day off — which adds a working day to
    // everyone's payroll and cuts the per-day rate for that month.
    const sunday = isSundayIST(date);

    const rows = teachers.map((t) => {
        const mark = markMap.get(t._id.toString());
        return {
            teacher: t._id,
            name: t.name,
            employeeCode: t.employeeCode,
            designation: t.designation,
            // Defaults to Present — in a school where most people turn up, the work
            // is marking the exceptions, not marking everything.
            status: mark?.status || (sunday ? 'Holiday' : 'Present'),
            note: mark?.note || '',
            marked: Boolean(mark),
        };
    });

    const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});

    return { date, session, rows, counts, isSunday: sunday, alreadyMarked: marks.length > 0 };
};

// ---------------------------------------------------------------------------
// The whole sheet in ONE bulkWrite. 40 round trips for 40 teachers would
// mean 40x the network latency — from Vercel to Mumbai that becomes
// seconds. One bulkWrite makes it a single round trip.
//
// upsert so re-marking updates the same row instead of creating a new one
// (the unique index on { teacher, date } enforces the same thing).
// ---------------------------------------------------------------------------
const markTeachers = async ({ date: dateInput, entries }, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const date = startOfDayIST(dateInput || new Date());
    const month = monthKeyIST(date);

    if (!entries?.length) throw new ApiError(400, 'No entries found');

    // Changing attendance for a month whose slip is already paid does not
    // change the slip (it is a snapshot) — but the user needs to know that,
    // otherwise they will assume the salary corrects itself.
    const paidSlips = await SalarySlip.countDocuments({ month, status: 'Paid' });

    const teachers = await Teacher.find({ _id: { $in: entries.map((e) => e.teacher) } })
        .select('name')
        .lean();
    const nameMap = new Map(teachers.map((t) => [t._id.toString(), t.name]));

    const ops = entries.map((e) => {
        const name = nameMap.get(e.teacher.toString());
        if (!name) throw new ApiError(404, 'No teachers found');

        return {
            updateOne: {
                filter: { teacher: e.teacher, date },
                update: {
                    $set: {
                        session,
                        teacherName: name,
                        month,
                        status: e.status,
                        note: e.note || '',
                        markedBy: actorId,
                        markedAt: new Date(),
                    },
                },
                upsert: true,
            },
        };
    });

    const result = await TeacherAttendance.bulkWrite(ops, { ordered: false });

    return {
        date,
        saved: entries.length,
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        ...(paidSlips > 0 && {
            warning: `${paidSlips} salary slips for ${month} are already paid — this change will not affect them`,
        }),
    };
};

// Monthly grid — teachers down the rows, dates across the columns
const teacherMonthlyGrid = async (month) => {
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');
    const session = await sessionService.getActiveSessionName();

    const [teachers, marks] = await Promise.all([
        Teacher.find({ status: 'Active' }).select('name employeeCode').sort({ nameLower: 1 }).lean(),
        TeacherAttendance.find({ session, month }).select('teacher date status').lean(),
    ]);

    const byTeacher = new Map();
    for (const m of marks) {
        const key = m.teacher.toString();
        if (!byTeacher.has(key)) byTeacher.set(key, {});
        // Day number in IST — NOT getUTCDate() on the raw instant, which
        // answers the previous day for every IST date (see istDate.js).
        byTeacher.get(key)[dayOfMonthIST(m.date)] = m.status;
    }

    const rows = teachers.map((t) => {
        const days = byTeacher.get(t._id.toString()) || {};
        const counts = Object.values(days).reduce(
            (acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }),
            {}
        );
        return {
            teacher: t._id,
            name: t.name,
            employeeCode: t.employeeCode,
            days,
            present: counts.Present || 0,
            absent: counts.Absent || 0,
            halfDay: counts.HalfDay || 0,
            leave: counts.Leave || 0,
            // Shown on the grid so the office can see a late habit building up
            // before it turns into a deduction on the slip.
            late: counts.Late || 0,
        };
    });

    // The grid greys out Sundays rather than leaving them looking unmarked.
    // Sent as day numbers so the frontend never has to do date maths of its
    // own — and can never disagree with the payroll about which day is which.
    const [year, monthNo] = month.split('-').map(Number);
    const totalDays = daysInMonthIST(month);
    const sundays = [];
    for (let day = 1; day <= totalDays; day += 1) {
        if (new Date(Date.UTC(year, monthNo - 1, day)).getUTCDay() === 0) sundays.push(day);
    }

    return { month, rows, totalDays, sundays };
};

// ---------------------------------------------------------------------------
// CLASS ATTENDANCE — totals only, not per student (the client's
// requirement, and the right call for M0's storage — see classAttendance.model.js)
// ---------------------------------------------------------------------------

const getClassSheet = async (dateInput) => {
    const session = await sessionService.getActiveSessionName();
    const date = startOfDayIST(dateInput || new Date());

    const [classes, marks] = await Promise.all([
        SchoolClass.find({ session, isActive: true })
            .select('name section studentCount order')
            .sort({ order: 1 })
            .lean(),
        ClassAttendance.find({ session, date }).select('class present absent totalStudents').lean(),
    ]);

    const markMap = new Map(marks.map((m) => [m.class.toString(), m]));

    const rows = classes.map((c) => {
        const mark = markMap.get(c._id.toString());
        return {
            class: c._id,
            className: `${c.name} – ${c.section}`,
            // Today's roll strength — opening the report three months later still
            // shows that day's snapshot, because it was saved into the row.
            totalStudents: mark?.totalStudents ?? c.studentCount,
            present: mark?.present ?? null,
            absent: mark?.absent ?? null,
            marked: Boolean(mark),
        };
    });

    const totals = rows.reduce(
        (acc, r) => ({
            roll: acc.roll + (r.totalStudents || 0),
            present: acc.present + (r.present || 0),
        }),
        { roll: 0, present: 0 }
    );

    return {
        date,
        rows,
        totals: {
            ...totals,
            absent: totals.roll - totals.present,
            percent: totals.roll ? Math.round((totals.present / totals.roll) * 1000) / 10 : 0,
        },
    };
};

const markClasses = async ({ date: dateInput, entries }, actorId) => {
    const session = await sessionService.getActiveSessionName();
    const date = startOfDayIST(dateInput || new Date());
    const month = monthKeyIST(date);

    if (!entries?.length) throw new ApiError(400, 'No entries found');

    const classes = await SchoolClass.find({ _id: { $in: entries.map((e) => e.class) }, session })
        .select('name section studentCount')
        .lean();
    const classMap = new Map(classes.map((c) => [c._id.toString(), c]));

    const ops = entries.map((e) => {
        const cls = classMap.get(e.class.toString());
        if (!cls) throw new ApiError(404, 'Class not found');

        const total = e.totalStudents ?? cls.studentCount;

        if (e.present > total) {
            throw new ApiError(
                400,
                `${cls.name} – ${cls.section}: present (${e.present}) cannot exceed the roll strength (${total})`
            );
        }

        return {
            updateOne: {
                filter: { class: e.class, date },
                update: {
                    $set: {
                        session,
                        className: `${cls.name} – ${cls.section}`,
                        month,
                        totalStudents: total,
                        present: e.present,
                        // Always derived — the two numbers can never contradict each
                        // other.
                        absent: total - e.present,
                        markedBy: actorId,
                        markedAt: new Date(),
                    },
                },
                upsert: true,
            },
        };
    });

    const result = await ClassAttendance.bulkWrite(ops, { ordered: false });

    return { date, saved: entries.length, inserted: result.upsertedCount, updated: result.modifiedCount };
};

// Monthly percentage per class — the figure asked for in inspections
const classMonthly = async (month) => {
    if (!isValidMonthKey(month)) throw new ApiError(400, 'Month must be in YYYY-MM format');
    const session = await sessionService.getActiveSessionName();

    const rows = await ClassAttendance.aggregate([
        { $match: { session, month } },
        {
            $group: {
                _id: '$class',
                className: { $first: '$className' },
                daysMarked: { $sum: 1 },
                totalPresent: { $sum: '$present' },
                totalRoll: { $sum: '$totalStudents' },
            },
        },
        { $sort: { className: 1 } },
    ]);

    const classes = rows.map((r) => ({
        classId: r._id,
        className: r.className,
        daysMarked: r.daysMarked,
        avgPresent: Math.round((r.totalPresent / r.daysMarked) * 10) / 10,
        avgAbsent: Math.round(((r.totalRoll - r.totalPresent) / r.daysMarked) * 10) / 10,
        percent: r.totalRoll ? Math.round((r.totalPresent / r.totalRoll) * 1000) / 10 : 0,
    }));

    const school = rows.reduce(
        (acc, r) => ({ present: acc.present + r.totalPresent, roll: acc.roll + r.totalRoll }),
        { present: 0, roll: 0 }
    );

    return {
        month,
        classes,
        school: {
            percent: school.roll ? Math.round((school.present / school.roll) * 1000) / 10 : 0,
        },
    };
};

module.exports = {
    getTeacherSheet,
    markTeachers,
    teacherMonthlyGrid,
    getClassSheet,
    markClasses,
    classMonthly,
};
