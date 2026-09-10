/**
 * Phone normalization and diagnostics utility
 */

function looksLikeCorruptedScientific(raw) {
  const str = String(raw);
  if (/e\+?\d+/i.test(str)) return true;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) && raw > 1e14) return true;
    if (raw > 1e14) return true;
  }
  return false;
}

function isAllSameDigit(digits) {
  return digits.length > 0 && digits.split('').every((d) => d === digits[0]);
}

function normalizePhoneWithDiagnostics(rawPhone) {
  const original = rawPhone === null || rawPhone === undefined ? '' : String(rawPhone);

  if (!rawPhone && rawPhone !== 0) {
    return { normalized: '', status: 'invalid', country: 'UNKNOWN', original };
  }

  if (looksLikeCorruptedScientific(rawPhone)) {
    return { normalized: '', status: 'corrupted_scientific', country: 'UNKNOWN', original };
  }

  let digits = original.replace(/\D/g, '');

  if (!digits || digits.length <= 8 || isAllSameDigit(digits)) {
    return { normalized: '', status: 'invalid', country: 'UNKNOWN', original };
  }

  // UZBEKISTAN PRIORITY RULES
  if (digits.length === 9) {
    if (digits.startsWith('998')) {
      return { normalized: '', status: 'truncated', country: 'UZ', original };
    }
    return { normalized: '998' + digits, status: 'ok', country: 'UZ', original };
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    return { normalized: '998' + digits.slice(1), status: 'ok', country: 'UZ', original };
  }

  if (digits.length === 12 && digits.startsWith('998')) {
    return { normalized: digits, status: 'ok', country: 'UZ', original };
  }

  if (digits.length === 11) {
    if (digits.startsWith('8998') || digits.startsWith('998')) {
      return { normalized: '', status: 'truncated', country: 'UZ', original };
    }
  }

  if (digits.length === 13 || digits.length === 14) {
    if (digits.startsWith('8998') && digits.length === 13) {
      return { normalized: digits.slice(1), status: 'ok', country: 'UZ', original };
    }
    if (digits.startsWith('998998')) {
      return { normalized: digits.slice(3), status: 'ok', country: 'UZ', original };
    }
  }

  // Russia & Kazakhstan (+7)
  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    const subscriber = digits.slice(1);
    const isKZ = /^[67]/.test(subscriber);
    return {
      normalized: '7' + subscriber,
      status: 'foreign',
      country: isKZ ? 'KZ' : 'RU',
      original,
    };
  }

  if (digits.length === 10 && !digits.startsWith('0')) {
    const isKZ = /^[67]/.test(digits);
    return {
      normalized: '7' + digits,
      status: 'foreign',
      country: isKZ ? 'KZ' : 'RU',
      original,
    };
  }

  // Ukraine (+380)
  if (digits.length === 12 && digits.startsWith('380')) {
    return { normalized: digits, status: 'foreign', country: 'UA', original };
  }

  // USA (+1)
  if (digits.length === 11 && digits.startsWith('1')) {
    return { normalized: digits, status: 'foreign', country: 'US', original };
  }

  if (digits.length >= 9 && digits.length <= 15) {
    return { normalized: digits, status: 'foreign', country: 'UNKNOWN', original };
  }

  return { normalized: '', status: 'invalid', country: 'UNKNOWN', original };
}

function normalizePhone(rawPhone) {
  return normalizePhoneWithDiagnostics(rawPhone).normalized;
}

module.exports = {
  normalizePhoneWithDiagnostics,
  normalizePhone
};
