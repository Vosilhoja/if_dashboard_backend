const { subDays } = require('date-fns');
const { fetchAllRowsForSheet, clearSheetCache } = require('./googleSheets');
const { formatDateToISO } = require('../utils/dateUtils');

function binAge(age) {
  if (age === null || age === undefined || isNaN(age)) return null;
  if (age < 18) return 'До 18';
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 49) return '35-49';
  return '50+';
}

function aggregateByGender(rows) {
  const result = { 'Мужской': 0, 'Женский': 0 };
  for (const row of rows) {
    if (row.gender === 'Мужской' || row.gender === 'Женский') {
      result[row.gender]++;
    }
  }
  return result;
}

function aggregateByAge(rows) {
  const bins = {
    'До 18': { 'Мужской': 0, 'Женский': 0 },
    '18-24': { 'Мужской': 0, 'Женский': 0 },
    '25-34': { 'Мужской': 0, 'Женский': 0 },
    '35-49': { 'Мужской': 0, 'Женский': 0 },
    '50+': { 'Мужской': 0, 'Женский': 0 },
  };

  let sum = 0;
  let count = 0;

  for (const row of rows) {
    if (row.age !== null && !isNaN(row.age) && row.age > 0 && row.age < 120) {
      sum += row.age;
      count++;
      const bin = binAge(row.age);
      if (row.gender === 'Мужской' || row.gender === 'Женский') {
        bins[bin][row.gender]++;
      }
    }
  }

  return {
    bins,
    averageAge: count > 0 ? +(sum / count).toFixed(1) : null,
  };
}

function aggregateByCategory(rows, field) {
  const counts = {};
  for (const row of rows) {
    const val = row[field] || 'Не указано';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function aggregateByRegionHierarchy(rows) {
  const regions = {};
  for (const row of rows) {
    const reg = row.region || 'Не указан';
    const dist = row.district || 'Не указан';
    const gender = row.gender || 'Не указан';

    if (!regions[reg]) {
      regions[reg] = {
        total: 0,
        districts: {},
        genders: { 'Мужской': 0, 'Женский': 0 },
      };
    }

    regions[reg].total++;
    if (gender === 'Мужской' || gender === 'Женский') {
      regions[reg].genders[gender]++;
    }

    if (!regions[reg].districts[dist]) {
      regions[reg].districts[dist] = {
        total: 0,
        genders: { 'Мужской': 0, 'Женский': 0 },
      };
    }
    regions[reg].districts[dist].total++;
    if (gender === 'Мужской' || gender === 'Женский') {
      regions[reg].districts[dist].genders[gender]++;
    }
  }
  return regions;
}

function aggregateMonthlyDynamics(rows) {
  const months = {};
  for (const row of rows) {
    if (!row.creationDate) continue;
    const m = row.creationDate.slice(0, 7); // YYYY-MM
    if (m.length === 7) {
      months[m] = (months[m] || 0) + 1;
    }
  }

  return Object.keys(months)
    .sort()
    .map((month) => ({
      month,
      count: months[month],
    }));
}

function aggregateTopCrossCombinations(rows) {
  const pairs = {};
  for (const row of rows) {
    const edu = row.education || 'Не указано';
    const prof = row.profession || 'Не указана';
    const key = `${edu} + ${prof}`;
    pairs[key] = (pairs[key] || 0) + 1;
  }

  return Object.entries(pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([combination, count]) => ({ combination, count }));
}

async function getAnalyticsData(query = {}) {
  const { startDate = '', endDate = '', refresh = false } = query;

  if (refresh) {
    clearSheetCache();
  }

  const mainRows = await fetchAllRowsForSheet('main', refresh);

  const allRows = new Array(mainRows.length);
  let emptyPhone = 0;
  let emptyRegion = 0;
  let emptyAge = 0;
  let emptyEducation = 0;
  let emptyProfession = 0;

  const today = new Date();
  const todayISO = formatDateToISO(today);
  const date7DaysAgo = formatDateToISO(subDays(today, 7));
  const date30DaysAgo = formatDateToISO(subDays(today, 30));

  let rolling7DaysCount = 0;
  let rolling30DaysCount = 0;

  for (let i = 0; i < mainRows.length; i++) {
    const r = mainRows[i];
    const phone = r['Phone'];
    const region = r['Регион'] || 'Не указан';
    const district = r['Район'] || r['Город'] || 'Не указан';
    const genderRaw = r['Пол'];
    const gender = genderRaw === 'Мужской' || genderRaw === 'Женский' ? genderRaw : null;
    const education = r['Оброзование'] || 'Не указано';
    const profession = r['Профессия'] || 'Не указана';
    const source = r['Откуда пришёл пользователь'] || 'Не указано';
    const rawAgeStr = r['Возраст'] || '';
    const ageNum = parseInt(rawAgeStr, 10);
    const age = !isNaN(ageNum) && ageNum > 0 && ageNum < 120 ? ageNum : null;

    let creationDate = r['Дата создания'] || r['date'] || r['Дата'] || '';
    if (creationDate) {
      const parts = creationDate.split(/[T\s]/)[0].split(/[./-]/);
      if (parts.length === 3) {
        if (parts[0].length === 4) {
          creationDate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
        } else {
          creationDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
      }
    }

    if (!phone) emptyPhone++;
    if (!r['Регион']) emptyRegion++;
    if (!r['Возраст']) emptyAge++;
    if (!r['Оброзование']) emptyEducation++;
    if (!r['Профессия']) emptyProfession++;

    if (creationDate) {
      if (creationDate >= date7DaysAgo && creationDate <= todayISO) {
        rolling7DaysCount++;
      }
      if (creationDate >= date30DaysAgo && creationDate <= todayISO) {
        rolling30DaysCount++;
      }
    }

    allRows[i] = {
      region,
      district,
      gender,
      age,
      education,
      profession,
      source,
      creationDate,
    };
  }

  const rows =
    startDate && endDate
      ? allRows.filter((r) => {
          if (!r.creationDate) return true;
          return r.creationDate >= startDate && r.creationDate <= endDate;
        })
      : allRows;

  const genderCount = aggregateByGender(rows);
  const { bins: ageBins, averageAge } = aggregateByAge(rows);
  const educationCount = aggregateByCategory(rows, 'education');
  const sourceCount = aggregateByCategory(rows, 'source');
  const professionCount = aggregateByCategory(rows, 'profession');
  const byRegionGender = aggregateByRegionHierarchy(rows);
  const monthlyDynamics = aggregateMonthlyDynamics(rows);
  const topPairs = aggregateTopCrossCombinations(rows);

  return {
    rows,
    allRowsCount: allRows.length,
    periodRowsCount: rows.length,
    rolling7DaysCount,
    rolling30DaysCount,
    byRegionGender,
    genderCount,
    educationCount,
    sourceCount,
    professionCount,
    ageBins,
    averageAge,
    monthlyDynamics,
    topPairs,
    dataQuality: {
      emptyPhone,
      emptyRegion,
      emptyAge,
      emptyEducation,
      emptyProfession,
      totalRows: mainRows.length,
    },
    period: {
      startDate,
      endDate,
    },
    cachedAt: new Date().toISOString(),
  };
}

module.exports = {
  getAnalyticsData
};
