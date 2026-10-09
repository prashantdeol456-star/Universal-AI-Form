import { normalizeLabel } from "@ufa/form-engine";

/**
 * Multilingual concept lexicon (spec §23). Labels in English, Hindi and
 * Hinglish are reduced to language-independent concepts, so "Father's Name",
 * "Name of Father", "पिता का नाम" and "pitaji ka naam" all become {FATHER, NAME}.
 * Rules over concepts (rules.ts) then pick profile fields.
 */
export type Concept =
  | "FATHER" | "MOTHER" | "GUARDIAN" | "SPOUSE" | "HUSBAND" | "WIFE" | "NAME" | "FULL" | "FIRST" | "MIDDLE" | "LAST" | "CANDIDATE"
  | "DATE" | "BIRTH" | "AGE" | "MOBILE" | "PHONE" | "ALTERNATE" | "EMAIL" | "ADDRESS" | "PERMANENT" | "CURRENT" | "LINE1" | "LINE2"
  | "PIN" | "CITY" | "DISTRICT" | "STATE" | "COUNTRY" | "GENDER" | "MARITAL" | "NATIONALITY" | "RELIGION" | "MOTHER_TONGUE"
  | "CATEGORY" | "CASTE" | "CERTIFICATE" | "EXSERVICEMAN" | "PWD" | "EWS" | "GOVERNMENT" | "EMPLOYEE" | "DOMICILE"
  | "AADHAAR" | "PAN" | "PASSPORT" | "VOTER" | "DRIVING" | "LICENCE" | "BANK" | "ACCOUNT" | "IFSC" | "BRANCH" | "NUMBER"
  | "EXPERIENCE" | "COMPANY" | "DESIGNATION" | "DEPARTMENT" | "SALARY" | "JOINING" | "NOTICE"
  | "DESIRED" | "LINKEDIN" | "RELOCATE" | "SPONSORSHIP" | "WORK_AUTH" | "TRAVEL" | "START"
  | "HIGHEST" | "QUALIFICATION" | "YEAR" | "PASSING" | "PERCENTAGE" | "CGPA" | "ROLL" | "REGISTRATION" | "BOARD" | "UNIVERSITY"
  | "COLLEGE" | "SCHOOL" | "COURSE" | "SPECIALIZATION" | "STREAM"
  | "L10" | "L12" | "LGRAD" | "LPG" | "LDIPLOMA" | "MATRIC"
  | "OCCUPATION" | "PLACE" | "INCOME"
  | "DECLARATION" | "CAPTCHA" | "OTP" | "PASSWORD" | "UPLOAD" | "PHOTO" | "SIGNATURE" | "QUESTION" | "AS_PER";

