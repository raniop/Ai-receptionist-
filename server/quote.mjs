// Harel "Darkon First Class" travel-insurance price calculator — 2026 tariff
// (as published Feb 2026; source: the price list the office uploaded, from
// shukabit.co.il/harel-first-class/prices). Dalit collects the trip details and
// the server does the arithmetic: the voice model is not reliable with tables.
// All amounts are USD. Update the tables here when Harel publishes a new tariff.

import crypto from "node:crypto";

const r2 = (n) => Math.round(n * 100) / 100;

// Base policy, per day. `short` = trips up to 14 days (USA: 20); `long` = the rate
// "from day 15" (USA: "from day 21"), applied to the days after the short period.
// Both this split and counting departure + return days were confirmed by the office.
// Both include search & rescue at $0.20/day, which the caller may drop.
const BASE = {
  other: {
    shortDays: 14,
    bands: [
      { max: 50, short: 2.5, long: 2.5, maxDays: 365 },
      { max: 60, short: 2.5, long: 2.8, maxDays: 180 },
      { max: 65, short: 3.8, long: 4.0, maxDays: 120 },
      { max: 70, short: 4.8, long: 5.1, maxDays: 120 },
      { max: 75, short: 6.55, long: 6.55, maxDays: 120 },
      { max: 80, short: 11.6, long: 11.6, maxDays: 60 },
      { max: 85, short: 11.6, long: 11.6, maxDays: 30 },
      { max: 95, short: 17.5, long: 17.5, maxDays: 30 },
    ],
  },
  usa: {
    shortDays: 20,
    bands: [
      { max: 40, short: 3.5, long: 3.7, maxDays: 365 },
      { max: 50, short: 3.5, long: 3.7, maxDays: 180 },
      { max: 60, short: 3.5, long: 3.7, maxDays: 180 },
      { max: 65, short: 6.8, long: 6.8, maxDays: 120 },
      { max: 70, short: 9.7, long: 9.7, maxDays: 120 },
      { max: 75, short: 11.6, long: 11.6, maxDays: 120 },
      { max: 80, short: 21.2, long: 21.2, maxDays: 60 },
      { max: 85, short: 21.2, long: 21.2, maxDays: 30 },
      { max: 95, short: 32.5, long: 32.5, maxDays: 30 },
    ],
  },
};
const SEARCH_RESCUE_PER_DAY = 0.2;

const byAge = (bands, age) => bands.find((b) => age <= b.max) ?? null;

const CANCELLATION = [ // per day: [cover up to $5,000, cover up to $10,000]
  { max: 17, c5: 0.65, c10: 0.9 }, { max: 40, c5: 0.7, c10: 1.0 }, { max: 50, c5: 1.0, c10: 1.7 },
  { max: 60, c5: 1.0, c10: 2.6 }, { max: 75, c5: 1.5, c10: 3.8 }, { max: 85, c5: 2.8, c10: 5.5 },
  { max: 95, c5: 4.2, c10: 8.0 },
];
const PRE_EXISTING = [ // worsening of a pre-existing condition — subject to medical underwriting
  { max: 17, rate: 3.35 }, { max: 60, rate: 4.05 }, { max: 65, rate: 6.25 }, { max: 70, rate: 6.5 },
  { max: 75, rate: 9.0 }, { max: 85, rate: 15.0 }, { max: 95, rate: 22.0 },
];
const PERSONAL_ACCIDENT = [ // + extreme-sports add-on when extreme sports is also taken
  { max: 17, rate: 0.25, extreme: 0.1 }, { max: 40, rate: 0.4, extreme: 0.15 }, { max: 50, rate: 0.7, extreme: 0.25 },
  { max: 60, rate: 0.96, extreme: 0.35 }, { max: 70, rate: 1.08, extreme: 0.4 },
];
const BICYCLE = { 2500: 1.33, 4500: 2.46, 6000: 3.3 }; // per day by cover, up to 90 days

