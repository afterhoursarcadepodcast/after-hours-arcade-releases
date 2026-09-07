import { readFile, writeFile } from 'node:fs/promises';

const clientId = process.env.IGDB_CLIENT_ID?.trim();
const clientSecret = process.env.IGDB_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  throw new Error('IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are required.');
}

const platformMap = new Map([
  ['PC (Microsoft Windows)', 'PC'],
  ['PlayStation 4', 'PlayStation 4'],
  ['PlayStation 5', 'PlayStation 5'],
  ['Xbox One', 'Xbox One'],
  ['Xbox Series X|S', 'Xbox Series X|S'],
  ['Nintendo Switch', 'Nintendo Switch'],
  ['Nintendo Switch 2', 'Nintendo Switch 2'],
]);

const platformIdMap = new Map([
  [6, 'PC'],
  [48, 'PlayStation 4'],
  [49, 'Xbox One'],
  [130, 'Nintendo Switch'],
  [167, 'PlayStation 5'],
  [169, 'Xbox Series X|S'],
]);

const platformOrder = [
  'PC',
  'PlayStation 4',
  'PlayStation 5',
  'Xbox One',
  'Xbox Series X|S',
  'Nintendo Switch',
  'Nintendo Switch 2',
];

function mondayWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function displayDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toUpperCase();
}

function windowLabel(start, end) {
  const startMonth = start.toLocaleDateString('en-US', { month: 'long' });
  const endMonth = end.toLocaleDateString('en-US', { month: 'long' });
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startMonth} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${startMonth} ${start.getDate()}–${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()}, ${start.getFullYear()}–${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
}

function normalizeTitle(title) {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanDescription(value) {
  if (!value) return undefined;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 240) return text;
  const clipped = text.slice(0, 239);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 160 ? lastSpace : clipped.length)}…`;
}

function websiteUrl(websites = []) {
  const urls = websites
    .map((item) => item?.url)
    .filter(Boolean)
    .map((url) => url.startsWith('//') ? `https:${url}` : url)
    .filter((url) => url.startsWith('https://'));
  const priorities = [
    'store.steampowered.com',
    'playstation.com',
    'xbox.com',
    'nintendo.com',
  ];
  return priorities.map((host) => urls.find((url) => url.includes(host))).find(Boolean)
    || urls[0];
}

function decodeHtml(value = '') {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function steamDate(value) {
  const parsed = new Date(`${decodeHtml(value)} 12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function excludedSteamTitle(title) {
  return /(?:\bdemo\b|\bprologue\b|\bprototype\b|\bplaytest\b|\bbeta\b|\btest server\b|\bsoundtrack\b)/i.test(title);
}

async function steamSearchPage(startOffset) {
  const url = new URL('https://store.steampowered.com/search/results/');
  url.searchParams.set('start', String(startOffset));
  url.searchParams.set('count', '100');
  url.searchParams.set('sort_by', '_ASC');
  url.searchParams.set('filter', 'comingsoon');
  url.searchParams.set('category1', '998');
  url.searchParams.set('os', 'win');
  url.searchParams.set('supportedlang', 'english');
  url.searchParams.set('infinite', '1');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'AfterHoursArcadePodcast/1.0' },
  });
  if (!response.ok) throw new Error(`Steam search failed (${response.status}).`);
  return response.json();
}