/** Multi-word phrases first (they win over single tokens). */
const PHRASES: Array<[string, Concept[]]> = [
  ["date of birth", ["DATE", "BIRTH"]], ["birth date", ["DATE", "BIRTH"]], ["d o b", ["DATE", "BIRTH"]],
  ["ex serviceman", ["EXSERVICEMAN"]], ["ex servicemen", ["EXSERVICEMAN"]], ["ex service man", ["EXSERVICEMAN"]], ["ex army", ["EXSERVICEMAN"]],
  ["भूतपूर्व सैनिक", ["EXSERVICEMAN"]], ["पूर्व सैनिक", ["EXSERVICEMAN"]],
  ["person with disability", ["PWD"]], ["persons with benchmark disabilities", ["PWD"]], ["physically handicapped", ["PWD"]], ["physically challenged", ["PWD"]],
  ["economically weaker section", ["EWS"]], ["economically weaker", ["EWS"]],
  ["year of passing", ["YEAR", "PASSING"]], ["passing year", ["YEAR", "PASSING"]], ["year of pass", ["YEAR", "PASSING"]], ["उत्तीर्ण वर्ष", ["YEAR", "PASSING"]], ["उत्तीर्ण होने का वर्ष", ["YEAR", "PASSING"]],
  ["roll number", ["ROLL"]], ["roll no", ["ROLL"]], ["registration number", ["REGISTRATION"]], ["enrolment number", ["REGISTRATION"]], ["enrollment number", ["REGISTRATION"]],
  ["pin code", ["PIN"]], ["postal code", ["PIN"]], ["zip code", ["PIN"]], ["पिन कोड", ["PIN"]],
  ["e mail", ["EMAIL"]], ["email id", ["EMAIL"]], ["mail id", ["EMAIL"]],
  ["mobile number", ["MOBILE"]], ["mobile no", ["MOBILE"]], ["phone number", ["PHONE"]], ["contact number", ["MOBILE"]], ["contact no", ["MOBILE"]], ["whatsapp number", ["MOBILE"]],
  ["marital status", ["MARITAL"]], ["वैवाहिक स्थिति", ["MARITAL"]], ["mother tongue", ["MOTHER_TONGUE"]], ["मातृभाषा", ["MOTHER_TONGUE"]],
  ["highest qualification", ["HIGHEST", "QUALIFICATION"]], ["highest education", ["HIGHEST", "QUALIFICATION"]], ["educational qualification", ["QUALIFICATION"]],
  ["उच्चतम योग्यता", ["HIGHEST", "QUALIFICATION"]], ["शैक्षिक योग्यता", ["QUALIFICATION"]],
  ["account number", ["ACCOUNT", "NUMBER"]], ["a c no", ["ACCOUNT", "NUMBER"]], ["ac no", ["ACCOUNT", "NUMBER"]], ["खाता संख्या", ["ACCOUNT", "NUMBER"]],
  ["ifsc code", ["IFSC"]], ["bank name", ["BANK", "NAME"]],
  ["driving licence", ["DRIVING", "LICENCE"]], ["driving license", ["DRIVING", "LICENCE"]], ["voter id", ["VOTER"]], ["epic number", ["VOTER"]],
  ["aadhaar number", ["AADHAAR"]], ["aadhar number", ["AADHAAR"]], ["uid number", ["AADHAAR"]], ["pan number", ["PAN"]], ["pan card", ["PAN"]], ["passport number", ["PASSPORT"]],
  ["address line 1", ["ADDRESS", "LINE1"]], ["address line1", ["ADDRESS", "LINE1"]], ["address line 2", ["ADDRESS", "LINE2"]], ["address line2", ["ADDRESS", "LINE2"]],
  ["first name", ["FIRST", "NAME"]], ["given name", ["FIRST", "NAME"]], ["middle name", ["MIDDLE", "NAME"]], ["last name", ["LAST", "NAME"]], ["family name", ["LAST", "NAME"]],
  ["full name", ["FULL", "NAME"]], ["पूरा नाम", ["FULL", "NAME"]],
  ["post graduation", ["LPG"]], ["post graduate", ["LPG"]], ["post graduation", ["LPG"]], ["senior secondary", ["L12"]], ["higher secondary", ["L12"]], ["high school", ["L10"]],
  ["class 10", ["L10"]], ["class x", ["L10"]], ["class 12", ["L12"]], ["class xii", ["L12"]],
  ["government employee", ["GOVERNMENT", "EMPLOYEE"]], ["govt employee", ["GOVERNMENT", "EMPLOYEE"]], ["सरकारी कर्मचारी", ["GOVERNMENT", "EMPLOYEE"]],
  ["date of joining", ["JOINING", "DATE"]], ["joining date", ["JOINING", "DATE"]], ["notice period", ["NOTICE"]], ["eligible to work", ["WORK_AUTH"]], ["authorized to work", ["WORK_AUTH"]], ["authorised to work", ["WORK_AUTH"]], ["right to work", ["WORK_AUTH"]], ["work authorization", ["WORK_AUTH"]],
  ["earliest date you can start", ["START", "DATE"]], ["start employment", ["START", "DATE"]], ["date of availability", ["START", "DATE"]], ["earliest start", ["START", "DATE"]], ["available to join", ["START", "DATE"]], ["employee id", ["EMPLOYEE", "NUMBER"]], ["employee code", ["EMPLOYEE", "NUMBER"]],
  ["as per", ["AS_PER"]], ["as recorded in", ["AS_PER"]], ["according to", ["AS_PER"]],
  ["i hereby", ["DECLARATION"]], ["i declare", ["DECLARATION"]], ["i agree", ["DECLARATION"]], ["i accept", ["DECLARATION"]], ["terms and conditions", ["DECLARATION"]],
  ["one time password", ["OTP"]], ["security code", ["CAPTCHA"]], ["characters shown", ["CAPTCHA"]],
  ["caste certificate", ["CASTE", "CERTIFICATE"]], ["जाति प्रमाण पत्र", ["CASTE", "CERTIFICATE"]],
  ["are you", ["QUESTION"]], ["do you", ["QUESTION"]], ["whether", ["QUESTION"]], ["क्या आप", ["QUESTION"]],
];

