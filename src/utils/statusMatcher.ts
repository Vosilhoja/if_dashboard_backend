/**
 * Status matcher and config for call-center outcomes
 */
const { pool, isPgConnected } = require('../db');

const CACHE_TTL_MS = 30_000;
let learnedCache = { byCategory: new Map(), disabled: new Map(), loadedAt: 0 };

function phraseKey(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[`'’ʻʽ_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadLearnedPhrasesFromDb() {
  if (!isPgConnected() || !pool) return false;
  const result = await pool.query('SELECT category_id, phrase, is_disabled FROM learned_phrases');
  const byCategory = new Map();
  const disabled = new Map();
  for (const row of result.rows) {
    if (row.is_disabled) {
      if (!disabled.has(row.category_id)) disabled.set(row.category_id, new Set());
      disabled.get(row.category_id).add(phraseKey(row.phrase));
    } else {
      if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, []);
      byCategory.get(row.category_id).push(String(row.phrase).trim());
    }
  }
  learnedCache = { byCategory, disabled, loadedAt: Date.now() };
  return true;
}

/**
 * @param {{id: string, phrases: string[]}} category
 */
function getStatusPhrases(category) {
  if (isPgConnected()) {
    if (Date.now() - learnedCache.loadedAt >= CACHE_TTL_MS) {
      loadLearnedPhrasesFromDb().catch((error) => {
        console.error('[StatusMatcher] Не удалось обновить кэш learned-фраз:', error.message || error);
      });
    }
    const disabled = learnedCache.disabled.get(category.id) || new Set();
    const phrases = [
      ...category.phrases.filter((phrase) => !disabled.has(phraseKey(phrase))),
      ...(learnedCache.byCategory.get(category.id) || []),
    ];
    const unique = new Map();
    for (const phrase of phrases) {
      const key = phraseKey(phrase);
      if (key && !unique.has(key)) unique.set(key, phrase);
    }
    return [...unique.values()];
  }
  const unique = new Map();
  for (const phrase of category.phrases) {
    const key = phraseKey(phrase);
    if (key && !unique.has(key)) unique.set(key, phrase);
  }
  return [...unique.values()];
}

function getStatusCategory(categoryId) {
  const category = Object.values(STATUS_CONFIG).find((item) => 'id' in item && item.id === categoryId);
  if (!category || !('id' in category) || !('phrases' in category)) {
    throw new Error('Неизвестная категория статуса');
  }
  return category;
}

function getEditableStatusCategories() {
  return Object.values(STATUS_CONFIG).reduce((categories, category) => {
    if (!('id' in category) || !('phrases' in category)) return categories;
    categories.push({
      id: category.id,
      name: category.name,
      description: category.description,
      phrases: getStatusPhrases(category),
      editablePhrases: getStatusPhrases(category),
    });
    return categories;
  }, []);
}

async function updateLearnedPhrase(categoryId, phrase, action = 'add') {
  if (!isPgConnected() || !pool) throw new Error('PostgreSQL не подключен');
  if (!getEditableStatusCategories().some((category) => category.id === categoryId)) {
    throw new Error('Неизвестная категория статуса');
  }
  const normalizedPhrase = String(phrase || '').trim().replace(/\s+/g, ' ');
  if (!normalizedPhrase || normalizedPhrase.length > 120) {
    throw new Error('Вариант статуса должен содержать от 1 до 120 символов');
  }

  {
    const category = getStatusCategory(categoryId);
    const systemPhrase = category.phrases.find((item) => item.toLowerCase() === normalizedPhrase.toLowerCase());
    if (action === 'remove' && systemPhrase) {
      await pool.query(
        `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = TRUE`,
        [categoryId, systemPhrase]
      );
    } else if (action === 'remove') {
      await pool.query(
        'DELETE FROM learned_phrases WHERE category_id = $1 AND LOWER(phrase) = LOWER($2)',
        [categoryId, normalizedPhrase]
      );
    } else {
      await pool.query(
        `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = FALSE`,
        [categoryId, normalizedPhrase]
      );
    }
    await loadLearnedPhrasesFromDb();
    return getEditableStatusCategories().find((category) => category.id === categoryId);
  }

}

async function renameLearnedPhrase(categoryId, oldPhrase, newPhrase) {
  if (!isPgConnected() || !pool) throw new Error('PostgreSQL не подключен');
  if (!getEditableStatusCategories().some((category) => category.id === categoryId)) {
    throw new Error('Неизвестная категория статуса');
  }
  const oldValue = String(oldPhrase || '').trim();
  const newValue = String(newPhrase || '').trim().replace(/\s+/g, ' ');
  if (!oldValue || !newValue || newValue.length > 120) {
    throw new Error('Вариант статуса должен содержать от 1 до 120 символов');
  }

  {
    const category = getStatusCategory(categoryId);
    const systemPhrase = category.phrases.find((item) => item.toLowerCase() === oldValue.toLowerCase());
    if (!systemPhrase && !getStatusPhrases(category).some((item) => item.toLowerCase() === oldValue.toLowerCase())) {
      throw new Error('Фраза не найдена');
    }
    if (systemPhrase) {
      await pool.query(
        `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = TRUE`,
        [categoryId, systemPhrase]
      );
    } else {
      await pool.query(
        'DELETE FROM learned_phrases WHERE category_id = $1 AND LOWER(phrase) = LOWER($2)',
        [categoryId, oldValue]
      );
    }
    await pool.query(
      `INSERT INTO learned_phrases (category_id, phrase, is_disabled)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (category_id, phrase) DO UPDATE SET is_disabled = FALSE`,
      [categoryId, newValue]
    );
    await loadLearnedPhrasesFromDb();
    return getEditableStatusCategories().find((category) => category.id === categoryId);
  }

}

const STATUS_CONFIG = {
  linkSent: {
    id: 'link_sent',
    name: 'Ссылка отправлена',
    description: 'Ссылка на регистрацию отправлена абоненту',
    phrases: [
      'silka yuborildi',
      'silka_yuborildi',
      'silka yuborilgan',
      'silka_yuborilgan',
      'yubordik',
      'sms yuborildi',
      'raqamga silka yuborildi',
    ],
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
      'povtoriy',
      'povtoran',
      'qayta malumot berildi',
      'qayta silka',
      'qayta yuborildi',
      'qayta yuborilgan',
      'yana silka',
      'yana yuborildi',
      'кайта малумот берилди',
      'кайта силка',
      'повторная ссылка',
      'повторно отправ',
      'повторный звон',
      'второй раз',
      'учирган кайта малумот берилди',
      'qayta qo`ngiroq',
      'qayta qongiroq',
      'qayta telefon',
      'qayta aloqa',
      'ikkinchi marta',
      'yana bir bor',
      'takror',
      'takroran',
      'takroriy',
      'перезвон',
      'перезвони',
      'еще раз',
      'ещё раз',
      'снова',
      'qayta malumot berildi',
      'qayta ma`lumot berildi',
      'qayta ma\'lumot berildi',
      'qayta aloqa',
      'qayta telefon',
      'qayta qo`ngiroq',
      'qayta qongiroq',
      'uchirgan qayta malumot berildi',
      'xato qilgan qayta urinadi',
    ],
    maxDistance: 2,
  },
  declined: {
    id: 'declined',
    name: 'Отказ',
    description: 'Абонент отказался или недоступен для регистрации',
    phrases: [
      'otkaz',
      'otkaz qildi',
      'otkaz kilidi',
      'отказ килди',
      'отказ қилди',
      'otlaz',
      'otkaxz',
      "foydalanmasligini aytdi",
      "vaqti yo'q",
      'vaqti yo`q',
      'vaqti yoq',
      "o'chirib qo'ydi",
      'o`chirib qo`ydi',
      'учириб куйди',
      'ishtirok etmagan',
      'sms ketmadi',
      "o'ylab ko'radi",
      'o`ylab ko`radi',
      'keyinroq',
      'keyinro',
      'yilida to`xtagan',
      'yilida toxtagan',
      'yashash hududida internet yaxshi emas',
      'yashash hudida internet yaxshi emas',
      'hozir oddiy tel ishlatadi',
      'hozir oddiy telfon ishlatyapti',
      'bot haqida xabari yo`q',
      'bot haqida xabari yoq',
      'botni shubhali bot deb o`ylab kirmagan',
      'botni shubhali deb o`ylagan',
      'botga ishonmagani uchun kirmagan',
      'silka orqali kirishni xohlamadi',
      'oila a`zolari ruxsat bermagan',
      'turmush o`rtog`i ruxsat bermagan',
      'telegrami spamda ekan',
      'sms ketmadi',
      'raqamga silka yuborib bo`lmadi',
      'perfectum raqamga yuborib bo`lmadi',
      'perfektum raqamga yuborib bo`lmadi',
      'kompaniya raqami',
      'korxona raqami',
      'ishxona raqami',
      'aptekani aloqa raqami',
      'karparativ raqam',
      'korporativ raqam',
      'o`chirib quydi',
      'boshqa bezovta qilmasligimizni aytdi',
      'kechroq',
      'kechro',
      '18 00 dan keyin',
      'yarimm soat',
      'raqamni kiritishga tushunmagan',
      'ro`yxatdan o`tishda raqamini kiritishga tushunmagan',
      'noma`lum silka xohlamadi',
      'ro`yxatdan o`tishda raqamini kiritishga tushunmagan',
      'o`chirdi',
      'otklyuchil',
      'vaqti yo`q',
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
      'botdan ro`yxatdan o`tgan',
      'botdan ro`yxatdan o`tdi',
      'botdan ro`yxatdan o`tish',
      'ro`yxatdan o`zi o`tadi',
      'ro`yxatdan o`zi o`tadi',
      'sms orqali ro`yxatdan o`tdi',
      'telegramdan kirdi',
      'o`zi sayt orqali tanishib chiqib kiradi',
      'o`zi ro`yxatdan o`tadi',
      'o`zi ro`yxatdan o`tib qo`yadi',
      'o`zi ro`yhatdan o`tishini aytdi',
      'botdan ro`yhatdan o`tdi',
      'botdan ro`yhatdan o`tdik',
      'botdan ro`yhatdan o`tgan',
      'botdan o`tdi',
      'botdan otti',
      'botdan ruyxatdan utgan',
      'botdan ruyxatdan utti',
      'ro`yxatdan o`tgan',
      'ro`yhatdan o`tgan',
      'o`tdi',
      'o`sha payt esidan chiqqan ro`yxatdan o`tib qo`yadi',
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
      'boshqa raqamlaridan ro`yxatdan o`tgan',
      'boshqa raqamidan ro`yxatdan o`tgan',
      'boshqa raqamdan ro`yxatdan otgan',
      'boshqa raqamidan botdan ro`yxatdan o`tgan',
      'boshqa raqamidan ro`yhatdan o`tgan',
      'raqam egasi boshqa',
      'raqam turmush o`rtog`iga tegishli',
      'singlisi foydalangan',
      'turmush o`rtog`i foydalangan',
      'bir xil raqam',
      'eski ishtirokchi o`tgan raqam',
      'raqam egasi boshqa xabari yo`q',
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
    'otkaz', 'foydalanmayman', 'ochirib', 'uchirib', 'otmen qildi', 'gaplashmoqchi emas',
    'бросил', 'отказ', 'нет времени', "vaqti yo'q", 'vaqti yoq', 'internet', 'shubhali',
    'ishxona', 'kompaniya', 'korxona', 'aptek', 'spam', 'ishlatmaydi'
  ],
  linkSent: [
    'silka', 'yuboril', 'yubordik', 'havola', 'отправлен', 'ссылк'
  ],
  repeatSent: [
    'povtor', 'qayta', 'yana', 'takror', 'ikkinchi',
    'повтор', 'повторн', 'перезвон', 'снов', 'кайта', 'такрор'
  ],
  alreadyRegistered: [
    'botdan'
  ],
  wrongPerson: [
    'notogri', 'notugri', 'adashgan', 'не тот', 'неправильн', 'чужой'
  ]
};

