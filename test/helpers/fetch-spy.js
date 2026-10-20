'use strict';
// Se carga en el servidor de pruebas con NODE_OPTIONS=--require: apunta en stderr cada petición a Open-Meteo
// («fetch-spy: open-meteo <lat>,<lon>») y responde con un tiempo fijo, sin salir a internet. El resto pasa tal cual.
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.open-meteo.com/')) {
    const q = new URL(u).searchParams;
    process.stderr.write(`fetch-spy: open-meteo ${q.get('latitude')},${q.get('longitude')}\n`);
    const now = Math.floor(Date.now() / 1000);
    return new Response(JSON.stringify({
      current: { temperature_2m: 21.4, apparent_temperature: 20.6, weather_code: 2, is_day: 1, wind_speed_10m: 9 },
      daily: { temperature_2m_max: [25, 24], temperature_2m_min: [14, 13], sunrise: [now - 6 * 3600, now + 18 * 3600], sunset: [now + 5 * 3600, now + 29 * 3600], precipitation_probability_max: [10] },
      hourly: { precipitation_probability: [0, 0, 5, 5, 10, 10] },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
  return real(url, opts);
};
