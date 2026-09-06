// ---------------------------------------------------------------------------
// The whole app is India-specific, but the server runs on UTC (Vercel always
// does). If an attendance date or a transaction's month were derived in UTC,
// every entry made between 00:00 and 05:30 IST would land in the PREVIOUS
// day — and on the 1st of a month, in the previous MONTH. A month's fee
// collection figure would be quietly wrong.
//
// So every date boundary is computed here, and nowhere else.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 00:00 of that IST day, as a UTC instant. Attendance rows carry a unique
// index on this, so two people marking the same day at different times still
// hit the same row.
const startOfDayIST = (input = new Date()) => {
    const t = new Date(input).getTime() + IST_OFFSET_MS;
    return new Date(Math.floor(t / DAY_MS) * DAY_MS - IST_OFFSET_MS);
};

const endOfDayIST = (input = new Date()) => new Date(startOfDayIST(input).getTime() + DAY_MS - 1);

// "2026-08" — rollups, fee demands and salary slips all key off this.
const monthKeyIST = (input = new Date()) => {
    const d = new Date(new Date(input).getTime() + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// The day of the month in IST.
//
// An attendance date is stored as IST midnight held as a UTC instant, so
// 1 Aug 2026 IST is 2026-07-31T18:30Z — and getUTCDate() on that answers 31,
// the previous month's last day. Anything that keys off the day number (the
// monthly grid's columns) has to come through here, or every mark lands one
// column to the left and the 1st wraps around to the end of the row.
const dayOfMonthIST = (input = new Date()) => {
    const d = new Date(new Date(input).getTime() + IST_OFFSET_MS);
    return d.getUTCDate();
};

// A month key to the UTC instants bounding its IST range, for date-range queries.
const monthRangeIST = (monthKey) => {
    const [year, month] = monthKey.split('-').map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
    const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1) - IST_OFFSET_MS);
    return { start, end };
};

const addDays = (input, days) => new Date(new Date(input).getTime() + days * DAY_MS);

// Whole days between two IST dates. Vendor ageing (0-30 / 31-60 / 60+) uses this.
const daysBetweenIST = (from, to = new Date()) =>
    Math.floor((startOfDayIST(to).getTime() - startOfDayIST(from).getTime()) / DAY_MS);

// Sunday is the weekly off. The whole payroll rule depends on spotting it
// correctly, and "correctly" means in IST — a Sunday 00:30 IST is still
// Saturday in UTC, so getUTCDay() on the raw instant would answer wrongly.
const isSundayIST = (input = new Date()) => {
    const d = new Date(new Date(input).getTime() + IST_OFFSET_MS);
    return d.getUTCDay() === 0;
};

// Calendar days in "2026-08".
const daysInMonthIST = (monthKey) => {
    const [year, month] = monthKey.split('-').map(Number);
    return new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1) - DAY_MS).getUTCDate();
};

// How many Sundays "2026-08" holds — 4 or 5, and payroll must not assume 4.
const sundaysInMonthIST = (monthKey) => {
    const [year, month] = monthKey.split('-').map(Number);
    let count = 0;
    for (let day = 1; day <= daysInMonthIST(monthKey); day += 1) {
        if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) count += 1;
    }
    return count;
};

// Whether "2026-08" is valid — checked by both validators and services.
const isValidMonthKey = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

module.exports = {
    startOfDayIST,
    endOfDayIST,
    monthKeyIST,
    dayOfMonthIST,
    monthRangeIST,
    addDays,
    daysBetweenIST,
    isValidMonthKey,
    isSundayIST,
    daysInMonthIST,
    sundaysInMonthIST,
    IST_OFFSET_MS,
};
