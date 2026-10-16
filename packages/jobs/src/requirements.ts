/**
 * Deterministic reading of a job description: which skills it asks for (required vs
 * preferred), the minimum experience, and the education level. Only words that are in the
 * description are reported; nothing is inferred about the user here. Job text is untrusted:
 * it is matched against fixed patterns and never executed or obeyed.
 */

/** Common skills with aliases (lower case). The user's own profile skills are added at match time. */
export const SKILL_LEXICON: ReadonlyArray<{ name: string; aliases: string[] }> = [
  ["Project management", ["project management", "project manager", "managing projects", "pmp"]],
  ["Program management", ["program management", "programme management"]],
  ["Product management", ["product management", "product manager"]],
  ["Stakeholder management", ["stakeholder management", "stakeholder coordination", "stakeholder communication"]],
  ["Agile", ["agile"]],
  ["Scrum", ["scrum", "scrum master"]],
  ["Kanban", ["kanban"]],
  ["Jira", ["jira"]],
  ["Confluence", ["confluence"]],
  ["Risk management", ["risk management"]],
  ["Budgeting", ["budgeting", "budget management", "p&l"]],
  ["Communication", ["communication skills", "written communication", "verbal communication", "communication"]],
  ["Leadership", ["leadership", "team leadership", "people management", "team management"]],
  ["Negotiation", ["negotiation"]],
  ["Customer service", ["customer service", "customer support", "client servicing"]],
  ["Sales", ["sales", "business development", "b2b sales"]],
  ["Marketing", ["marketing", "digital marketing"]],
  ["SEO", ["seo", "search engine optimization"]],
  ["Content writing", ["content writing", "copywriting"]],
  ["Data analysis", ["data analysis", "data analytics", "analytical skills"]],
  ["Excel", ["excel", "ms excel", "microsoft excel", "spreadsheets"]],
  ["Power BI", ["power bi", "powerbi"]],
  ["Tableau", ["tableau"]],
  ["SQL", ["sql", "postgresql", "mysql", "t-sql"]],
  ["Python", ["python"]],
  ["Java", ["java"]],
  ["JavaScript", ["javascript", "ecmascript"]],
  ["TypeScript", ["typescript"]],
  ["React", ["react", "react.js", "reactjs"]],
  ["Node.js", ["node.js", "nodejs"]],
  ["Next.js", ["next.js", "nextjs"]],
  ["HTML/CSS", ["html", "css"]],
  ["Go", ["golang"]],
  ["C#", ["c#", ".net", "dotnet"]],
  ["C++", ["c++"]],
  ["PHP", ["php", "laravel"]],
  ["AWS", ["aws", "amazon web services"]],
  ["Azure", ["azure"]],
  ["Google Cloud", ["gcp", "google cloud"]],
  ["Docker", ["docker"]],
  ["Kubernetes", ["kubernetes", "k8s"]],
  ["Linux", ["linux"]],
  ["Git", ["git", "github", "gitlab"]],
  ["CI/CD", ["ci/cd", "continuous integration"]],
  ["Machine learning", ["machine learning", "ml models", "deep learning"]],
  ["Testing / QA", ["quality assurance", "qa", "test automation", "selenium"]],
  ["UI/UX design", ["ui/ux", "ux design", "ui design", "figma"]],
  ["Accounting", ["accounting", "bookkeeping"]],
  ["Tally", ["tally", "tally erp"]],
  ["GST", ["gst"]],
  ["Taxation", ["taxation", "income tax"]],
  ["Auditing", ["audit", "auditing"]],
  ["SAP", ["sap"]],
  ["Supply chain", ["supply chain", "logistics", "procurement", "inventory management"]],
  ["Operations", ["operations management"]],
  ["Recruitment", ["recruitment", "talent acquisition"]],
  ["HR", ["human resources", "hr operations", "payroll"]],
  ["Teaching", ["teaching", "lesson planning"]],
  ["Hindi", ["hindi"]],
  ["English", ["english"]],
].map(([name, aliases]) => ({ name: name as string, aliases: aliases as string[] }));