const EXTENSION_NAMES = {
  baggage: "כבודה",
  cancellation_5000: "ביטול/קיצור נסיעה עד $5,000",
  cancellation_10000: "ביטול/קיצור נסיעה עד $10,000",
  extreme_sports: "ספורט אתגרי",
  winter_sports: "ספורט חורף",
  professional_sports: "ספורט מקצועי",
  laptop: "מחשב נייד/טאבלט",
  phone: "טלפון נייד",
  rental_car: "רכב/קרוואן שכור (ביטול השתתפות עצמית)",
  rental_car_6000: "רכב/קרוואן שכור עד $6,000",
  bicycle_2500: "אופניים עד $2,500",
  bicycle_4500: "אופניים עד $4,500",
  bicycle_6000: "אופניים עד $6,000",
  pregnancy: "היריון עד שבוע 32",
  pre_existing: "החמרה של מצב רפואי קודם",
  personal_accident: "תאונות אישיות",
};

/** Per-day price of one extension for one traveler, or { error }. */
function extensionDaily(ext, age, dest, all) {
  switch (ext) {
    case "baggage": return { rate: 0.39 };
    case "cancellation_5000": case "cancellation_10000": {
      const b = byAge(CANCELLATION, age);
      return b ? { rate: ext.endsWith("5000") ? b.c5 : b.c10 } : { error: "not available at this age" };
    }
    case "extreme_sports":
      return age <= 75 ? { rate: 0.5 } : age <= 85 ? { rate: 2.0 } : { error: "available up to age 85" };
    case "winter_sports":
      return age <= 75 ? { rate: 9.5 } : age <= 80 ? { rate: 13.5 } : { error: "available up to age 80" };
    case "professional_sports":
      return age <= 75 ? { rate: 2.5, capTrip: 25 } : { error: "available up to age 75" };
    case "laptop": return { rate: 2.0 };
    case "phone": return { rate: 1.6 };
    case "pregnancy":
      return age <= 41 ? { rate: dest === "usa" ? 10.0 : 5.0 } : { error: "available up to age 41" };
    case "pre_existing": {
      const b = byAge(PRE_EXISTING, age);
      return b ? { rate: b.rate, note: "subject to medical underwriting (health questionnaire)" } : { error: "not available at this age" };
    }
    case "personal_accident": {
      const b = byAge(PERSONAL_ACCIDENT, age);
      if (!b) return { error: "available up to age 70" };
      return { rate: r2(b.rate + (all.includes("extreme_sports") ? b.extreme : 0)) };
    }
    case "bicycle_2500": case "bicycle_4500": case "bicycle_6000":
      return { rate: BICYCLE[ext.split("_")[1]], maxDays: 90 };
    default: return { error: "unknown extension" };
  }
}

// ── Health declaration (Harel medical questionnaire 2026) ────────────────────
// Dalit asks these for all travelers at once; the server decides the outcome.
// Outcomes not spelled out on the form were confirmed by the office: a "yes" to
// regular medication, to 1.1/1.2 or to head scans on a short (≤15 days, not USA)
// trip, and surgery/hospitalization more than 3 months ago, all make the
// pre-existing condition extension mandatory.
export const HEALTH_QUESTIONS = [
  { id: "q1", text: "האם אחת ממטרות הנסיעה היא קבלת טיפול רפואי, ייעוץ רפואי או אבחון רפואי?",
    note: "אין צורך לענות כן על טיפולי שיניים, השתלת שיער וטיפולים קוסמטיים, כל עוד לא מדובר בהליך עם הרדמה מלאה." },
  { id: "q2", text: "האם בחצי השנה האחרונה אתה מקבל תרופות באופן קבוע או עברת טיפול רפואי אחר, או שהומלץ לך לקחת תרופות או לעבור טיפול רפואי?",
    note: "אין צורך לענות כן על: טיפול הורמונלי בגיל המעבר, ויטמינים או תוספי מזון, אלרגיה, גלולות למניעת היריון, כולסטרול, תת פעילות בלוטת המגן, קשב וריכוז, לחץ דם, בעיות שינה, צרבות, ערמונית מוגדלת, מיגרנות, תרופת הרזיה שלא ניתנה בגלל סוכרת, אקנה ונשירת שיער." },
  { id: "q2_1", if: "q2", text: "האם הטיפול הוא לאחד מהמצבים הבאים: אי ספיקת כליות עם דיאליזה; מחלת דם עם עירויי דם או הקזות; מחלה ממארת בטיפול פעיל של הקרנות, כימותרפיה או טיפול ביולוגי; ירידה בזיכרון או בהתמצאות שמצריכה השגחה או ליווי; מחלה במערכת העצבים, כולל אירוע מוחי או מחלה ניוונית כמו ALS, שגורמת לחוסר יציבות או לנפילות חוזרות; מצב שדורש מחולל חמצן; שחמת כבד עם סיבוכים כמו דימומים, צורך בהשתלה או הצטברות נוזלים, או אי ספיקת כבד?" },
  { id: "q2_2", if: "q2", text: "האם הטיפול הוא בגלל אי ספיקת לב עם אחד מאלה: בצקות, או תרופות להוצאת נוזלים מהגוף, או קוצר נשימה במנוחה או במאמץ קל כמו הליכה או עלייה במדרגות?" },
  { id: "q3", text: "האם בחצי השנה האחרונה עברת ניתוח או שהומלץ לך על ניתוח, או שאושפזת יותר משלושה ימים או שהומלץ לך על אשפוז, בגלל אחד מאלה: מחלת נפש, ראש, לב (כולל צנתור), כיס המרה ודרכי המרה, כליות (כולל אבנים בכליות ובדרכי השתן), דרכי העיכול והלבלב, ריאות, עמוד שדרה?" },
  { id: "q3_1", if: "q3", text: "האם הניתוח או האשפוז כבר בוצע, ועברו מאז יותר משלושה חודשים?" },
  { id: "q4", text: "האם בחצי השנה האחרונה הופנית לבדיקת MRI או CT של הראש שעוד לא בוצעה, או שתוצאותיה לא היו תקינות או כללו ממצא חריג?" },
  { id: "pregnant", forWomen: "up to age 41", text: "האם את בהיריון? אם כן, באיזה שבוע, והאם זה היריון בסיכון או מרובה עוברים, או שהרופא המליץ לא לנסוע לחוץ לארץ?" },
];

