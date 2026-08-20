const POLICY_REPLACEMENT =
  "هذا الرابط مخالف للسياسات، يرجى الالتزام بالسياسات.";

const profanityByLanguage = {
  ar: [
    "كس",
    "كسم",
    "شرموط",
    "شرموطه",
    "قحبه",
    "عاهره",
    "منيوك",
    "نيك",
    "زب",
    "طيز",
    "خول",
    "ابن القحبه",
  ],
  en: [
    "fuck",
    "fucker",
    "fucking",
    "motherfucker",
    "bitch",
    "cunt",
    "dick",
    "pussy",
    "asshole",
    "bastard",
    "slut",
    "whore",
    "nigger",
    "faggot",
  ],
  tr: [
    "siktir",
    "sikik",
    "orospu",
    "orospu cocugu",
    "amk",
    "amina koyim",
    "pic",
    "yarrak",
    "gotveren",
  ],
  kuFa: ["قه‌حپه", "قحپه", "کونی", "کیر", "کوس", "جنده", "حرومزاده", "لاشی"],
  fr: [
    "putain",
    "salope",
    "connard",
    "connasse",
    "encule",
    "enculer",
    "merdeux",
  ],
  de: ["hurensohn", "fotze", "wichser", "arschloch", "schlampe", "fick dich"],
  es: [
    "puta",
    "puto",
    "gilipollas",
    "cabron",
    "pendejo",
    "maricon",
    "hijo de puta",
    "chingada",
  ],
  ru: ["блять", "блядь", "сука", "хуй", "пизда", "ебать", "долбоеб", "пидор"],
} as const;

const profanity = Object.values(profanityByLanguage)
  .flat()
  .sort((left, right) => right.length - left.length);

const urlPattern =
  /(?:https?:\/\/|www\.)[^\s<>"']+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s<>"']*)?/giu;
const sexualUrlTerms = [
  "porn",
  "porno",
  "pornhub",
  "hentai",
  "xxx",
  "xvideos",
  "xnxx",
  "redtube",
  "onlyfans",
  "sexcam",
  "sex-video",
  "nudes",
  "اباحي",
  "اباحيه",
  "سكس",
  "جنسي",
];

const characterFold: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  أ: "ا",
  إ: "ا",
  آ: "ا",
  ٱ: "ا",
  ى: "ي",
  ئ: "ي",
  ؤ: "و",
  ة: "ه",
  ك: "ك",
  ک: "ك",
  ي: "ي",
  ی: "ي",
};

type NormalizedView = { text: string; sourceIndexes: number[] };

function normalizeWithSource(value: string): NormalizedView {
  let text = "";
  const sourceIndexes: number[] = [];
  let sourceIndex = 0;
  for (const sourceCharacter of value) {
    const folded = sourceCharacter
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(
        /[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g,
        "",
      );
    for (const rawCharacter of folded) {
      const character = characterFold[rawCharacter] ?? rawCharacter;
      text += /[\p{L}\p{N}]/u.test(character) ? character : " ";
      sourceIndexes.push(sourceIndex);
    }
    sourceIndex += sourceCharacter.length;
  }
  return { text, sourceIndexes };
}

function normalizeSimple(value: string) {
  return normalizeWithSource(value).text.replace(/\s+/g, " ").trim();
}

function termPattern(term: string) {
  const characters = [...normalizeSimple(term).replace(/\s/g, "")];
  const body = characters
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
}

const profanityPatterns = profanity.map(termPattern);

function replaceUnsafeUrls(value: string) {
  return value.replace(urlPattern, (url) => {
    const normalized = normalizeSimple(decodeURIComponentSafe(url));
    return sexualUrlTerms.some((term) =>
      normalized.includes(normalizeSimple(term)),
    )
      ? POLICY_REPLACEMENT
      : url;
  });
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maskProfanity(value: string) {
  const normalized = normalizeWithSource(value);
  const mask = new Set<number>();
  for (const pattern of profanityPatterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const sourceStart = normalized.sourceIndexes[start];
      const sourceEndIndex = normalized.sourceIndexes[Math.max(start, end - 1)];
      if (sourceStart === undefined || sourceEndIndex === undefined) continue;
      for (let index = sourceStart; index <= sourceEndIndex; index += 1) {
        if (/[^\s]/u.test(value[index] || "")) mask.add(index);
      }
    }
  }
  return value
    .split("")
    .map((character, index) => (mask.has(index) ? "*" : character))
    .join("");
}

export function moderateMainMessage(value: string) {
  const urlsFiltered = replaceUnsafeUrls(value);
  const text = maskProfanity(urlsFiltered);
  return { text, changed: text !== value };
}

export { POLICY_REPLACEMENT };
