const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // Hindi month names
  जनवरी: 1, फरवरी: 2, फ़रवरी: 2, मार्च: 3, अप्रैल: 4, मई: 5, जून: 6, जुलाई: 7, अगस्त: 8, सितंबर: 9, सितम्बर: 9,
  अक्टूबर: 10, नवंबर: 11, नवम्बर: 11, दिसंबर: 12, दिसम्बर: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/** Matches a date in common written forms; the first capture group is the whole date text. */
export const DATE_PATTERN = new RegExp(
  `(\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTH_NAMES})\\.?,?\\s+\\d{4}|(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`,
  "i",
);

/** Converts a matched date to DD/MM/YYYY (the catalog's date validator does the calendar check). */
export function toDmy(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(\S+?)\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]!]) return `${m[1]}/${MONTHS[m[2]!]}/${m[3]}`;
  m = /^(\S+?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]!]) return `${m[2]}/${MONTHS[m[1]!]}/${m[3]}`;
  return null;
}