/**
 * Outcome of the health declaration for one traveler.
 * @returns {{ status: "ok"|"extension_required"|"doctor_letter"|"not_insurable", add?: string[], reasons: string[] }}
 */
export function assessHealth(h = {}, { dest, days, age } = {}) {
  const yes = (k) => h[k] === true || h[k] === "yes" || h[k] === "כן";
  const reasons = [];
  const add = new Set();
  let letter = false;
  // Medical documents are needed only for trips longer than 15 days or to the USA.
  const docsTrip = (days ?? 0) > 15 || dest === "usa";
  if (yes("q1")) return { status: "not_insurable", reasons: ["the trip is for medical treatment, consultation or diagnosis (question 1)"] };
  if (yes("q2")) {
    add.add("pre_existing");
    if ((yes("q2_1") || yes("q2_2")) && docsTrip) { letter = true; reasons.push("a condition from question 1.1/1.2 on a trip over 15 days or to the USA — current medical documents are required"); }
    else reasons.push("regular medication or treatment — the pre-existing condition extension is required");
  }
  if (yes("q3")) {
    if (yes("q3_1")) { add.add("pre_existing"); reasons.push("surgery/hospitalization more than 3 months ago — the pre-existing condition extension is required"); }
    else { letter = true; reasons.push("recent or recommended surgery/hospitalization (question 2) — current medical documents are required"); }
  }
  if (yes("q4")) {
    add.add("pre_existing");
    if (docsTrip) { letter = true; reasons.push("pending or abnormal head MRI/CT on a trip over 15 days or to the USA — current medical documents are required"); }
    else reasons.push("pending or abnormal head MRI/CT — the pre-existing condition extension is required");
  }
  if (yes("pregnant")) {
    const week = Number(h.pregnancy_week);
    const weekAtEnd = Number.isFinite(week) ? week + (days ?? 0) / 7 : NaN;
    if (yes("high_risk_pregnancy")) return { status: "not_insurable", reasons: ["high-risk or multiple pregnancy, or the doctor advised not to travel"] };
    if (age > 41 || (Number.isFinite(weekAtEnd) && weekAtEnd > 32))
      return { status: "not_insurable", reasons: ["pregnancy cover is only up to week 32 and age 41, so this trip can't be insured"] };
    add.add("pregnancy");
    reasons.push("pregnancy — the pregnancy extension is added automatically");
  }
  if (letter) return { status: "doctor_letter", add: [...add], reasons };
  return { status: add.size ? "extension_required" : "ok", add: [...add], reasons };
}

