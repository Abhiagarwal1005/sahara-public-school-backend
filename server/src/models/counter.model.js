const mongoose = require('mongoose');

// Atomic sequence generator - admission numbers, receipt numbers, bill
// numbers, employee codes.
//
// findOneAndUpdate + $inc is atomic on a single document, so two people
// collecting fees in the same second cannot get the same receipt number.
// This counter approach matters because "count and add 1" — which looks
// simpler — hands the same number to two concurrent requests every time.
//
// The key is per session: `2026-27:admissionNo`. Numbering restarts at 1
// each session, which matches how a school actually works.
const counterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

const getNextSequence = async (key, session = null, mongoSession = null) => {
    const counterId = session ? `${session}:${key}` : key;

    const counter = await Counter.findByIdAndUpdate(
        counterId,
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session: mongoSession }
    );

    return counter.seq;
};

// Readable codes like ADM0001, RCP0001
const formatCode = (prefix, seq, width = 4) => `${prefix}${String(seq).padStart(width, '0')}`;

module.exports = { Counter, getNextSequence, formatCode };
