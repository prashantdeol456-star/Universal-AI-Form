import { getFieldDef } from "@ufa/shared";
import type { ChatLanguage } from "./language";

/**
 * Assistant wording. Replies are templated (not generated) so the assistant
 * never invents facts about the user and always says exactly what it will save.
 */
function label(fieldKey: string, lang: ChatLanguage): string {
  const def = getFieldDef(fieldKey);
  if (!def) return fieldKey.replace(/^custom\./, "").replace(/_/g, " ");
  return lang === "hi" ? def.label.hi : def.label.en;
}

export const replies = {
  proposalsIntro(lang: ChatLanguage, count: number): string {
    if (lang === "hi") return count === 1 ? "मैंने यह जानकारी समझी है। क्या इसे आपकी प्रोफ़ाइल में सेव कर दूँ?" : "मैंने यह जानकारी समझी है। जो सही हो उसे सेव करें:";
    if (lang === "hinglish") return count === 1 ? "Maine ye samjha hai. Kya ise aapki profile mein save kar doon?" : "Maine ye details samjhi hain. Jo sahi hain unhe save karein:";
    return count === 1 ? "Here's what I understood. Should I save it to your profile?" : "Here's what I understood. Save the ones that are correct:";
  },

  newValue(lang: ChatLanguage, fieldKey: string, value: string): string {
    return `${label(fieldKey, lang)}: ${value}`;
  },

  /** Spec §16 wording. */
  conflict(lang: ChatLanguage, fieldKey: string, current: string, next: string): string {
    const l = label(fieldKey, lang);
    if (lang === "hi") return `अभी आपका ${l} "${current}" सेव है। क्या मैं इसे "${next}" कर दूँ?`;
    if (lang === "hinglish") return `Abhi aapka ${l} "${current}" saved hai. Kya main ise "${next}" kar doon?`;
    return `I currently have "${current}" saved as your ${l}. Should I update it to "${next}"?`;
  },

  alreadyKnown(lang: ChatLanguage, fieldKey: string, value: string): string {
    const l = label(fieldKey, lang);
    if (lang === "hi") return `${l} "${value}" पहले से सेव है।`;
    if (lang === "hinglish") return `${l} "${value}" pehle se saved hai.`;
    return `I already have "${value}" as your ${l}.`;
  },

  answer(lang: ChatLanguage, fieldKey: string, value: string | null, verified: boolean): string {
    const l = label(fieldKey, lang);
    if (value === null) {
      if (lang === "hi") return `मेरे पास अभी आपका ${l} नहीं है। आप बता सकते हैं, जैसे: "मेरा ${l} … है"।`;
      if (lang === "hinglish") return `Mere paas abhi aapka ${l} nahi hai. Aap bata sakte hain, jaise: "Mera ${l} … hai".`;
      return `I don't have your ${l} yet. You can tell me, for example: "My ${l} is …".`;
    }
    const v = verified ? "" : lang === "en" ? " (not yet verified)" : lang === "hi" ? " (अभी सत्यापित नहीं)" : " (abhi verify nahi hua)";
    if (lang === "hi") return `आपका ${l}: ${value}${v}`;
    if (lang === "hinglish") return `Aapka ${l}: ${value}${v}`;
    return `Your ${l} is ${value}${v}.`;
  },

  summaryIntro(lang: ChatLanguage, count: number): string {
    if (count === 0) {
      if (lang === "hi") return "अभी मेरे पास आपकी कोई जानकारी सेव नहीं है।";
      if (lang === "hinglish") return "Abhi mere paas aapki koi details saved nahi hain.";
      return "I don't have any details saved for you yet.";
    }
    if (lang === "hi") return `मेरे पास आपकी ${count} जानकारियाँ सेव हैं:`;
    if (lang === "hinglish") return `Mere paas aapki ${count} details saved hain:`;
    return `I have ${count} details saved for you:`;
  },

  saved(lang: ChatLanguage, fieldKey: string): string {
    const l = label(fieldKey, lang);
    if (lang === "hi") return `${l} सेव हो गया।`;
    if (lang === "hinglish") return `${l} save ho gaya.`;
    return `Saved your ${l}.`;
  },

  help(lang: ChatLanguage): string {
    if (lang === "hi")
      return 'नमस्ते! मुझे अपने बारे में बताइए, मैं आपकी प्रोफ़ाइल में सेव कर दूँगा (आपकी अनुमति से)। जैसे: "मेरे पिता का नाम राज कुमार है", "मेरी जन्म तिथि 12/05/2001 है"। आप पूछ भी सकते हैं: "मेरे पिता का नाम क्या है?"';
    if (lang === "hinglish")
      return 'Namaste! Mujhe apne baare mein batayein, main aapki permission se profile mein save kar doonga. Jaise: "Mere papa ka naam Raj Kumar hai", "Maine 2022 mein B.Com complete kiya". Aap pooch bhi sakte hain: "Mera DOB kya hai?"';
    return 'Hi! Tell me about yourself and I\'ll save it to your profile — only after you confirm. For example: "My father\'s name is Raj Kumar", "I completed B.Com in 2022", "I am not an ex-serviceman". You can also ask: "What is my date of birth?" or "What do you know about me?"';
  },

  unknown(lang: ChatLanguage): string {
    if (lang === "hi") return 'मैं इससे कोई प्रोफ़ाइल जानकारी नहीं समझ पाया। कृपया साफ़ लिखें, जैसे: "मेरी माता का नाम सुनीता देवी है"।';
    if (lang === "hinglish") return 'Isse main koi profile detail nahi samajh paaya. Thoda clear likhiye, jaise: "Meri maa ka naam Sunita Devi hai".';
    return 'I couldn\'t find a profile detail in that. Try something like: "My mother\'s name is Sunita Devi" or "I have 3 years of experience".';
  },
};