const RENTAL = { // per policy (one car), not per traveler
  rental_car: { rate: 6.5, minAge: 24, maxAge: 75, capTrip: 88 },
  rental_car_6000: { rate: 26.0, minAge: 24, maxAge: 77, capTrip: 88 },
};

/**
 * @param {{ destination: string, days?: number, start_date?: string, end_date?: string,
 *   travelers: { age: number, extensions?: string[] }[], extensions?: string[],
 *   remove_search_rescue?: boolean, driver_age?: number }} q
 */
export function calculateQuote(q) {
  const destText = String(q.destination ?? "").toLowerCase();
  const dest = /usa|united states|america|ארה"?ב|ארצות הברית|אמריקה|ניו יורק|new york|florida|פלורידה|לוס אנג|los angeles|las vegas|לאס וגאס/.test(destText) ? "usa" : "other";
  let days = Number(q.days);
  if (!days && q.start_date && q.end_date) {
    // Both the departure and the return day are insured days.
    days = Math.round((Date.parse(q.end_date) - Date.parse(q.start_date)) / 864e5) + 1;
  }
  if (!Number.isFinite(days) || days < 1) return { ok: false, error: "need the trip length: days, or start_date and end_date" };
  const travelers = Array.isArray(q.travelers) ? q.travelers : [];
  if (!travelers.length) return { ok: false, error: "need at least one traveler with an age" };

  // A plain-Hebrew read-back of what the model understood, for the caller to
  // confirm: in a test call "1-7 November" became "27 September-7 November".
  const heDate = (s) => new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(s));
  const ages = travelers.map((t) => t.age).join(", ");
  const trip_summary =
    `נסיעה ל${q.destination}` +
    (q.start_date && q.end_date ? `, מ-${heDate(q.start_date)} עד ${heDate(q.end_date)}` : "") +
    `, ${days} ימים, ${travelers.length === 1 ? `נוסע אחד בגיל ${ages}` : `${travelers.length} נוסעים בגילאי ${ages}`}`;

  // Never price without the full health declaration: the voice model tends to
  // ask question 1 and assume "no" for the rest. Every traveler needs an
  // explicit answer (true/false) to questions q1-q4.
  const REQUIRED = ["q1", "q2", "q3", "q4"];
  const missing = new Set();
  for (const t of travelers) for (const k of REQUIRED) if (!(t.health && k in t.health)) missing.add(k);
  if (missing.size) {
    return {
      ok: false,
      error: "Before pricing: FIRST read trip_summary back to the caller and ask if it is correct (fix the dates, ages or destination if not). Then ask Harel's health questions below EXACTLY as written — never your own questions. Ask each main question once for all travelers together. Ask a follow-up (if_yes_to) only after a yes to its parent. Ask the pregnancy question only if a traveler is a woman up to age 41. Then call again with every answer as true or false for each traveler.",
      trip_summary,
      missing_questions: HEALTH_QUESTIONS.filter((q) => missing.has(q.id)).map((q) => ({ id: q.id, text: q.text, ...(q.note ? { note: q.note } : {}) })),
      follow_up_questions: HEALTH_QUESTIONS.filter((q) => q.if || q.forWomen).map((q) => ({ id: q.id, ...(q.if ? { if_yes_to: q.if } : { only_for: `women ${q.forWomen}` }), text: q.text })),
    };
  }

  const tariff = BASE[dest];
  const tripExt = (q.extensions ?? []).filter((e) => !RENTAL[e]);
  const warnings = [];
  const people = travelers.map((t, i) => {
    const age = Number(t.age);
    const label = `traveler ${i + 1} (age ${age})`;
    const band = Number.isFinite(age) ? byAge(tariff.bands, age) : null;
    if (!band) { warnings.push(`${label}: not insurable online (age up to 95); the office will handle it`); return { age, error: "age not covered" }; }
    const overMax = days > band.maxDays;
    if (overMax) warnings.push(`${label}: the maximum trip length at this age is ${band.maxDays} days — the office must handle it`);
    const shortDays = Math.min(days, tariff.shortDays);
    const longDays = days - shortDays;
    let base = shortDays * band.short + longDays * band.long;
    if (q.remove_search_rescue) base -= days * SEARCH_RESCUE_PER_DAY;
    const health = assessHealth(t.health, { dest, days, age });
    if (health.status === "not_insurable") {
      warnings.push(`${label}: cannot be insured — ${health.reasons.join("; ")}`);
      return { age, health: health.status, reasons: health.reasons };
    }
    if (health.status === "doctor_letter")
      warnings.push(`${label}: needs medical underwriting — ${health.reasons.join("; ")}. The price below is not final; the office must handle it.`);
    let exts = [...new Set([...tripExt, ...(t.extensions ?? []).filter((e) => !RENTAL[e]), ...(health.add ?? [])])];
    // The form: sports cover can't be bought together with the pregnancy extension.
    if (exts.includes("pregnancy")) {
      const blocked = exts.filter((e) => /sports/.test(e));
      if (blocked.length) warnings.push(`${label}: sports extensions can't be combined with the pregnancy extension — left out`);
      exts = exts.filter((e) => !/sports/.test(e));
    }
    const lines = [];
    for (const ext of exts) {
      const d = extensionDaily(ext, age, dest, exts);
      if (d.error) { warnings.push(`${label}: ${EXTENSION_NAMES[ext] ?? ext} — ${d.error}`); continue; }
      const extDays = d.maxDays ? Math.min(days, d.maxDays) : days;
      let cost = d.rate * extDays;
      if (d.capTrip) cost = Math.min(cost, d.capTrip);
      if (d.note) warnings.push(`${label}: ${EXTENSION_NAMES[ext]} — ${d.note}`);
      lines.push({ extension: EXTENSION_NAMES[ext] ?? ext, per_day: d.rate, total: r2(cost) });
    }
    const total = base + lines.reduce((s, l) => s + l.total, 0);
    return {
      age,
      health: health.status,
      ...(health.reasons.length ? { health_reasons: health.reasons } : {}),
      ...(overMax ? { over_max_days: band.maxDays } : {}),
      base_per_day: longDays ? { first_days: band.short, after: band.long } : band.short,
      base: r2(base),
      extensions: lines,
      total: r2(total),
    };
  });

  const policyLines = [];
  for (const ext of q.extensions ?? []) {
    const rc = RENTAL[ext];
    if (!rc) continue;
    const driver = Number(q.driver_age ?? travelers[0]?.age);
    if (!(driver >= rc.minAge && driver <= rc.maxAge)) { warnings.push(`${EXTENSION_NAMES[ext]}: the driver must be ${rc.minAge}–${rc.maxAge}`); continue; }
    policyLines.push({ extension: EXTENSION_NAMES[ext], per_day: rc.rate, total: r2(Math.min(rc.rate * days, rc.capTrip)) });
  }

  const total = r2(people.reduce((s, p) => s + (p.total ?? 0), 0) + policyLines.reduce((s, l) => s + l.total, 0));
  const needsOffice = people.some((p) => p.health === "doctor_letter" || p.health === "not_insurable" || p.over_max_days);
  const mandatory = people.some((p) => p.health === "extension_required" || p.health === "doctor_letter");
  return {
    ok: true,
    trip_summary,
    final: !needsOffice,
    ...(needsOffice ? { next_step: "Tell the caller the office must complete this quote (medical underwriting), and leave a message for the office with the trip details." } : {}),
    ...(mandatory ? { mandatory_note: "The extensions added because of the health answers (pre-existing condition / pregnancy) are MANDATORY. Never quote or suggest a price without them, even if the caller asks for no extensions." } : {}),
    currency: "USD",
    destination: dest === "usa" ? "USA" : "all destinations except the USA",
    days,
    travelers: people,
    ...(policyLines.length ? { per_policy: policyLines } : {}),
    total,
    warnings,
    disclaimer: "Estimate by the 2026 Harel tariff. Final price and terms are confirmed at purchase; pre-existing conditions are subject to the health questionnaire and medical underwriting.",
  };
}

