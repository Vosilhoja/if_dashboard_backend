/**
 * Status matcher and config for call-center outcomes
 */

const STATUS_CONFIG = {
  linkSent: {
    id: 'link_sent',
    name: 'Ссылка отправлена',
    description: 'Ссылка на регистрацию отправлена абоненту',
    phrases: ['silka yuborildi', 'silka_yuborildi', 'silka yuborilgan', 'silka_yuborilgan', 'yubordik', 'sms yuborildi'],
    maxDistance: 2,
  },
  repeatSent: {
    id: 'repeat_sent',
    name: 'Повторная отправка',
    description: 'Ссылка отправлена повторно',
    phrases: [
      'povtor silka yuborildi',
      'povtor silka',
      'povtor',
      'qayta malumot berildi',
      'qayta silka',
      'кайта малумот берилди',
      'учирган кайта малумот берилди',
    ],
    maxDistance: 2,
  },
  declined: {
    id: 'declined',
    name: 'Отказ',
    description: 'Абонент отказался или недоступен для регистрации',
    phrases: [
      'otkaz',
      "foydalanmasligini aytdi",
      "vaqti yo'q",
      'vaqti yo`q',
      "o'chirib qo'ydi",
      'o`chirib qo`ydi',
      'учириб куйди',
      'ishtirok etmagan',
      'sms ketmadi',
      "o'ylab ko'radi",
      'o`ylab ko`radi',
      'keyinroq',
      'keyinro',
    ],
    maxDistance: 2,
  },
  alreadyRegistered: {
    id: 'already_registered',
    name: 'Уже зарегистрирован через бот',
    description: 'Абонент сообщил, что уже пользуется ботом или сам зарегистрируется',
    phrases: [
      'bot bor',
      'botdan o`zi ro`yxatdan o`tishini aytdi',
      "botdan ro'yxatdan o'tdik",
      'botdan ro`yxatdan o`tdik',
      'руйхатдан уттик',
      "botdan ro'yxatdan o'tdi",
      "o'zi ro'yxatdan o'tishini aytdi",
    ],
    maxDistance: 2,
  },
  wrongPerson: {
    id: 'wrong_person',
    name: 'Не тот человек / номер',
    description: 'Номер принадлежит другому человеку или зарегистрирован с другого номера',
    phrases: [
      'boshqa raqamidan ro`yxatdan o`tgan',
      'boshqa odam',
      'raqam egasi boshqa',
      'иккинчи раками',
    ],
    maxDistance: 2,
  },
  thresholds: {
    smsMatchPercentage: 0.9,
  },
};

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1
        );
      }
    }
  }

  return dp[m][n];
}

function collapseRepeatedChars(text) {
  if (!text) return '';
  return text.replace(/(.)\1+/gu, '$1');
}

function transliterateCyrillicToLatin(str) {
  if (!str) return '';
  const map = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'x', 'ҳ': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh',
    'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', 'ў': 'o',
    'қ': 'q', 'ғ': 'g'
  };
  return str.split('').map((c) => map[c] || c).join('');
}

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[`'’ʻʽ_]/g, ' ')
    .replace(/[^\w\sа-яёўқғҳ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEMANTIC_CATEGORY_ROOTS = {
  declined: [
    'otkaz', 'rad', 'foydalan', 'vaqt', 'ochir', 'uchir', 'kerak',
    'xohla', 'hohla', 'istam', 'otmen', 'gaplash', 'keragi',
    'бросил', 'отказ', 'нет времени'
  ],
  linkSent: [
    'silka', 'yuboril', 'yubordik', 'sms', 'havola', 'отправлен', 'ссылк'
  ],
  repeatSent: [
    'povtor', 'qayta', 'повтор', 'кайта'
  ],
  alreadyRegistered: [
    'registratsiya', 'botdan', 'avval', 'oldin', 'royxat', 'ulangan', 'зарегистр', 'уже'
  ],
  wrongPerson: [
    'boshqa', 'notogri', 'xato', 'notugri', 'adashgan', 'не тот', 'неправильн', 'чужой'
  ]
};

function matchesCategory(rawText, category) {
  if (!rawText) return false;
  const norm = normalizeText(rawText);
  if (!norm) return false;

  const latinNorm = transliterateCyrillicToLatin(norm);
  const collapsedNorm = collapseRepeatedChars(norm);
  const collapsedLatin = collapseRepeatedChars(latinNorm);

  const semanticRoots = SEMANTIC_CATEGORY_ROOTS[category.id];
  if (semanticRoots) {
    for (const root of semanticRoots) {
      if (
        norm.includes(root) ||
        latinNorm.includes(root) ||
        collapsedNorm.includes(root) ||
        collapsedLatin.includes(root)
      ) {
        return true;
      }
    }
  }

  for (const phrase of (category.phrases || [])) {
    const normPhrase = normalizeText(phrase);
    if (!normPhrase) continue;
    const collapsedPhrase = collapseRepeatedChars(normPhrase);
    const latinPhrase = transliterateCyrillicToLatin(normPhrase);

    if (
      norm.includes(normPhrase) ||
      normPhrase.includes(norm) ||
      collapsedNorm.includes(collapsedPhrase) ||
      collapsedLatin.includes(collapsedPhrase) ||
      latinNorm.includes(latinPhrase)
    ) {
      return true;
    }

    const maxDist = category.maxDistance ?? 2;
    if (Math.abs(collapsedLatin.length - collapsedPhrase.length) <= maxDist) {
      if (levenshteinDistance(collapsedLatin, collapsedPhrase) <= maxDist) {
        return true;
      }
    }

    if (!normPhrase.includes(' ')) {
      const words = collapsedLatin.split(' ');
      for (const word of words) {
        if (
          word.length >= 3 &&
          levenshteinDistance(word, collapsedPhrase) <= (word.length > 5 ? maxDist : 1)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function isLinkSentStatus(comment, cfg) {
  return matchesCategory(comment, cfg || STATUS_CONFIG.linkSent);
}

function isRepeatSentStatus(comment, cfg) {
  return matchesCategory(comment, cfg || STATUS_CONFIG.repeatSent);
}

function isDeclinedStatus(comment, cfg) {
  return matchesCategory(comment, cfg || STATUS_CONFIG.declined);
}

function isAlreadyRegisteredStatus(comment, cfg) {
  return matchesCategory(comment, cfg || STATUS_CONFIG.alreadyRegistered);
}

function isWrongPersonStatus(comment, cfg) {
  return matchesCategory(comment, cfg || STATUS_CONFIG.wrongPerson);
}

module.exports = {
  STATUS_CONFIG,
  isLinkSentStatus,
  isRepeatSentStatus,
  isDeclinedStatus,
  isAlreadyRegisteredStatus,
  isWrongPersonStatus
};
