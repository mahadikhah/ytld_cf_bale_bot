// worker/src/weather.ts
// ======================================
//  Free weather forecast – Open‑Meteo
//  (no API key, night‑aware icons)
// ======================================

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "Mozilla/5.0 (compatible; BaleWeatherBot/1.0)";

// Daytime icons (WMO code → text)
const DAY_ICONS: Record<number, string> = {
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

// Night‑time variations for clear / mostly clear
const NIGHT_ICONS: Record<number, string> = {
  0: "🌙 Clear",
  1: "🌙 Mostly clear",
};

function weatherIcon(code: number, isNight: boolean): string {
  if (isNight && NIGHT_ICONS[code]) return NIGHT_ICONS[code];
  return DAY_ICONS[code] || `❓ (code ${code})`;
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

// ---------- Forecast (includes current weather + sunrise/sunset) ----------
async function fetchForecast(lat: number, lon: number): Promise<any | null> {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current_weather: "true",
    hourly: "temperature_2m,weathercode",
    daily: "temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset",
    timezone: "auto",
    forecast_days: "7",
  });
  const url = `${FORECAST_URL}?${params.toString()}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) return null;
  return resp.json();
}

// ---------- Time helpers ----------
function extractHour(isoTime: string): string {
  const parts = isoTime.split("T");
  if (parts.length < 2) return "";
  const timePart = parts[1]; // "13:00" or "13:00:00"
  const hour = timePart.split(":")[0];
  return hour.padStart(2, "0") + ":00";
}

/** Returns true if `time` (ISO local) is between sunrise and sunset of the same day. */
function isDaytime(time: string, sunrise: string, sunset: string): boolean {
  // time, sunrise, sunset are in local ISO format "2026-04-27T13:00"
  return time >= sunrise && time < sunset;
}

export async function getWeatherReport(city: string): Promise<string> {
  const geo = await geocode(city);
  if (!geo) return "❌ Could not find that location. Please check the spelling.";

  const forecast = await fetchForecast(geo.lat, geo.lon);
  if (!forecast) return "❌ Failed to fetch weather data. Please try again later.";

  // Current time from forecast
  const currentTime = forecast.current_weather?.time; // ISO local time, e.g. "2026-04-27T14:00"
  const timezone = forecast.timezone || "local time";
  
  // Daily data (sunrise/sunset)
  const daily = forecast.daily;
  const sunriseTimes: string[] = daily.sunrise; // array of ISO times
  const sunsetTimes: string[] = daily.sunset;

  // Build a map from date prefix ("2026-04-27") to { sunrise, sunset }
  const dayMap: Record<string, { sunrise: string; sunset: string }> = {};
  for (let i = 0; i < daily.time.length; i++) {
    const dateStr = daily.time[i]; // "2026-04-27"
    dayMap[dateStr] = {
      sunrise: sunriseTimes[i],
      sunset: sunsetTimes[i],
    };
  }

  // Hourly data
  const times: string[] = forecast.hourly.time;
  const temps: number[] = forecast.hourly.temperature_2m;
  const codes: number[] = forecast.hourly.weathercode;

  // Find start index matching current hour
  let startIndex = 0;
  if (currentTime) {
    const currentHourPrefix = currentTime.substring(0, 13); // "2026-04-27T14"
    for (let i = 0; i < times.length; i++) {
      if (times[i].substring(0, 13) >= currentHourPrefix) {
        startIndex = i;
        break;
      }
    }
  }

  const next24 = times.slice(startIndex, startIndex + 24);
  const nextTemps = temps.slice(startIndex, startIndex + 24);
  const nextCodes = codes.slice(startIndex, startIndex + 24);

  let msg = `🌍 *Weather for ${escapeMarkdown(geo.name)}* (${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)})\n`;
  msg += `🕒 Timezone: ${timezone}\n\n`;

  // Hourly
  msg += "🕐 *Hourly (next 24 h):*\n";
  for (let i = 0; i < next24.length; i++) {
    const time = next24[i];
    const hour = extractHour(time);
    const temp = nextTemps[i].toFixed(1);
    const code = nextCodes[i];

    // Determine day/night based on the date of this hour
    const datePart = time.substring(0, 10); // "2026-04-27"
    const dayInfo = dayMap[datePart];
    let night = true; // default night if no info
    if (dayInfo) {
      night = !isDaytime(time, dayInfo.sunrise, dayInfo.sunset);
    }
    const icon = weatherIcon(code, night);
    msg += `┃ ${hour}  ${temp}°C  ${icon}\n`;
  }

  // Daily (7‑day)
  msg += "\n📅 *Daily (7‑day forecast):*\n";
  const dLen = Math.min(daily.time.length, 7);
  for (let i = 0; i < dLen; i++) {
    const date = new Date(daily.time[i] + "T00:00");
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    const monthDay = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const max = daily.temperature_2m_max[i].toFixed(1);
    const min = daily.temperature_2m_min[i].toFixed(1);
    // For daily summary we use the weather code which is daytime by convention, so we show the day icon.
    const icon = weatherIcon(daily.weathercode[i], false);
    msg += `┃ ${dayName} ${monthDay}  🔼${max}°C  🔽${min}°C  ${icon}\n`;
  }

  return msg;
}