// ── Step-by-step questionnaire ───────────────────────────────────────────────
// Handing the model all the questions at once let it skip them and send "no"
// for everything (a test call did exactly that). Instead the server walks the
// questionnaire: one question per step, follow-ups queued only after a yes, and
// the price is released only after the last answer.
const QUOTE_TTL_MS = 30 * 60_000;
const quotes = new Map(); // quote_id → { q, answers: [{}...], queue: [id...], at }
const QUESTION = Object.fromEntries(HEALTH_QUESTIONS.map((x) => [x.id, x]));
const ASK = (id, n) => {
  const x = QUESTION[id];
  return {
    question_id: id,
    text: x.text,
    ...(x.note ? { note_if_asked: x.note } : {}),
    ...(id === "pregnant" ? { also_collect: "if yes: the pregnancy week, and whether it is high-risk / multiple / the doctor advised not to travel" } : {}),
    ...(n > 1 ? { ask_as: "one question for all travelers together, then note who answered yes" } : {}),
  };
};

export function startQuote(q) {
  for (const [k, v] of quotes) if (Date.now() - v.at >= QUOTE_TTL_MS) quotes.delete(k);
  const probe = calculateQuote({ ...q, travelers: (q.travelers ?? []).map((t) => ({ ...t, health: { q1: false, q2: false, q3: false, q4: false } })) });
  if (!probe.ok) return probe; // missing days / travelers
  const travelers = q.travelers.map(({ health, ...t }) => t); // answers only come through answerQuote
  const queue = ["q1", "q2", "q3", "q4"];
  if (travelers.some((t) => Number(t.age) <= 41 && t.gender !== "male")) queue.push("pregnant");
  const id = crypto.randomUUID().slice(0, 8);
  quotes.set(id, { q: { ...q, travelers }, answers: travelers.map(() => ({})), queue, at: Date.now() });
  return {
    ok: true,
    quote_id: id,
    trip_summary: probe.trip_summary,
    step: "Read trip_summary back to the caller and ask if it is correct. If it is wrong, start a new quote with the corrected details. If it is correct, ask ask_now EXACTLY as written. After each answer, send it with the answer tool AND, in the same turn, already ask the next question from questions_in_order (a follow-up only right after a yes to its parent), so the caller doesn't wait. If the tool's ask_now differs from what you asked, ask the tool's question instead.",
    ask_now: ASK(queue[0], travelers.length),
    questions_in_order: queue.flatMap((id) => [id, ...({ q2: ["q2_1", "q2_2"], q3: ["q3_1"] }[id] ?? [])]).map((id) => ({
      question_id: id, text: QUESTION[id].text, ...(QUESTION[id].if ? { only_after_yes_to: QUESTION[id].if } : {}),
    })),
  };
}