const TOKENS: Record<string, Concept[]> = {
  // family
  father: ["FATHER"], fathers: ["FATHER"], dad: ["FATHER"], papa: ["FATHER"], pita: ["FATHER"], pitaji: ["FATHER"], पिता: ["FATHER"], पिताजी: ["FATHER"], पापा: ["FATHER"],
  mother: ["MOTHER"], mothers: ["MOTHER"], mom: ["MOTHER"], mata: ["MOTHER"], mataji: ["MOTHER"], maa: ["MOTHER"], माता: ["MOTHER"], माताजी: ["MOTHER"], माँ: ["MOTHER"], मां: ["MOTHER"],
  guardian: ["GUARDIAN"], guardians: ["GUARDIAN"], abhibhavak: ["GUARDIAN"], अभिभावक: ["GUARDIAN"], संरक्षक: ["GUARDIAN"],
  spouse: ["SPOUSE"], spouses: ["SPOUSE"], husband: ["HUSBAND"], husbands: ["HUSBAND"], wife: ["WIFE"], wifes: ["WIFE"], pati: ["HUSBAND"], patni: ["WIFE"], पति: ["HUSBAND"], पत्नी: ["WIFE"],
  // names
  name: ["NAME"], names: ["NAME"], nm: ["NAME"], naam: ["NAME"], nam: ["NAME"], नाम: ["NAME"],
  full: ["FULL"], first: ["FIRST"], given: ["FIRST"], middle: ["MIDDLE"], last: ["LAST"], surname: ["LAST", "NAME"], उपनाम: ["LAST", "NAME"],
  candidate: ["CANDIDATE"], candidates: ["CANDIDATE"], applicant: ["CANDIDATE"], applicants: ["CANDIDATE"], student: ["CANDIDATE"], students: ["CANDIDATE"],
  your: ["CANDIDATE"], personal: ["CANDIDATE"], self: ["CANDIDATE"], details: [], detail: [], information: [], info: [], particulars: [], विवरण: [], जानकारी: [], व्यक्तिगत: ["CANDIDATE"], aavedak: ["CANDIDATE"], आवेदक: ["CANDIDATE"], उम्मीदवार: ["CANDIDATE"], अभ्यर्थी: ["CANDIDATE"], परीक्षार्थी: ["CANDIDATE"],
  // dates
  date: ["DATE"], dt: ["DATE"], dated: ["DATE"], तिथि: ["DATE"], तारीख: ["DATE"], दिनांक: ["DATE"], tithi: ["DATE"],
  birth: ["BIRTH"], born: ["BIRTH"], dob: ["DATE", "BIRTH"], जन्म: ["BIRTH"], जन्मतिथि: ["DATE", "BIRTH"], janm: ["BIRTH"], janam: ["BIRTH"], age: ["AGE"], आयु: ["AGE"], उम्र: ["AGE"],
  // contact
  mobile: ["MOBILE"], mob: ["MOBILE"], cell: ["MOBILE"], cellphone: ["MOBILE"], मोबाइल: ["MOBILE"], phone: ["PHONE"], telephone: ["PHONE"], tel: ["PHONE"], फोन: ["PHONE"], फ़ोन: ["PHONE"],
  alternate: ["ALTERNATE"], alternative: ["ALTERNATE"], other: ["ALTERNATE"], secondary: ["L10"], वैकल्पिक: ["ALTERNATE"],
  email: ["EMAIL"], mail: ["EMAIL"], ईमेल: ["EMAIL"],
  address: ["ADDRESS"], addr: ["ADDRESS"], पता: ["ADDRESS"], pata: ["ADDRESS"], residence: ["ADDRESS"],
  permanent: ["PERMANENT"], स्थायी: ["PERMANENT"], sthayi: ["PERMANENT"], present: ["CURRENT"], current: ["CURRENT"], correspondence: ["CURRENT"], communication: ["CURRENT"], वर्तमान: ["CURRENT"], पत्राचार: ["CURRENT"],
  pin: ["PIN"], pincode: ["PIN"], postal: ["PIN"], zip: ["PIN"], zipcode: ["PIN"], पिन: ["PIN"], पिनकोड: ["PIN"],
  city: ["CITY"], town: ["CITY"], village: ["CITY"], tehsil: ["CITY"], शहर: ["CITY"], नगर: ["CITY"], गाँव: ["CITY"], गांव: ["CITY"], ग्राम: ["CITY"],
  district: ["DISTRICT"], dist: ["DISTRICT"], जिला: ["DISTRICT"], ज़िला: ["DISTRICT"], जनपद: ["DISTRICT"],
  state: ["STATE"], राज्य: ["STATE"], प्रदेश: ["STATE"], country: ["COUNTRY"], देश: ["COUNTRY"],
  // personal
  gender: ["GENDER"], sex: ["GENDER"], लिंग: ["GENDER"], marital: ["MARITAL"], married: ["MARITAL"], वैवाहिक: ["MARITAL"],
  nationality: ["NATIONALITY"], राष्ट्रीयता: ["NATIONALITY"], religion: ["RELIGION"], धर्म: ["RELIGION"],
  // recruitment
  category: ["CATEGORY"], श्रेणी: ["CATEGORY"], वर्ग: ["CATEGORY"], caste: ["CASTE"], जाति: ["CASTE"], community: ["CASTE"],
  certificate: ["CERTIFICATE"], प्रमाण: ["CERTIFICATE"],
  esm: ["EXSERVICEMAN"], exserviceman: ["EXSERVICEMAN"], pwd: ["PWD"], pwbd: ["PWD"], disability: ["PWD"], disabled: ["PWD"], divyang: ["PWD"], दिव्यांग: ["PWD"], विकलांग: ["PWD"], handicapped: ["PWD"],
  ews: ["EWS"], government: ["GOVERNMENT"], govt: ["GOVERNMENT"], सरकारी: ["GOVERNMENT"], employee: ["EMPLOYEE"], domicile: ["DOMICILE"], मूल: ["DOMICILE"], निवास: ["DOMICILE"],
  // identity & bank
  aadhaar: ["AADHAAR"], aadhar: ["AADHAAR"], adhar: ["AADHAAR"], uid: ["AADHAAR"], आधार: ["AADHAAR"], pan: ["PAN"], पैन: ["PAN"], passport: ["PASSPORT"], पासपोर्ट: ["PASSPORT"],
  voter: ["VOTER"], epic: ["VOTER"], मतदाता: ["VOTER"], driving: ["DRIVING"], licence: ["LICENCE"], license: ["LICENCE"], dl: ["DRIVING", "LICENCE"],
  bank: ["BANK"], बैंक: ["BANK"], account: ["ACCOUNT"], खाता: ["ACCOUNT"], ifsc: ["IFSC"], branch: ["BRANCH"], शाखा: ["BRANCH"],
  number: ["NUMBER"], no: ["NUMBER"], num: ["NUMBER"], संख्या: ["NUMBER"], नंबर: ["NUMBER"], क्रमांक: ["NUMBER"],
  // employment
  experience: ["EXPERIENCE"], exp: ["EXPERIENCE"], अनुभव: ["EXPERIENCE"], company: ["COMPANY"], employer: ["COMPANY"], organisation: ["COMPANY"], organization: ["COMPANY"], कंपनी: ["COMPANY"],
  designation: ["DESIGNATION"], पद: ["DESIGNATION"], department: ["DEPARTMENT"], विभाग: ["DEPARTMENT"], salary: ["SALARY"], ctc: ["SALARY"], वेतन: ["SALARY"],
  desired: ["DESIRED"], expected: ["DESIRED"], expectation: ["DESIRED"], expectations: ["DESIRED"], linkedin: ["LINKEDIN"], relocate: ["RELOCATE"], relocation: ["RELOCATE"],
  sponsorship: ["SPONSORSHIP"], sponsor: ["SPONSORSHIP"], travel: ["TRAVEL"],
  // education
  highest: ["HIGHEST"], qualification: ["QUALIFICATION"], education: ["QUALIFICATION"], योग्यता: ["QUALIFICATION"], शिक्षा: ["QUALIFICATION"],
  year: ["YEAR"], yr: ["YEAR"], वर्ष: ["YEAR"], passing: ["PASSING"], passed: ["PASSING"], उत्तीर्ण: ["PASSING"],
  percentage: ["PERCENTAGE"], percent: ["PERCENTAGE"], marks: ["PERCENTAGE"], प्रतिशत: ["PERCENTAGE"], अंक: ["PERCENTAGE"],
  cgpa: ["CGPA"], gpa: ["CGPA"], sgpa: ["CGPA"], cpi: ["CGPA"], roll: ["ROLL"], अनुक्रमांक: ["ROLL"], registration: ["REGISTRATION"], enrolment: ["REGISTRATION"], enrollment: ["REGISTRATION"], पंजीकरण: ["REGISTRATION"],
  board: ["BOARD"], बोर्ड: ["BOARD"], university: ["UNIVERSITY"], विश्वविद्यालय: ["UNIVERSITY"], college: ["COLLEGE"], institute: ["COLLEGE"], महाविद्यालय: ["COLLEGE"],
  school: ["SCHOOL"], विद्यालय: ["SCHOOL"], course: ["COURSE"], degree: ["COURSE"], programme: ["COURSE"], program: ["COURSE"],
  specialization: ["SPECIALIZATION"], specialisation: ["SPECIALIZATION"], subject: ["SPECIALIZATION"], stream: ["STREAM"],
  matric: ["L10", "MATRIC"], matriculation: ["L10", "MATRIC"], "10th": ["L10"], tenth: ["L10"], ssc: ["L10"], हाईस्कूल: ["L10"], दसवीं: ["L10"],
  "12th": ["L12"], twelfth: ["L12"], intermediate: ["L12"], inter: ["L12"], hsc: ["L12"], इंटरमीडिएट: ["L12"], बारहवीं: ["L12"],
  graduation: ["LGRAD"], graduate: ["LGRAD"], ug: ["LGRAD"], bachelor: ["LGRAD"], bachelors: ["LGRAD"], स्नातक: ["LGRAD"],
  pg: ["LPG"], postgraduation: ["LPG"], master: ["LPG"], masters: ["LPG"], स्नातकोत्तर: ["LPG"], diploma: ["LDIPLOMA"], डिप्लोमा: ["LDIPLOMA"],
  occupation: ["OCCUPATION"], profession: ["OCCUPATION"], vyavsay: ["OCCUPATION"], व्यवसाय: ["OCCUPATION"], पेशा: ["OCCUPATION"],
  place: ["PLACE"], sthan: ["PLACE"], स्थान: ["PLACE"], income: ["INCOME"], आय: ["INCOME"], annual: ["INCOME"],
  // non-profile
  declaration: ["DECLARATION"], declare: ["DECLARATION"], undertaking: ["DECLARATION"], घोषणा: ["DECLARATION"], captcha: ["CAPTCHA"], otp: ["OTP"], password: ["PASSWORD"],
  upload: ["UPLOAD"], photo: ["PHOTO"], photograph: ["PHOTO"], फोटो: ["PHOTO"], signature: ["SIGNATURE"], हस्ताक्षर: ["SIGNATURE"],
  line: [], of: [], the: [], ka: [], ki: [], ke: [], का: [], की: [], के: [], है: [], and: [], or: [], in: [], as: [], per: [],
};

