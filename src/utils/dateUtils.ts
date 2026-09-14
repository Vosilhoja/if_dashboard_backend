/**
 * Date parsing and range utility
 */

function parseSheetDate(rawDate) {
  if (!rawDate) return null;
  if (rawDate instanceof Date) {
    return isNaN(rawDate.getTime()) ? null : rawDate;
  }

  const str = String(rawDate).trim();
  if (!str) return null;

  // Handle DD.MM.YYYY or DD.MM.YYYY HH:mm:ss or DD.MM.YYYY HH:mm
  const dotParts = str.split(' ')[0].split('.');
  if (dotParts.length === 3) {
    const day = parseInt(dotParts[0], 10);
    const month = parseInt(dotParts[1], 10) - 1;
    let year = parseInt(dotParts[2], 10);
    if (year < 100) year += 2000;

    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  // Handle YYYY-MM-DD
  const dashParts = str.split('T')[0].split('-');
  if (dashParts.length === 3 && dashParts[0].length === 4) {
    const year = parseInt(dashParts[0], 10);
    const month = parseInt(dashParts[1], 10) - 1;
    const day = parseInt(dashParts[2], 10);
    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  // Fallback to Date.parse
  const timestamp = Date.parse(str);
  if (!isNaN(timestamp)) {
    const d = new Date(timestamp);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  return null;
}

function isDateInRange(targetDate, startDateStr, endDateStr) {
  if (!targetDate) return false;

  const targetTime = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  ).getTime();

  if (startDateStr) {
    const start = parseSheetDate(startDateStr);
    if (start) {
      const startTime = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate()
      ).getTime();
      if (targetTime < startTime) return false;
    }
  }

  if (endDateStr) {
    const end = parseSheetDate(endDateStr);
    if (end) {
      const endTime = new Date(
        end.getFullYear(),
        end.getMonth(),
        end.getDate()
      ).getTime();
      if (targetTime > endTime) return false;
    }
  }

  return true;
}

function formatDateToISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  parseSheetDate,
  isDateInRange,
  formatDateToISO
};