/**
 * @param {{ quote_id: string, question_id: string, answers: boolean|boolean[],
 *   pregnancy_week?: number, high_risk_pregnancy?: boolean }} a
 *   answers: true/false for all travelers, or one per traveler in trip order.
 */
export function answerQuote(a) {
  const s = quotes.get(String(a.quote_id ?? ""));
  if (!s) return { ok: false, error: "Unknown or expired quote_id. Start the quote again." };
  if (a.question_id !== s.queue[0])
    return { ok: false, error: `Answer the current question first.`, ask_now: ASK(s.queue[0], s.answers.length) };
  const list = Array.isArray(a.answers) ? a.answers : s.answers.map(() => a.answers);
  if (list.length !== s.answers.length || list.some((v) => typeof v !== "boolean"))
    return { ok: false, error: `answers must be true/false for all travelers, or a list of ${s.answers.length} true/false in trip order.`, ask_now: ASK(s.queue[0], s.answers.length) };
  const qid = s.queue.shift();
  list.forEach((v, i) => {
    s.answers[i][qid] = v;
    if (qid === "pregnant" && v) {
      if (a.pregnancy_week != null) s.answers[i].pregnancy_week = Number(a.pregnancy_week);
      if (a.high_risk_pregnancy != null) s.answers[i].high_risk_pregnancy = a.high_risk_pregnancy === true;
    }
  });
  // Follow-ups only after a yes, only for those who said yes (the rest: no).
  const followUps = { q2: ["q2_1", "q2_2"], q3: ["q3_1"] }[qid] ?? [];
  if (followUps.length && list.some(Boolean)) {
    s.queue.unshift(...followUps);
    list.forEach((v, i) => { if (!v) for (const f of followUps) s.answers[i][f] = false; });
  }
  s.at = Date.now();
  if (s.queue.length) return { ok: true, quote_id: a.quote_id, ask_now: ASK(s.queue[0], s.answers.length) };
  quotes.delete(String(a.quote_id));
  return calculateQuote({ ...s.q, travelers: s.q.travelers.map((t, i) => ({ ...t, health: s.answers[i] })) });
}
