// Text in a mail that talks to the model instead of the reader. A mail that has it goes to Needs sorting, before any
// model sees it: Laya and Claude can both be steered (eval 2026-11-02, 7 of 15 canaries moved a category). A false
// hit costs one mail the owner sorts by hand; a miss can misfile it. The patterns are general on purpose, not the
// canaries' wording, and the held-out canaries in the golden set check that.
const PATTERNS: RegExp[] = [
  // "ignore all previous instructions", "disregard the rules", German as well
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+|of\s+)*(?:previous\s+|prior\s+|above\s+|earlier\s+|preceding\s+|system\s+|mail\s+|these\s+|those\s+|other\s+)?(?:instructions?|rules|prompts?|guidelines|tags)\b/i,
  /\bignorier\w*\b[^.\n]{0,60}\b(?:anweisungen|regeln|vorgaben)\b/i,
  // "system prompt", "SYSTEM:", <system>, a tag that tries to close the mail block
  /\bsystem\s*(?:prompt|message|instructions?)\b|^\W*system\W*:|<\s*\/?\s*(?:system|mail|instructions?|assistant|user)\b/im,
  // the model addressed directly
  /\b(?:dear|hey|hi|attention|note to|message to|instructions? (?:for|to))\s+(?:the\s+)?(?:ai|a\.i\.|assistant|model|llm|chatbot|classifier|claude|gpt)\b/i,
  /^\W*(?:ai|assistant|claude|gpt|model)\s*[,:]/im,
  /\b(?:ai|llm|language model|assistant|chatbot|classifier|model)s?\b[^.\n]{0,40}\b(?:reading|processing|parsing|screening|sorting|classifying)\s+(?:this|these|the)\b/i,
  /\b(?:you are|pretend (?:you are|to be)|act as|roleplay as)\s+(?:now\s+)?(?:an?\s+|the\s+)?(?:owner|admin|developer|assistant|system)\b/i,
  /\b(?:developer|god|jailbreak|dan)\s+mode\b|\bjailbreak\b/i,
  /\b(?:your|the)\s+(?:rules|instructions|guidelines|prompt)\s+(?:have|has|were|was)\s+(?:been\s+)?(?:changed|updated|replaced|revoked)\b/i,
  /\bnew (?:task|instructions?|rules)\s*:/i,
  // a demand for a category, or for the answer's shape
  /\b(?:correct|valid|only|right|proper)\s+categor(?:y|ies)\b|\bcategor(?:y|ies)\s+(?:is|are|should be|must be)\b/i,
  /\b(?:file|mark|put|classify|categori[sz]e|sort|label|tag|move)\b[^.\n]{0,30}\b(?:as|under|into|in)\s+(?:personal|noise|career|blog ideas|social ideas|software development|spam|important)\b/i,
  /\b(?:mark|file|label|tag|classify|categori[sz]e)\s+(?:it|this|them|this (?:mail|message|email))\s+(?:as\s+)?(?:personal|noise|career|blog ideas|social ideas|software development|spam|important)\b/i,
  /\b(?:reply|respond|answer|return|output)\s+(?:only\s+)?(?:with|in)\b[^.\n]{0,30}\b(?:category|json|the word)\b|"category"\s*:/i,
  /\b(?:always|never)\s+(?:choose|pick|select|answer|file)\b/i,
  // asks about the summary the app writes from it
  /\bin (?:your|the) (?:paragraph|summary|answer|reply|output)\b|\binclude (?:this|the) link\b|!\[\[/i,
];

export const injectionSuspected = (text: string): boolean => PATTERNS.some((re) => re.test(text.slice(0, 20_000)));