export interface ConceptSet {
  concepts: Set<Concept>;
  /** Tokens that matched nothing (very generic labels have none; unknown labels have many). */
  unknownTokens: string[];
}

/** Text -> concepts. Phrases are matched first and consumed. */
export function conceptsOf(text: string): ConceptSet {
  let t = ` ${normalizeLabel(text)} `;
  const concepts = new Set<Concept>();
  for (const [phrase, cs] of PHRASES) {
    const needle = ` ${phrase} `;
    if (t.includes(needle)) {
      cs.forEach((c) => concepts.add(c));
      t = t.split(needle).join(" ");
    }
  }
  const unknownTokens: string[] = [];
  for (const tok of t.split(/\s+/).filter(Boolean)) {
    const cs = TOKENS[tok];
    if (cs) cs.forEach((c) => concepts.add(c));
    else if (!/^\d+$/.test(tok) && tok.length > 1) unknownTokens.push(tok);
  }
  return { concepts, unknownTokens };
}

/** Education level named in a text, if exactly one. */
export function levelOf(concepts: Set<Concept>): "class_10" | "class_12" | "graduation" | "post_graduation" | "diploma" | null {
  const found = (
    [
      ["L10", "class_10"],
      ["L12", "class_12"],
      ["LPG", "post_graduation"],
      ["LGRAD", "graduation"],
      ["LDIPLOMA", "diploma"],
    ] as const
  ).filter(([c]) => concepts.has(c));
  // "post graduation" also contains "graduation" -> prefer the more specific level.
  if (found.some(([c]) => c === "LPG")) return "post_graduation";
  return found.length === 1 ? found[0]![1] : null;
}
