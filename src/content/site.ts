/**
 * UI CONFIG ONLY — site name + navigation. Page content lives in Neon.
 */

export const site = {
  name: "אופיר ביטוח",
  nav: [
    { label: "נציגה וירטואלית", to: "/" },
    { label: "שיחה עם דלית", to: "/test" },
    { label: "Gemini Live ✨", to: "/live" },
    { label: "הצעת מחיר", to: "/quote" },
    { label: "קביעת פגישה", to: "/book" },
    { label: "שאלות ותשובות", to: "/answers" },
    { label: "אודות", to: "/about" },
  ],
} as const;

/** Business hours — the single source of truth for the OPEN/CLOSED status. */
export const businessHours = {
  /** 0 = Sunday … 6 = Saturday. Open Monday to Friday. */
  openDays: [1, 2, 3, 4, 5],
  openMinutes: 8 * 60 + 30,
  closeMinutes: 17 * 60 + 30,
  label: "שני עד שישי, 8:30–17:30",
} as const;

// Travel insurance is the core business, so it leads the list; the rest are transferred
// to the responsible desk.
export const insuranceTypes = [
  "ביטוח נסיעות לחו״ל",
  "רכב",
  "דירה",
  "עסקים",
  "אחר",
] as const;

export const serviceTypes = [
  "הצעת מחיר לנסיעה",
  "שאלה על כיסוי נסיעות",
  "סיוע בתביעה",
  "עזרה לסוכן נסיעות",
  "פנייה כללית",
] as const;

/** Main office contact details. The phone is shown with a dash and dialled without it. */
export const mainPhone = "073-2721111";
export const mainPhoneDial = "0732721111";

/** Full office address. */
export const officeAddress = "מצדה 9, בני ברק, מגדל ב.ס.ר 3, קומה 24";

export type StaffMember = {
  name: string;
  role: string;
  email: string;
  /** Direct desk line, when the person has one. */
  direct?: string;
  mobile?: string;
  fax?: string;
  /** Department this person owns for call transfers. */
  department?: string;
};

/** The secretariat — the general point of contact. */
export const secretariat = {
  name: "שיראל",
  role: "מזכירה",
  email: "ophir@ophirins.co.il",
} as const;

/** The Ophir Insurance team. */
export const staff: StaffMember[] = [
  {
    name: "אלי אופיר",
    role: "מנהל",
    email: "eli@ophirins.co.il",
    direct: "073-2721100",
    mobile: "052-5335440",
    fax: "03-5480688",
    department: "רכב",
  },
  {
    name: "הדר גלעד",
    role: "מנהל ביטוחי נסיעות לחו״ל",
    email: "hadar@ophirins.co.il",
    direct: "073-2721101",
    mobile: "052-5334040",
    department: "נסיעות",
  },
  {
    name: "רני אופיר",
    role: "מנהל תפעול",
    email: "rani@ophirins.co.il",
    direct: "073-2721110",
    mobile: "052-4444244",
    department: "תפעול",
  },
  {
    name: "גלעד כרמונה",
    role: "מנהל מכירות",
    email: "gilad@ophirins.co.il",
    mobile: "0522566014",
    department: "מכירות",
  },
];

/** Homepage voice-call entry point copy. */
export const voiceCta = {
  button: "דברו עם דלית עכשיו",
  subtitle: "שיחה קולית עם הנציגה הווירטואלית, בעברית, בשעות הפעילות 8:30–17:30.",
  fullPage: "לעמוד השיחה המלא",
  typingNote: "אפשר גם להקליד בצ׳אט למטה אם המיקרופון חסום.",
  close: "סגירת השיחה",
  bannerTitle: "מעדיפים לדבר?",
} as const;

/** Copy for the "Test the Receptionist" voice demo. */
export const dalitCopy = {
  name: "דלית",
  role: "נציגה וירטואלית",
  opening:
    "שלום, הגעתם לאופיר ביטוח, מומחי ביטוחי הנסיעות לחו״ל. שמי דלית, במה אפשר לעזור?",
  afterHours:
    "שלום, הגעתם לאופיר ביטוח, מומחי ביטוחי הנסיעות לחו״ל. כרגע המשרד סגור, אבל אני יכולה לענות על שאלות ולרשום הודעה, והצוות יחזור אליכם בהקדם.",
  unsupported: "הדפדפן שלכם אינו תומך במיקרופון — אפשר להקליד במקום.",
  intro:
    "זוהי סימולציה אינטראקטיבית של הנציגה הקולית של אופיר ביטוח, הפועלת כולה בדפדפן. דלית עונה על שאלות בנוגע לביטוחי נסיעות לחו״ל של הראל — כיסויים, מחירים, הרחבות ותביעות — משרתת נוסעים וסוכני נסיעות כאחד, ורושמת פניות לביטוחי רכב, דירה ועסקים להעברה לגורם המתאים.",
} as const;
