// worker/src/weather.ts
// ======================================
//  Free weather forecast – Open‑Meteo
//  (no API key required)
// ======================================

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const USER_AGENT = "Mozilla/5.0 (compatible; BaleWeatherBot/1.0)";

// WMO weather codes → simple icons
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

// ---------- Geocoding (city → lat/lon) ----------
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

// ---------- Forecast fetch ----------
interface WeatherData {
  time: string[];               // ISO strings
  temperature_2m: number[];    // °C
  weathercode: number[];
}

interface DailyData {
  time: string[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  weathercode: number[];
}

interface ForecastResponse {
  hourly: WeatherData;
  daily: DailyData;
}

async function fetchForecast(lat: number, lon: number): Promise<ForecastResponse | null> {
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
  return resp.json() as Promise<ForecastResponse>;
}

// ---------- Build the message ----------
export async function getWeatherReport(city: string): Promise<string> {
  const geo = await geocode(city);
  if (!geo) return "❌ Could not find that location. Please check the spelling.";

  const forecast = await fetchForecast(geo.lat, geo.lon);
  if (!forecast) return "❌ Failed to fetch weather data. Please try again later.";

  const { hourly, daily } = forecast;
  let msg = `🌍 *Weather for ${escapeMarkdown(geo.name)}* (${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)})\n\n`;

  // Hourly – next 24 hours (limit to 24 entries)
  const now = new Date();
  const next24h = hourly.time
    .map((t, i) => ({ time: new Date(t), temp: hourly.temperature_2m[i], code: hourly.weathercode[i] }))
    .filter(entry => entry.time >= now)
    .slice(0, 24);

  msg += "🕐 *Hourly (next 24 h):*\n";
  if (next24h.length === 0) {
    msg += "_No hourly data available._\n";
  } else {
    for (const h of next24h) {
      const hour = h.time.getHours().toString().padStart(2, "0") + ":00";
      const icon = weatherIcon(h.code);
      msg += `┃ ${hour}  ${h.temp.toFixed(1)}°C  ${icon}\n`;
    }
  }

  msg += "\n📅 *Daily (7‑day forecast):*\n";
  if (daily.time.length === 0) {
    msg += "_No daily data available._\n";
  } else {
    for (let i = 0; i < daily.time.length; i++) {
      const date = new Date(daily.time[i]);
      const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
      const monthDay = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const maxTemp = daily.temperature_2m_max[i].toFixed(1);
      const minTemp = daily.temperature_2m_min[i].toFixed(1);
      const icon = weatherIcon(daily.weathercode[i]);
      msg += `┃ ${dayName} ${monthDay}  🔼${maxTemp}°C  🔽${minTemp}°C  ${icon}\n`;
    }
  }

  return msg;
}
