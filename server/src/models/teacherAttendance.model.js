const mongoose = require('mongoose');

// One teacher, one day, one row. The whole staff saves in one bulkWrite —
// one round trip for 40 teachers instead of 40.
const teacherAttendanceSchema = new mongoose.Schema(
    {
        session: { type: String, required: true },
        teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
        teacherName: { type: String, required: true }, // denormalised

        // Normalised to IST midnight (istDate.startOfDayIST). Without it, two people
        // marking the same day at different times would create two rows — and
        // the unique index would be useless.
        date: { type: Date, required: true },
        month: { type: String, required: true }, // "2026-08" — used for salary counting

        status: {
            type: String,
            enum: ['Present', 'Absent', 'HalfDay', 'Leave', 'Holiday'],
            required: true,
        },
        note: { type: String, default: '' },
        markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        markedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Upsert on re-mark — a second row for one day can never appear
teacherAttendanceSchema.index({ teacher: 1, date: 1 }, { unique: true });
// "Show today's sheet"
teacherAttendanceSchema.index({ session: 1, date: 1 });
// Salary calculation — days are counted straight from the index
teacherAttendanceSchema.index({ teacher: 1, month: 1, status: 1 });
// Monthly grid — a whole month in one query
teacherAttendanceSchema.index({ session: 1, month: 1, teacher: 1 });

module.exports =
    mongoose.models.TeacherAttendance ||
    mongoose.model('TeacherAttendance', teacherAttendanceSchema);
