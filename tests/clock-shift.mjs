// Test tool: run the whole suite as if it were another time or date.
//   NS_TEST_CLOCK_OFFSET_MIN=90 node --import ./tests/clock-shift.mjs --test tests/*.test.js
// Every `new Date()` and `Date.now()` (tests and server alike) moves by the offset, so
// midnight, weekend, month-end and year-end behaviour can be checked on any day.
const offset = (Number(process.env.NS_TEST_CLOCK_OFFSET_MIN) || 0) * 60_000;
if (offset) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = ShiftedDate;
}
