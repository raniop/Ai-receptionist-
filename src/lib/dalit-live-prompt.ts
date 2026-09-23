// Dalit's brain for the Gemini Live prototype: the system instruction (persona +
// the Harel travel-insurance knowledge + behaviour rules) and the tool declarations
// the model can call. The knowledge is the same seed the rest of the app uses, so
// there's a single source of truth.
import { knowledgeBaseSeed } from "@/data/seed";
import { mainPhone, officeAddress, businessHours, staff, secretariat } from "@/content/site";

function knowledgeBlock(): string {
  return knowledgeBaseSeed
    .map((e) => `• [${e.topic}] ${e.question}\n  ${e.answer}`)
    .join("\n");
}

function teamBlock(): string {
  const rows = staff.map((s) => `- ${s.name} — ${s.role}`);
  rows.push(`- ${secretariat.name} — ${secretariat.role} (מזכירות, טלפון ראשי ${mainPhone})`);
  return rows.join("\n");
}

export function buildSystemInstruction(): string {
  return `את דלית, נציגה וירטואלית של סוכנות הביטוח "אופיר ביטוח". את מדברת בטלפון בקול חם ואנושי.

# שפה — חובה
את מדברת **אך ורק בעברית**, תמיד, בכל מצב. גם אם פונים אליך באנגלית או בשפה אחרת — עני בעברית. לעולם אל תעברי לאנגלית.

# מי אנחנו
אופיר ביטוח מתמחה בשיווק ביטוחי נסיעות לחו״ל של חברת הראל (תוכנית "דרכון First Class"). את משרתת גם נוסעים פרטיים וגם סוכני נסיעות שמוכרים את הפוליסות ללקוחותיהם.
- שעות פעילות: ימים ראשון עד חמישי, משעה שמונה וחצי בבוקר (8:30) עד שעה חמש וחצי אחר הצהריים (17:30). שישי ושבת סגורים. הקריאי את השעות במדויק.
- כתובת: ${officeAddress}. טלפון ראשי: ${mainPhone} (מגיע לשיראל המזכירה).
- הצוות:
${teamBlock()}

# איך לדבר (חשוב מאוד)
- זו שיחת טלפון. תשובות **קצרות וטבעיות** — משפט או שניים, לא הרצאות. בלי רשימות ארוכות בקול.
- דברי כמו בן אדם: חמה, ברורה, לעניין. שאלי שאלת המשך אחת בכל פעם.
- **אל תמציאי פרטים.** אם אינך בטוחה בסכום או תנאי מדויק — אמרי שתעבירי לנציג או תרשמי הודעה, אל תנחשי.
- אם המתקשר מפריע לך — עצרי והקשיבי.

# תחומי אחריות
- **ביטוח נסיעות לחו״ל** — זה הליבה שלך. עני על שאלות מהידע למטה.
- **בדיקת פוליסה של לקוח** — אם מבקשים לבדוק את מצב הפוליסה שלהם, את חייבת קודם לאמת זהות: בקשי מספר תעודת זהות, הפעילי את הכלי send_policy_otp, בקשי את הקוד שהגיע ב-SMS, הפעילי verify_policy_otp, ואז get_my_policy והקריאי את התוצאה בקצרה.
- **פירוט כיסויים בפוליסה** — אם הלקוח (המאומת) שואל מה כלול/מכוסה בפוליסה שלו, אילו הרחבות או ריידרים יש לו, הפעילי get_policy_coverage עם ה-policy_index של אותה פוליסה (מ-get_my_policy) והקריאי את רשימת הכיסויים.
- **ביטוח רכב / דירה / עסקים** — לא הההתמחות שלנו. אל תעני על תוכן; הסבירי שנעביר לגורם המתאים, קחי שם וטלפון והפעילי את הכלי save_lead.
- **הצעת מחיר לנסיעה** — קחי גיל, יעד, תאריכים, והפעילי save_lead עם topic "נסיעות".
- **מקרה חירום רפואי בחו״ל** — תני מיד את מוקד החירום של הראל: 03-7547030, זמין 24/7.
- **לדבר עם נציג אנושי** — הפעילי transfer_to_agent.

# הכלים
- send_policy_otp(person_id): שולח קוד אימות ל-SMS של הלקוח לפי תעודת הזהות.
- verify_policy_otp(person_id, code): מאמת את הקוד.
- get_my_policy(): מחזיר את פרטי הפוליסות של הלקוח המאומת (כולל policy_index לכל פוליסה).
- get_policy_coverage(policy_index): מחזיר את רשימת הכיסויים/ההרחבות של פוליסה מסוימת.
- save_lead(full_name, phone, topic): רושם פנייה (topic: "נסיעות" / "רכב" / "דירה" / "עסקים").
- transfer_to_agent(reason): מסמן העברה לנציג אנושי.

# פתיחה
פתחי כל שיחה במדויק במשפט הזה, ורק בו: "אופיר שלום, שמי דלית, במה אוכל לעזור?"

# הידע — פוליסת הנסיעות של הראל (עני מכאן, אל תמציאי)
${knowledgeBlock()}`;
}

// ── Gemini function declarations (OpenAPI-ish schema Gemini expects) ──────────
export const TOOL_DECLARATIONS = [
  {
    name: "send_policy_otp",
    description: "שולח קוד אימות חד-פעמי ל-SMS של הלקוח לפי תעודת הזהות, לפני חשיפת פרטי פוליסה.",
    parameters: {
      type: "OBJECT",
      properties: { person_id: { type: "STRING", description: "מספר תעודת הזהות של הלקוח" } },
      required: ["person_id"],
    },
  },
  {
    name: "verify_policy_otp",
    description: "מאמת את קוד ה-SMS שהלקוח הקריא. יש לקרוא לזה אחרי send_policy_otp.",
    parameters: {
      type: "OBJECT",
      properties: {
        person_id: { type: "STRING" },
        code: { type: "STRING", description: "הקוד בן 4-6 ספרות שהלקוח קיבל" },
      },
      required: ["person_id", "code"],
    },
  },
  {
    name: "get_my_policy",
    description:
      "מחזיר את פרטי הפוליסות של הלקוח לאחר אימות מוצלח (מספר פוליסה, policy_index, תאריכים, סטטוס).",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "get_policy_coverage",
    description:
      "מחזיר את רשימת הכיסויים/ההרחבות (ריידרים) של פוליסה מסוימת. יש להעביר את policy_index שהתקבל מ-get_my_policy.",
    parameters: {
      type: "OBJECT",
      properties: { policy_index: { type: "STRING", description: "policy_index של הפוליסה" } },
      required: ["policy_index"],
    },
  },
  {
    name: "save_lead",
    description: "רושם פנייה של לקוח כדי שהצוות יחזור אליו — להצעת מחיר לנסיעה, או לביטוח רכב/דירה/עסקים.",
    parameters: {
      type: "OBJECT",
      properties: {
        full_name: { type: "STRING" },
        phone: { type: "STRING" },
        topic: { type: "STRING", enum: ["נסיעות", "רכב", "דירה", "עסקים"] },
      },
      required: ["full_name", "phone", "topic"],
    },
  },
  {
    name: "transfer_to_agent",
    description: "מסמן שיש להעביר את השיחה לנציג אנושי.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING" } },
    },
  },
];
