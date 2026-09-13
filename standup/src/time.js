const bangkokFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(now) {
  return Object.fromEntries(
    bangkokFormatter.formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
}

export function bangkokNow(now = new Date()) {
  const value = parts(now);
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour),
    minute: Number(value.minute),
  };
}

export function isoDateFromInstant(value) {
  return bangkokNow(new Date(value)).date;
}

export function dateRange(start, end) {
  if (!start || !end || start > end) return [];
  const dates = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const final = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= final) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function displayDate(value) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(`${value}T00:00:00.000Z`));
}
