// worker/src/weather.ts
// ======================================
//  Free weather forecast – Open‑Meteo
//  (no API key, local‑time aligned)
// ======================================

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEZONE_URL = "https://api.open-meteo.com/v1/timezone";
const USER_AGENT = "Mozilla/5.0 (compatible; BaleWeatherBot/1.0)";

const WEATHER_ICONS: Record<number, string> = {
  0: "☀️ Clear",
  1: "🌤️ Mostly clear",
  2: "⛅ Partly cloudy",
  3: "☁️ Overcast",
  45: "🌫️ Fog",
  48: "🌫️ Rime fog",
  51: "🌦️ Light drizzle",
  53: "🌦️ Drizzle",
  55: "🌧️ Heavy drizzle",
  61: "🌧️ Light rain",
  63: "🌧️ Rain",
  65: "🌧️ Heavy rain",
  71: "❄️ Light snow",
  73: "❄️ Snow",
  75: "❄️ Heavy snow",
  77: "❄️ Snow grains",
  80: "🌧️ Light showers",
  81: "🌧️ Showers",
  82: "🌧️ Heavy showers",
  85: "❄️ Light snow showers",
  86: "❄️ Snow showers",
  95: "⛈️ Thunderstorm",
  96: "⛈️ Thunderstorm with hail",
  99: "⛈️ Severe thunderstorm",
};

function weatherIcon(code: number): string {
  return WEATHER_ICONS[code] || `❓ (code ${code})`;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`");
}

// ---------- Geocoding ----------
async function geocode(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  const results = data.results;
  if (!results || results.length === 0) return null;
  const r = results[0];
  return { lat: r.latitude, lon: r.longitude, name: r.name };
}

// ---------- Current local time (with fallback) ----------
async function fetchLocalTime(lat: number, lon: number): Promise<{ time: string; timezone: string } | null> {
  const url = `${TIMEZONE_URL}?latitude=${lat}&longitude=${lon}&timeformat=iso8601`;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (data && data.time && data.timezone) {
      return { time: data.time, timezone: data.timezone };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- Forecast ----------
async function fetchForecast(lat: number, lon: number): Promise<any | null> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: "temperature_2m,weathercode",
    daily: "temperature_2m_max,temperature_2m_min,weathercode",
    timezone: "auto",
    forecast_days: "7",
  });
  const url = `${FORECAST_URL}?${params.toString()}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  return resp.json();
}

// ---------- Helpers ----------
function extractHour(isoTime: string): string {
  const parts = isoTime.split("T");
  if (parts.length < 2) return "";
  const timePart = parts[1];
  const hour = timePart.split(":")[0];
  return hour.padStart(2, "0") + ":00";
}

export async function getWeatherReport(city: string): Promise<string> {
  const geo = await geocode(city);
  if (!geo) return "❌ Could not find that location. Please check the spelling.";

  const forecast = await fetchForecast(geo.lat, geo.lon);
  if (!forecast) return "❌ Failed to fetch weather data. Please try again later.";

  const { hourly, daily } = forecast;
  const times = hourly.time as string[];

  let startIndex = 0;
  let timezoneDisplay = "";

  // Try to get exact local time
  const localTime = await fetchLocalTime(geo.lat, geo.lon);
  if (localTime) {
    // Parse the ISO time with offset, strip to local time string
    const currentIso = localTime.time.replace(/[+-]\d{2}:\d{2}$/, "").replace(/\.\d+Z?$/, "");
    const currentHourPrefix = currentIso.substring(0, 13); // "2026-04-27T13"
    for (let i = 0; i < times.length; i++) {
      if (times[i].substring(0, 13) >= currentHourPrefix) {
        startIndex = i;
        break;
      }
    }
    timezoneDisplay = `🕒 Local time: ${localTime.timezone}\n\n`;
  } else {
    // Fallback: use UTC to approximate (assume forecast times are local, and we use the first entry as "now")
    // Actually just start from index 0 – the forecast's first hour is usually the current hour in that timezone.
    // We'll add a note that time could not be verified.
    timezoneDisplay = "⚠️ Could not verify local time; showing the latest available update.\n\n";
  }

  const next24 = times.slice(startIndex, startIndex + 24);
  const temps = hourly.temperature_2m.slice(startIndex, startIndex + 24);
  const codes = hourly.weathercode.slice(startIndex, startIndex + 24);

  let msg = `🌍 *Weather for ${escapeMarkdown(geo.name)}* (${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)})\n`;
  msg += timezoneDisplay;

  // Hourly
  msg += "🕐 *Hourly (next 24 h):*\n";
  for (let i = 0; i < next24.length; i++) {
    const hour = extractHour(next24[i]);
    const temp = temps[i].toFixed(1);
    const icon = weatherIcon(codes[i]);
    msg += `┃ ${hour}  ${temp}°C  ${icon}\n`;
  }

  // Daily
  msg += "\n📅 *Daily (7‑day forecast):*\n";
  const dLen = Math.min(daily.time.length, 7);
  for (let i = 0; i < dLen; i++) {
    const date = new Date(daily.time[i] + "T00:00");
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    const monthDay = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const max = daily.temperature_2m_max[i].toFixed(1);
    const min = daily.temperature_2m_min[i].toFixed(1);
    const icon = weatherIcon(daily.weathercode[i]);
    msg += `┃ ${dayName} ${monthDay}  🔼${max}°C  🔽${min}°C  ${icon}\n`;
  }

  return msg;
}