function parseSteamRows(html, start, end) {
  const rows = [];
  const rowPattern = /<a\b[^>]*class=["'][^"']*search_result_row[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const row = match[0];
    const appId = row.match(/data-ds-appid=["'](\d+)["']/i)?.[1];
    const href = row.match(/href=["']([^"']+)["']/i)?.[1]?.replaceAll('&amp;', '&');
    const title = decodeHtml(row.match(/<span\b[^>]*class=["']title["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const date = steamDate(row.match(/<div\b[^>]*class=["'][^"']*search_released[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
    if (!appId || !href || !title || !date || date < start || date > end || excludedSteamTitle(title)) continue;
    rows.push({ appId, href, title, releaseDate: date });
  }
  return rows;
}

async function steamAppDetails(appId) {
  const response = await fetch(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&l=english&cc=us`,
    { headers: { 'User-Agent': 'AfterHoursArcadePodcast/1.0' } },
  );
  if (!response.ok) return null;
  const payload = await response.json();
  return payload[appId]?.success ? payload[appId].data : null;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function steamReleases(start, end) {
  const rows = [];
  let total = 100;
  for (let offset = 0; offset < total && offset < 2000; offset += 100) {
    const page = await steamSearchPage(offset);
    total = Number(page.total_count) || 0;
    rows.push(...parseSteamRows(page.results_html || '', start, end));
    if (!page.results_html) break;
  }
  const unique = [...new Map(rows.map((row) => [row.appId, row])).values()];
  return mapConcurrent(unique, 12, async (row) => {
    const details = await steamAppDetails(row.appId);
    if (details && details.type !== 'game') return null;
    return {
      date: displayDate(row.releaseDate),
      isoDate: isoDate(row.releaseDate),
      title: row.title,
      platforms: ['PC'],
      href: row.href,
      description: cleanDescription(details?.short_description),
      artwork: details?.header_image || details?.capsule_image,
      major: false,
    };
  });
}

async function twitchToken() {
  const url = new URL('https://id.twitch.tv/oauth2/token');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('grant_type', 'client_credentials');
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) throw new Error(`Twitch authentication failed (${response.status}).`);
  const payload = await response.json();
  return payload.access_token;
}

async function igdbPage(token, startUnix, endUnix, offset) {
  const query = [
    'fields date,platform.name,game.name,game.summary,game.category,game.cover.image_id,game.url,game.websites.url,game.hypes,game.follows;',
    `where date >= ${startUnix} & date <= ${endUnix};`,
    'sort date asc;',
    'limit 500;',
    `offset ${offset};`,
  ].join(' ');
  const response = await fetch('https://api.igdb.com/v4/release_dates', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Client-ID': clientId,
      Authorization: `Bearer ${token}`,
    },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`IGDB release lookup failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function igdbReleases(start, end) {
  const token = await twitchToken();
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(end.getTime() / 1000);
  const results = [];
  for (let offset = 0; ; offset += 500) {
    const page = await igdbPage(token, startUnix, endUnix, offset);
    results.push(...page);
    if (page.length < 500) break;
  }
  return results;
}

function mergeRelease(map, release) {
  const key = normalizeTitle(release.title);
  if (!key) return;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...release, platforms: [...release.platforms] });
    return;
  }
  existing.platforms = [...new Set([...existing.platforms, ...release.platforms])];
  existing.description ||= release.description;
  existing.artwork ||= release.artwork;
  existing.href ||= release.href;
  existing.major ||= release.major;
}

const { start, end } = mondayWindow();
const records = await igdbReleases(start, end);
console.log(`IGDB returned ${records.length} dated platform records.`);
const merged = new Map();

for (const record of records) {
  const category = record.game?.category;
  if (typeof category === 'number' && ![0, 4, 8, 9, 10, 11].includes(category)) continue;
  const platformId = typeof record.platform === 'number'
    ? record.platform
    : record.platform?.id;
  const platform = platformMap.get(record.platform?.name) || platformIdMap.get(platformId);
  if (!platform || !record.game?.name || !record.date) continue;
  const releaseDate = new Date(record.date * 1000);
  mergeRelease(merged, {
    date: displayDate(releaseDate),
    isoDate: isoDate(releaseDate),
    title: record.game.name,
    platforms: [platform],
    href: websiteUrl(record.game.websites) || record.game.url || 'https://www.igdb.com/',
    description: cleanDescription(record.game.summary),
    artwork: record.game.cover?.image_id
      ? `https://images.igdb.com/igdb/image/upload/t_1080p/${record.game.cover.image_id}.jpg`
      : undefined,
    major: (record.game.hypes || 0) >= 20 || (record.game.follows || 0) >= 100,
  });
}

try {
  const steamRecords = await steamReleases(start, end);
  const validSteamRecords = steamRecords.filter(Boolean);
  console.log(`Steam returned ${validSteamRecords.length} full-game releases for this week.`);
  for (const release of validSteamRecords) mergeRelease(merged, release);
} catch (error) {
  console.warn(`Steam enrichment was unavailable: ${error instanceof Error ? error.message : error}`);
}

const overrides = JSON.parse(await readFile(new URL('../data/manual-overrides.json', import.meta.url), 'utf8'));
for (const release of overrides.releases || []) {
  if (!release.isoDate || release.isoDate < isoDate(start) || release.isoDate > isoDate(end)) continue;
  mergeRelease(merged, {
    ...release,
    date: release.date || displayDate(new Date(`${release.isoDate}T12:00:00`)),
    platforms: Array.isArray(release.platforms)
      ? release.platforms
      : String(release.platforms || '').split(' · ').filter(Boolean),
  });
}

const releases = [...merged.values()]
  .map((release) => ({
    ...release,
    platforms: release.platforms
      .sort((a, b) => platformOrder.indexOf(a) - platformOrder.indexOf(b))
      .join(' · '),
  }))
  .sort((a, b) => a.isoDate.localeCompare(b.isoDate) || a.title.localeCompare(b.title));

if (!releases.length) {
  throw new Error('No releases were found; preserving the previous public feed.');
}

const payload = {
  generatedAt: new Date().toISOString(),
  weekStart: isoDate(start),
  windowLabel: windowLabel(start, end),
  sources: [
    { name: 'IGDB release dates', href: 'https://www.igdb.com/' },
    { name: 'Steam upcoming releases', href: 'https://store.steampowered.com/search/?category1=998&filter=comingsoon' },
    { name: 'Linked official and storefront pages', href: 'https://www.igdb.com/api' },
  ],
  releases,
};

await writeFile(
  new URL('../data/weekly-releases.json', import.meta.url),
  `${JSON.stringify(payload, null, 2)}\n`,
  'utf8',
);

console.log(`Wrote ${releases.length} releases for ${payload.windowLabel}.`);