const REQUIRED_HEAD = /^(#+\s*)?(requirements?|qualifications?|minimum qualifications|basic qualifications|required skills|must[- ]haves?|what (you'll|you will) (need|bring)|what we('re| are) looking for|who you are|skills( required)?|skill ?set|key skills|core competencies|competencies|experience required|desired experience|eligibility|you (have|bring))\b/i;
const PREFERRED_HEAD = /^(#+\s*)?(preferred( qualifications| skills)?|nice[- ]to[- ]haves?|bonus( points)?|good to have|desired skills|pluses|additional qualifications)\b/i;
const OTHER_HEAD = /^(#+\s*)?(responsibilities|what you('ll| will) do|about (us|the (role|team|company))|benefits|perks|why join|the role|role overview|your impact|compensation|how to apply)\b/i;
const PREFERRED_LINE = /\b(preferred|nice to have|is a plus|a plus|bonus|good to have|desirable|advantageous|ideally)\b/i;

export type Section = "required" | "preferred" | "other" | "unknown";

export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  /** Skills mentioned outside any requirements section (no section headings found). */
  mentionedSkills: string[];
  experienceMinYears: number | null;
  /** The sentence the experience requirement came from (for the user to check). */
  experienceText: string | null;
  education: { level: "diploma" | "bachelor" | "master" | "phd"; required: boolean; text: string } | null;
  /** The description had requirement / preferred headings. */
  structured: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive test (works for "c++", "node.js", "ci/cd"). */
export function mentions(text: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  return new RegExp(`(^|[^a-z0-9+#])${escapeRe(t)}(?=$|[^a-z0-9+#])`, "i").test(text);
}

function linesWithSections(description: string): Array<{ line: string; section: Section }> {
  let section: Section = "unknown";
  const out: Array<{ line: string; section: Section }> = [];
  for (const raw of description.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.replace(/[:：]\s*$/, "");
    if (head.length <= 70) {
      if (PREFERRED_HEAD.test(head)) {
        section = "preferred";
        continue;
      }
      if (REQUIRED_HEAD.test(head)) {
        section = "required";
        continue;
      }
      if (OTHER_HEAD.test(head)) {
        section = "other";
        continue;
      }
    }
    out.push({ line, section: section === "required" && PREFERRED_LINE.test(line) ? "preferred" : section === "unknown" && PREFERRED_LINE.test(line) ? "preferred" : section });
  }
  return out;
}

const EXPERIENCE = /(\d{1,2}(?:\.\d)?)\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)\b[^.\n]{0,60}?\b(experience|exp\b|in\b|of\b|working)|(?:minimum|at least|min\.?)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?)/i;

export function extractRequirements(description: string, extraSkills: string[] = []): JobRequirements {
  const lines = linesWithSections(description);
  const structured = lines.some((l) => l.section === "required" || l.section === "preferred");
  const skills = [
    ...SKILL_LEXICON,
    // The user's own skills ("Tally Prime", "Warehouse automation") are looked for too.
    ...extraSkills
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 60)
      .map((s) => ({ name: s, aliases: [s.toLowerCase()] })),
  ];
  const where = new Map<string, Set<Section>>();
  for (const { line, section } of lines) {
    for (const s of skills) {
      if (s.aliases.some((a) => mentions(line, a))) {
        const key = s.name;
        if (!where.has(key)) where.set(key, new Set());
        where.get(key)!.add(section);
      }
    }
  }
  // Collapse case-insensitive duplicates (lexicon "Excel" vs user's "excel").
  const seen = new Set<string>();
  const required: string[] = [];
  const preferred: string[] = [];
  const mentioned: string[] = [];
  for (const [name, secs] of where) {
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (secs.has("required")) required.push(name);
    else if (secs.has("preferred")) preferred.push(name);
    else if (!structured || secs.has("unknown")) mentioned.push(name);
  }

  let experienceMinYears: number | null = null;
  let experienceText: string | null = null;
  for (const { line, section } of lines) {
    if (section === "preferred" || section === "other") continue;
    const m = EXPERIENCE.exec(line);
    if (!m) continue;
    const n = Number(m[1] ?? m[4]);
    if (Number.isFinite(n) && n > 0 && n <= 30) {
      experienceMinYears = n;
      experienceText = line.slice(0, 300);
      break;
    }
  }

  let education: JobRequirements["education"] = null;
  for (const { line, section } of lines) {
    if (section === "other") continue;
    const l = line.toLowerCase();
    const level = /\b(ph\.?d|doctorate)\b/.test(l)
      ? "phd"
      : /\b(master'?s|mba|m\.?tech|m\.?sc|post[- ]?graduat\w*|mca)\b/.test(l)
        ? "master"
        : /\b(bachelor'?s?|b\.?tech|b\.?e\b|b\.?sc|b\.?com|bca|bba|graduate degree|undergraduate degree|graduation|degree in)\b/.test(l)
          ? "bachelor"
          : /\b(diploma)\b/.test(l)
            ? "diploma"
            : null;
    if (level) {
      education = { level, required: section !== "preferred" && !PREFERRED_LINE.test(line) && !/\bor equivalent experience\b/i.test(line), text: line.slice(0, 300) };
      break;
    }
  }

  return { requiredSkills: required, preferredSkills: preferred, mentionedSkills: mentioned, experienceMinYears, experienceText, education, structured };
}
