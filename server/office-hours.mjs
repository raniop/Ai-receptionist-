// Is the Ophir office open right now? Computed here, not by the voice model: it
// got day/time logic wrong in calls (said it was closed, then "transferring").
// Holidays come from the Hebrew calendar via Intl, so nothing needs updating
// each year. Hours: Sunday–Thursday 08:30–17:30; closed Friday, Saturday and on
// holidays; Chol HaMoed until 13:00.

const TZ = "Asia/Jerusalem";
const OPEN = 8 * 60 + 30;
const CLOSE = 17 * 60 + 30;
const CLOSE_CHOL = 13 * 60;

// Israeli yom tov (one day) and Chol HaMoed, by Hebrew date.
const HOLIDAYS = {
  "Tishri 1": "ראש השנה", "Tishri 2": "ראש השנה", "Tishri 10": "יום כיפור",
  "Tishri 15": "סוכות", "Tishri 22": "שמחת תורה",
  "Nisan 15": "פסח", "Nisan 21": "שביעי של פסח", "Sivan 6": "שבועות",
};
const CHOL = {
  "Tishri 16": "חול המועד סוכות", "Tishri 17": "חול המועד סוכות", "Tishri 18": "חול המועד סוכות",
  "Tishri 19": "חול המועד סוכות", "Tishri 20": "חול המועד סוכות", "Tishri 21": "הושענא רבה",
  "Nisan 16": "חול המועד פסח", "Nisan 17": "חול המועד פסח", "Nisan 18": "חול המועד פסח",
  "Nisan 19": "חול המועד פסח", "Nisan 20": "חול המועד פסח",
};
const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

const hebFmt = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", timeZone: TZ });
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function dayInfo(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const h = Object.fromEntries(hebFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const key = `${h.month} ${h.day}`;
  const weekday = WD[p.weekday];
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  if (weekday === 5 || weekday === 6) return { weekday, minutes, closedAllDay: true, why: weekday === 5 ? "יום שישי" : "שבת" };
  if (HOLIDAYS[key]) return { weekday, minutes, closedAllDay: true, why: HOLIDAYS[key] };
  if (CHOL[key]) return { weekday, minutes, close: CLOSE_CHOL, why: CHOL[key] };
  return { weekday, minutes, close: CLOSE };
}

const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** Office status at `now`, with a Hebrew phrase for when it next opens. */
export function officeStatus(now = new Date()) {
  const d = dayInfo(now);
  const open = !d.closedAllDay && d.minutes >= OPEN && d.minutes < d.close;
  let reason;
  if (open) reason = d.why ? `פתוח היום עד ${hhmm(d.close)} (${d.why})` : `פתוח עד ${hhmm(d.close)}`;
  else if (d.closedAllDay) reason = `סגור היום (${d.why})`;
  else if (d.minutes < OPEN) reason = "סגור, נפתח היום ב-8:30";
  else reason = d.why ? `סגור, היום פתוח רק עד ${hhmm(d.close)} (${d.why})` : "סגור, שעות הפעילות הסתיימו";

  // Next time the office opens (for "we'll get back to you on ...").
  let next = null;
  if (!open) {
    if (!d.closedAllDay && d.minutes < OPEN) next = "היום ב-8:30";
    else {
      for (let i = 1; i <= 14; i++) {
        const day = new Date(now.getTime() + i * 864e5);
        const di = dayInfo(day);
        if (!di.closedAllDay) { next = `${i === 1 ? "מחר, " : ""}ביום ${HE_DAYS[di.weekday]} ב-8:30`; break; }
      }
    }
  }
  return { office_open: open, office_status: reason, ...(next ? { next_business_day: next } : {}) };
}