function containsRoot(text, root) {
  const normalizedRoot = normalizeText(root);
  if (!normalizedRoot) return false;
  if (normalizedRoot.includes(' ')) {
    return text.includes(normalizedRoot);
  }
  return text.split(' ').some((word) => word.startsWith(normalizedRoot));
}

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
        containsRoot(norm, root) ||
        containsRoot(latinNorm, root) ||
        containsRoot(collapsedNorm, root) ||
        containsRoot(collapsedLatin, root)
      ) {
        return true;
      }
    }
  }

  for (const phrase of getStatusPhrases(category)) {
    const normPhrase = normalizeText(phrase);
    if (!normPhrase) continue;
    const collapsedPhrase = collapseRepeatedChars(normPhrase);
    const latinPhrase = transliterateCyrillicToLatin(normPhrase);

    if (
      norm.includes(normPhrase) ||
      collapsedNorm.includes(collapsedPhrase) ||
      collapsedLatin.includes(collapsedPhrase) ||
      latinNorm.includes(latinPhrase)
    ) {
      return true;
    }

    const maxDist = category.maxDistance ?? 2;
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
  normalizeText,
  collapseRepeatedChars,
  levenshteinDistance,
  matchesCategory,
  loadLearnedPhrasesFromDb,
  getEditableStatusCategories,
  updateLearnedPhrase,
  renameLearnedPhrase,
  isLinkSentStatus,
  isRepeatSentStatus,
  isDeclinedStatus,
  isAlreadyRegisteredStatus,
  isWrongPersonStatus
};
