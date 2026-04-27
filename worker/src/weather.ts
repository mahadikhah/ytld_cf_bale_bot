// worker/src/weather.ts
// ======================================
//  Free weather forecast – Open‑Meteo
//  (paginated, night‑aware, extra data)
// ======================================

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "Mozilla/5.0 (compatible; BaleWeatherBot/1.0)";

const DAY_ICONS: Record<number, string> = {
  0: "☀️ Clear", 1: "🌤️ Mostly clear", 2: "⛅ Partly cloudy", 3: "☁️ Overcast",
  45: "🌫️ Fog", 48: "🌫️ Rime fog",
  51: "🌦️ Light drizzle", 53: "🌦️ Drizzle", 55: "🌧️ Heavy drizzle",
  61: "🌧️ Light rain", 63: "🌧️ Rain", 65: "🌧️ Heavy rain",
  71: "❄️ Light snow", 73: "❄️ Snow", 75: "❄️ Heavy snow", 77: "❄️ Snow grains",
  80: "🌧️ Light showers", 81: "🌧️ Showers", 82: "🌧️ Heavy showers",
  85: "❄️ Light snow showers", 86: "❄️ Snow showers",
  95: "⛈️ Thunderstorm", 96: "⛈️ Thunderstorm with hail", 99: "⛈️ Severe thunderstorm",
};

const NIGHT_ICONS: Record<number, string> = {
  0: "🌙 Clear", 1: "🌙 Mostly clear",
};

function weatherIcon(code: number, isNight: boolean): string {
  if (isNight && NIGHT_ICONS[code]) return NIGHT_ICONS[code];
  return DAY_ICONS[code] || `❓(${code})`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_\[\]()~`]/g, '\\$&');
}

// ---------- Geocoding ----------
async function geocode(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  const r = data?.results?.[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, name: r.name };
}

// ---------- Forecast fetch (now + hourly + daily) ----------
async function fetchForecast(lat: number, lon: number): Promise<any | null> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current_weather: "true",
    hourly: "temperature_2m,weathercode,precipitation_probability,windspeed_10m",
    daily: "temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset",
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
  return parts[1].split(":")[0].padStart(2, "0") + ":00";
}

function isDaytime(time: string, sunrise: string, sunset: string): boolean {
  return time >= sunrise && time < sunset;
}

// ---------- Main export (now with offset) ----------
export async function getWeatherReport(
  city: string,
  pageOffset = 0
): Promise<{ text: string; keyboard: any[][] } | null> {
  const geo = await geocode(city);
  if (!geo) return null;

  const fc = await fetchForecast(geo.lat, geo.lon);
  if (!fc) return null;

  const currentTime = fc.current_weather?.time; // ISO local, e.g. "2026-04-27T14:00"
  const timezone = fc.timezone || "local";
  const hourly = fc.hourly;
  const daily = fc.daily;

  // Build sunrise/sunset map
  const dayMap: Record<string, { sunrise: string; sunset: string }> = {};
  for (let i = 0; i < daily.time.length; i++) {
    dayMap[daily.time[i]] = {
      sunrise: daily.sunrise[i],
      sunset: daily.sunset[i],
    };
  }

  // Find start index for current hour (offset 0)
  let baseIndex = 0;
  if (currentTime) {
    const prefix = currentTime.substring(0, 13);
    for (let i = 0; i < hourly.time.length; i++) {
      if (hourly.time[i].substring(0, 13) >= prefix) {
        baseIndex = i;
        break;
      }
    }
  }

  const startIndex = baseIndex + pageOffset * 24;
  const endIndex = Math.min(startIndex + 24, hourly.time.length);

  if (startIndex >= hourly.time.length) {
    return { text: "No more forecast data available.", keyboard: [] };
  }

  // Slice data
  const times = hourly.time.slice(startIndex, endIndex);
  const temps = hourly.temperature_2m.slice(startIndex, endIndex);
  const codes = hourly.weathercode.slice(startIndex, endIndex);
  const precip = hourly.precipitation_probability?.slice(startIndex, endIndex) ?? [];
  const wind = hourly.windspeed_10m?.slice(startIndex, endIndex) ?? [];

  // Build message
  let text = `🌍 *${escapeMarkdown(geo.name)}* (${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)})\n`;
  text += `🕒 ${timezone}\n\n`;
  text += `🕐 *Hourly (${times.length} h)*\n`;

  for (let i = 0; i < times.length; i++) {
    const hour = extractHour(times[i]);
    const temp = temps[i].toFixed(1);
    const code = codes[i];
    const datePart = times[i].substring(0, 10);
    const dayInfo = dayMap[datePart];
    const night = dayInfo ? !isDaytime(times[i], dayInfo.sunrise, dayInfo.sunset) : true;
    const icon = weatherIcon(code, night);

    const rainStr = precip.length ? ` 💧${precip[i]}%` : "";
    const windStr = wind.length ? ` 💨${wind[i].toFixed(1)}km/h` : "";

    text += `┃ ${hour}  ${temp}°C  ${icon}${rainStr}${windStr}\n`;
  }

  // Daily summary (compact)
  text += "\n📅 *7‑day Outlook*\n";
  for (let i = 0; i < Math.min(daily.time.length, 7); i++) {
    const date = new Date(daily.time[i] + "T00:00");
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    const mmdd = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const max = daily.temperature_2m_max[i].toFixed(1);
    const min = daily.temperature_2m_min[i].toFixed(1);
    const icon = weatherIcon(daily.weathercode[i], false);
    text += `┃ ${dayName} ${mmdd}  🔼${max}°  🔽${min}°  ${icon}\n`;
  }

  // Pagination keyboard
  const totalAvailHours = hourly.time.length;
  const maxOffset = Math.floor((totalAvailHours - baseIndex - 1) / 24);
  const hasPrev = pageOffset > 0;
  const hasNext = pageOffset < maxOffset;

  const navRow: any[] = [];
  if (hasPrev) navRow.push({ text: "⬅️ Previous 24h", callback_data: `weather|${encodeURIComponent(city)}|${pageOffset - 1}` });
  if (hasNext) navRow.push({ text: "Next 24h ➡️", callback_data: `weather|${encodeURIComponent(city)}|${pageOffset + 1}` });

  const keyboard = navRow.length ? [navRow] : [];
  return { text, keyboard };
}
