"use strict";

/*
 * WeatherCN Pro v1.2 iPhone Ready
 * Safe Apple Weather enhancer for Loon.
 *
 * Design goals:
 * - Never blank Apple Weather: failed enrichments return the original response.
 * - Never loop: scripts only match Apple Weather hosts, while provider APIs do not.
 * - Keep all network attempts under a short deadline and use persistent cache.
 */

const WeatherCN = (() => {
  const VERSION = "1.2.0";
  const REQUEST_TIMEOUT_MS = 1500;
  const SCRIPT_BUDGET_MS = 3800;
  const CURRENT_CACHE_TTL_MS = 5 * 60 * 1000;
  const AQI_CACHE_TTL_MS = 10 * 60 * 1000;
  const HOURLY_DAILY_CACHE_TTL_MS = 30 * 60 * 1000;
  const ALERTS_CACHE_TTL_MS = 2 * 60 * 1000;
  const CACHE_PREFIX = "weathercn.pro.v1";

  const WEATHERKIT_DATASETS = [
    "currentWeather",
    "forecastDaily",
    "forecastHourly",
    "forecastNextHour",
    "weatherAlerts"
  ];

  const WEATHER_CARD_KEYS = [
    "airQuality",
    "aqi",
    "humidity",
    "visibility",
    "uvIndex",
    "sunrise",
    "sunset",
    "moonPhase",
    "feelsLike",
    "apparentTemperature",
    "precipitation",
    "snowfall",
    "wind",
    "weatherAlerts"
  ];

  const AIR_CATEGORY_US = [
    { max: 50, name: "Good" },
    { max: 100, name: "Moderate" },
    { max: 150, name: "Unhealthy for Sensitive Groups" },
    { max: 200, name: "Unhealthy" },
    { max: 300, name: "Very Unhealthy" },
    { max: Infinity, name: "Hazardous" }
  ];

  const state = {
    finished: false,
    debug: false,
    args: Object.create(null),
    startedAt: Date.now()
  };

  const Logger = {
    configure(args) {
      state.debug = String(args.DEBUG || args.LOG || "0") === "1";
    },
    info(...items) {
      if (state.debug) {
        console.log("[WeatherCN]", ...items);
      }
    },
    warn(...items) {
      if (state.debug) {
        console.log("[WeatherCN][warn]", ...items);
      }
    }
  };

  const Env = {
    isRequest() {
      return typeof $request !== "undefined" && typeof $response === "undefined";
    },
    isResponse() {
      return typeof $request !== "undefined" && typeof $response !== "undefined";
    },
    request() {
      return typeof $request !== "undefined" ? $request : {};
    },
    response() {
      return typeof $response !== "undefined" ? $response : {};
    },
    done(payload = {}) {
      if (state.finished) {
        return;
      }
      state.finished = true;
      if (typeof $done === "function") {
        $done(payload);
      }
    },
    read(key) {
      try {
        if (typeof $persistentStore !== "undefined" && $persistentStore.read) {
          return $persistentStore.read(key);
        }
      } catch (error) {
        Logger.warn("persistent read failed", key, error && error.message);
      }
      return null;
    },
    write(value, key) {
      try {
        if (typeof $persistentStore !== "undefined" && $persistentStore.write) {
          return $persistentStore.write(value, key);
        }
      } catch (error) {
        Logger.warn("persistent write failed", key, error && error.message);
      }
      return false;
    }
  };

  const Args = {
    parse() {
      const raw = typeof $argument === "string" ? $argument : "";
      const args = Object.create(null);
      raw.split(/[&;]/).forEach((pair) => {
        const index = pair.indexOf("=");
        if (index === -1) {
          if (pair.trim()) {
            args[decodePart(pair.trim())] = "1";
          }
          return;
        }
        const key = decodePart(pair.slice(0, index).trim());
        const value = decodePart(pair.slice(index + 1).trim());
        if (key) {
          args[key] = value;
        }
      });

      const storedKey = Env.read(`${CACHE_PREFIX}.qweather.key`);
      if (!args.QWEATHER_KEY && storedKey) {
        args.QWEATHER_KEY = storedKey;
      }

      state.args = args;
      Logger.configure(args);
      return args;
    }
  };

  function decodePart(value) {
    try {
      return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
    } catch (_) {
      return String(value || "");
    }
  }

  const Cache = {
    key(type, location) {
      const lat = Number(location.latitude).toFixed(2);
      const lon = Number(location.longitude).toFixed(2);
      return `${CACHE_PREFIX}.${type}.${lat}.${lon}`;
    },
    read(type, location, ttlMs) {
      const raw = Env.read(this.key(type, location));
      if (!raw) {
        return null;
      }
      try {
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.timestamp !== "number") {
          return null;
        }
        if (Date.now() - entry.timestamp > ttlMs) {
          return null;
        }
        return entry.data || null;
      } catch (error) {
        Logger.warn("cache parse failed", type, error && error.message);
        return null;
      }
    },
    write(type, location, data) {
      if (!data) {
        return;
      }
      try {
        const entry = JSON.stringify({
          timestamp: Date.now(),
          version: VERSION,
          data
        });
        Env.write(entry, this.key(type, location));
      } catch (error) {
        Logger.warn("cache stringify failed", type, error && error.message);
      }
    }
  };

  const Http = {
    async json(url, options = {}) {
      const response = await this.request(url, {
        ...options,
        responseType: "json"
      });
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response ? response.status : "empty"} ${url}`);
      }
      if (typeof response.body === "object" && response.body !== null) {
        return response.body;
      }
      try {
        return JSON.parse(String(response.body || "{}"));
      } catch (error) {
        throw new Error(`JSON parse failed ${url}: ${error && error.message ? error.message : error}`);
      }
    },

    request(url, options = {}) {
      const timeoutMs = Math.min(options.timeoutMs || REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
      const headers = {
        Accept: "application/json",
        "User-Agent": "WeatherCN-Pro/1.2 Loon",
        ...(options.headers || {})
      };

      return withTimeout(new Promise((resolve, reject) => {
        if (typeof $httpClient !== "undefined" && $httpClient.get) {
          $httpClient.get({ url, headers, timeout: timeoutMs }, (error, response, body) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({
              status: Number(response && (response.status || response.statusCode)) || 200,
              headers: (response && response.headers) || {},
              body
            });
          });
          return;
        }

        if (typeof fetch === "function") {
          const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
          const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
          fetch(url, { headers, signal: controller ? controller.signal : undefined })
            .then(async (res) => {
              const body = await res.text();
              resolve({
                status: res.status,
                headers: {},
                body
              });
            })
            .catch(reject)
            .finally(() => {
              if (timer) {
                clearTimeout(timer);
              }
            });
          return;
        }

        reject(new Error("No HTTP client available"));
      }), timeoutMs, `timeout ${url}`);
    }
  };

  function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || "timeout")), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  const Location = {
    fromRequest(request) {
      const urlText = request && request.url ? String(request.url) : "";
      if (!urlText) {
        return null;
      }

      let parsed = null;
      try {
        parsed = new URL(urlText);
      } catch (_) {
        parsed = null;
      }

      if (parsed) {
        const queryLocation = this.fromQuery(parsed.searchParams);
        if (queryLocation) {
          return queryLocation;
        }

        const pathLocation = this.fromPath(parsed.pathname);
        if (pathLocation) {
          return pathLocation;
        }
      }

      return this.fromPath(urlText);
    },

    fromQuery(params) {
      const latKeys = ["lat", "latitude"];
      const lonKeys = ["lon", "lng", "long", "longitude"];
      const lat = findNumberParam(params, latKeys);
      const lon = findNumberParam(params, lonKeys);
      if (isValidLocation(lat, lon)) {
        return { latitude: lat, longitude: lon };
      }

      const location = params.get("location") || params.get("loc");
      if (location) {
        const parts = String(location).split(/[,;]/).map(Number);
        if (parts.length >= 2) {
          const [first, second] = parts;
          if (isValidLocation(first, second)) {
            return { latitude: first, longitude: second };
          }
          if (isValidLocation(second, first)) {
            return { latitude: second, longitude: first };
          }
        }
      }
      return null;
    },

    fromPath(pathname) {
      const matches = String(pathname || "").match(/-?\d{1,3}\.\d+/g);
      if (!matches || matches.length < 2) {
        return null;
      }
      for (let index = 0; index < matches.length - 1; index += 1) {
        const first = Number(matches[index]);
        const second = Number(matches[index + 1]);
        if (isValidLocation(first, second)) {
          return { latitude: first, longitude: second };
        }
        if (isValidLocation(second, first)) {
          return { latitude: second, longitude: first };
        }
      }
      return null;
    },

    languageFromRequest(request) {
      const urlText = request && request.url ? String(request.url) : "";
      const lower = urlText.toLowerCase();
      if (lower.includes("zh_cn") || lower.includes("zh-hans") || lower.includes("lang=zh")) {
        return "zh";
      }
      return "en";
    }
  };

  function findNumberParam(params, keys) {
    for (const key of keys) {
      const raw = params.get(key);
      if (raw === null || raw === "") {
        continue;
      }
      const value = Number(raw);
      if (Number.isFinite(value)) {
        return value;
      }
    }
    return NaN;
  }

  function isValidLocation(latitude, longitude) {
    return Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180;
  }

  const Providers = {
    async composite(location, args, lang) {
      const merged = emptyComposite();
      mergeComposite(merged, readCachedComposite(location));
      if (hasAnyPayload(merged)) {
        merged.cache = "partial";
      }

      const key = String(args.QWEATHER_KEY || args.QWEATHER_TOKEN || "").trim();
      if (key && hasScriptBudget()) {
        const qweatherData = await fetchProvider("qweather", () => QWeather.fetch(location, key, lang), 1400);
        if (qweatherData && Array.isArray(qweatherData.minutely) && qweatherData.minutely.length) {
          merged.minutely = [];
        }
        mergeComposite(merged, qweatherData);
      }

      if ((!key || needsMinuteRain(merged)) && needsProvider(merged) && hasScriptBudget()) {
        mergeComposite(merged, await fetchProvider("open-meteo", () => OpenMeteo.fetch(location), 1500));
      }

      if (needsWeather(merged) && NOAA.supports(location) && hasScriptBudget()) {
        mergeComposite(merged, await fetchProvider("noaa", () => NOAA.fetch(location), 1200));
      }

      if ((!merged.alerts || merged.alerts.length === 0) && isLikelyChina(location) && hasScriptBudget()) {
        mergeComposite(merged, await fetchProvider("cma-alerts", () => CMA.fetchAlerts(location, lang), 1200));
      }

      writeCompositeCache(location, merged);

      return hasAnyPayload(merged) ? merged : null;
    }
  };

  function readCachedComposite(location) {
    const cached = emptyComposite();
    cached.source.push("cache");
    cached.current = Cache.read("current", location, CURRENT_CACHE_TTL_MS);
    cached.hourly = Cache.read("hourly", location, HOURLY_DAILY_CACHE_TTL_MS) || [];
    cached.daily = Cache.read("daily", location, HOURLY_DAILY_CACHE_TTL_MS) || [];
    cached.minutely = Cache.read("next-hour", location, CURRENT_CACHE_TTL_MS) || [];
    cached.airQuality = Cache.read("aqi", location, AQI_CACHE_TTL_MS);
    cached.alerts = Cache.read("alerts", location, ALERTS_CACHE_TTL_MS) || [];
    return hasAnyPayload(cached) ? cached : null;
  }

  function writeCompositeCache(location, data) {
    if (!data) {
      return;
    }
    if (data.current) {
      Cache.write("current", location, data.current);
    }
    if (Array.isArray(data.hourly) && data.hourly.length) {
      Cache.write("hourly", location, data.hourly);
    }
    if (Array.isArray(data.daily) && data.daily.length) {
      Cache.write("daily", location, data.daily);
    }
    if (Array.isArray(data.minutely) && data.minutely.length) {
      Cache.write("next-hour", location, data.minutely);
    }
    if (data.airQuality) {
      Cache.write("aqi", location, data.airQuality);
    }
    if (Array.isArray(data.alerts) && data.alerts.length) {
      Cache.write("alerts", location, data.alerts);
    }
  }

  async function fetchProvider(name, provider, timeoutMs) {
    try {
      const budget = Math.max(250, Math.min(timeoutMs || REQUEST_TIMEOUT_MS, remainingScriptBudget()));
      return await withTimeout(provider(), budget, `${name} budget exceeded`);
    } catch (error) {
      Logger.warn(`${name} failed`, error && error.message);
      return null;
    }
  }

  function hasScriptBudget() {
    return remainingScriptBudget() > 180;
  }

  function remainingScriptBudget() {
    return Math.max(0, SCRIPT_BUDGET_MS - (Date.now() - state.startedAt));
  }

  function needsProvider(data) {
    return needsWeather(data) || !data.airQuality;
  }

  function needsMinuteRain(data) {
    return !data || !Array.isArray(data.minutely) || data.minutely.length === 0;
  }

  function needsWeather(data) {
    return !data.current ||
      !data.hourly ||
      data.hourly.length === 0 ||
      !data.daily ||
      data.daily.length === 0 ||
      !data.minutely ||
      data.minutely.length === 0;
  }

  function isLikelyChina(location) {
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    return latitude >= 18 && latitude <= 54 && longitude >= 73 && longitude <= 135;
  }

  function emptyComposite() {
    return {
      source: [],
      current: null,
      hourly: [],
      daily: [],
      minutely: [],
      airQuality: null,
      alerts: []
    };
  }

  function mergeComposite(target, source) {
    if (!source) {
      return target;
    }
    if (source.source) {
      const names = Array.isArray(source.source) ? source.source : [source.source];
      target.source = unique([...target.source, ...names]);
    }
    if (!target.current && source.current) {
      target.current = source.current;
    }
    if ((!target.hourly || target.hourly.length === 0) && source.hourly && source.hourly.length) {
      target.hourly = source.hourly;
    }
    if ((!target.daily || target.daily.length === 0) && source.daily && source.daily.length) {
      target.daily = source.daily;
    }
    if ((!target.minutely || target.minutely.length === 0) && source.minutely && source.minutely.length) {
      target.minutely = source.minutely;
    }
    if (!target.airQuality && source.airQuality) {
      target.airQuality = source.airQuality;
    }
    if (source.alerts && source.alerts.length) {
      target.alerts = uniqueAlerts([...(target.alerts || []), ...source.alerts]);
    }
    return target;
  }

  function unique(items) {
    return Array.from(new Set(items.filter(Boolean)));
  }

  function uniqueAlerts(alerts) {
    const seen = new Set();
    return alerts.filter((alert) => {
      const item = alert && typeof alert === "object" ? alert : {};
      const key = `${item.source || ""}:${item.title || ""}:${item.startTime || ""}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function hasWeatherPayload(data) {
    return Boolean(data && (
      data.current ||
      (Array.isArray(data.hourly) && data.hourly.length) ||
      (Array.isArray(data.daily) && data.daily.length) ||
      (Array.isArray(data.minutely) && data.minutely.length) ||
      (Array.isArray(data.alerts) && data.alerts.length)
    ));
  }

  function hasAnyPayload(data) {
    return hasWeatherPayload(data) || Boolean(data && data.airQuality);
  }

  const QWeather = {
    async fetch(location, key, lang) {
      const loc = `${Number(location.longitude).toFixed(4)},${Number(location.latitude).toFixed(4)}`;
      const language = lang === "zh" ? "zh" : "en";
      const base = "https://devapi.qweather.com";
      const query = `location=${encodeURIComponent(loc)}&key=${encodeURIComponent(key)}&lang=${language}`;
      const date = formatDate(new Date());

      const endpoints = {
        now: `${base}/v7/weather/now?${query}`,
        hourly: `${base}/v7/weather/24h?${query}`,
        minutely: `${base}/v7/minutely/5m?${query}`,
        air: `${base}/v7/air/now?${query}`,
        warning: `${base}/v7/warning/now?${query}`,
        sun: `${base}/v7/astronomy/sun?${query}&date=${date}`,
        moon: `${base}/v7/astronomy/moon?${query}&date=${date}`
      };

      const [now, hourly, minutely, air, warning, sun, moon] = await Promise.allSettled([
        Http.json(endpoints.now),
        Http.json(endpoints.hourly),
        Http.json(endpoints.minutely),
        Http.json(endpoints.air),
        Http.json(endpoints.warning),
        Http.json(endpoints.sun),
        Http.json(endpoints.moon)
      ]);

      const payload = emptyComposite();
      payload.source.push("QWeather");

      const nowData = fulfilledValue(now);
      if (isQWeatherOk(nowData) && nowData.now) {
        payload.current = {
          asOf: normalizeTime(nowData.updateTime),
          temperature: numberOrNull(nowData.now.temp),
          apparentTemperature: numberOrNull(nowData.now.feelsLike),
          humidity: percentToUnit(nowData.now.humidity),
          pressure: numberOrNull(nowData.now.pressure),
          windSpeed: kmhToMs(nowData.now.windSpeed),
          windDirection: numberOrNull(nowData.now.wind360),
          windGust: kmhToMs(nowData.now.windGust),
          visibility: kmToMeters(nowData.now.vis),
          uvIndex: null,
          cloudCover: percentToUnit(nowData.now.cloud),
          precipitationIntensity: mmhToMetric(nowData.now.precip),
          conditionCode: qweatherCondition(nowData.now.icon, nowData.now.text)
        };
      }

      const hourlyData = fulfilledValue(hourly);
      if (isQWeatherOk(hourlyData) && Array.isArray(hourlyData.hourly)) {
        payload.hourly = hourlyData.hourly.slice(0, 24).map((item) => ({
          forecastStart: normalizeTime(item.fxTime),
          temperature: numberOrNull(item.temp),
          apparentTemperature: null,
          humidity: percentToUnit(item.humidity),
          pressure: numberOrNull(item.pressure),
          windSpeed: kmhToMs(item.windSpeed),
          windDirection: numberOrNull(item.wind360),
          visibility: kmToMeters(item.vis),
          uvIndex: null,
          cloudCover: percentToUnit(item.cloud),
          precipitationChance: percentToUnit(item.pop),
          precipitationAmount: mmToMetric(item.precip),
          precipitationIntensity: mmhToMetric(item.precip),
          snowfallAmount: null,
          conditionCode: qweatherCondition(item.icon, item.text)
        }));
      }

      const minutelyData = fulfilledValue(minutely);
      if (isQWeatherOk(minutelyData) && Array.isArray(minutelyData.minutely)) {
        payload.minutely = expandMinutely(minutelyData.minutely.map((item) => ({
          startTime: normalizeTime(item.fxTime),
          precipitationIntensity: mmhToMetric(item.precip),
          precipitationChance: percentToUnit(item.prob || item.pop),
          precipitationType: precipitationType(item.type)
        })));
      }

      const airData = fulfilledValue(air);
      if (isQWeatherOk(airData) && airData.now) {
        const aqi = numberOrNull(airData.now.aqi);
        payload.airQuality = {
          asOf: normalizeTime(airData.updateTime),
          source: "QWeather",
          aqi,
          scale: "CN",
          category: airData.now.category || aqiCategory(aqi),
          pm25: numberOrNull(airData.now.pm2p5),
          pm10: numberOrNull(airData.now.pm10),
          ozone: numberOrNull(airData.now.o3),
          nitrogenDioxide: numberOrNull(airData.now.no2),
          sulphurDioxide: numberOrNull(airData.now.so2),
          carbonMonoxide: numberOrNull(airData.now.co)
        };
      }

      const warningData = fulfilledValue(warning);
      if (isQWeatherOk(warningData) && Array.isArray(warningData.warning)) {
        payload.alerts = warningData.warning.map((item) => ({
          title: compactText(item.title || item.typeName || item.event),
          description: compactText(item.text || item.sender || item.title),
          severity: normalizeSeverity(item.severity || item.level),
          startTime: normalizeTime(item.startTime || item.pubTime),
          expireTime: normalizeTime(item.endTime),
          source: item.sender || "QWeather",
          region: item.related || item.sender
        })).filter((item) => item.title);
      }

      const sunData = fulfilledValue(sun);
      const moonData = fulfilledValue(moon);
      if (isQWeatherOk(sunData) || isQWeatherOk(moonData)) {
        payload.daily = [{
          forecastStart: new Date().toISOString(),
          sunrise: normalizeTime(sunData && sunData.sunrise),
          sunset: normalizeTime(sunData && sunData.sunset),
          moonrise: normalizeTime(moonData && moonData.moonrise),
          moonset: normalizeTime(moonData && moonData.moonset),
          moonPhase: moonPhaseToUnit(moonData && moonData.moonPhase)
        }];
      }

      return hasAnyPayload(payload) ? payload : null;
    }
  };

  function isQWeatherOk(payload) {
    return payload && String(payload.code) === "200";
  }

  function fulfilledValue(result) {
    return result && result.status === "fulfilled" ? result.value : null;
  }

  const OpenMeteo = {
    async fetch(location) {
      const lat = Number(location.latitude).toFixed(4);
      const lon = Number(location.longitude).toFixed(4);
      const weatherUrl = "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${lat}&longitude=${lon}` +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day" +
        "&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,rain,snowfall,weather_code,cloud_cover,visibility,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day" +
        "&daily=sunrise,sunset,uv_index_max,precipitation_sum,rain_sum,snowfall_sum,weather_code" +
        "&timezone=auto&forecast_days=2&wind_speed_unit=ms&precipitation_unit=mm&temperature_unit=celsius";
      const airUrl = "https://air-quality-api.open-meteo.com/v1/air-quality" +
        `?latitude=${lat}&longitude=${lon}` +
        "&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi,european_aqi" +
        "&hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,us_aqi" +
        "&timezone=auto&forecast_days=1";

      const [weather, air] = await Promise.allSettled([
        Http.json(weatherUrl),
        Http.json(airUrl)
      ]);

      const weatherData = fulfilledValue(weather);
      const airData = fulfilledValue(air);
      const payload = emptyComposite();
      payload.source.push("Open-Meteo");

      if (weatherData && weatherData.current) {
        payload.current = {
          asOf: toIso(weatherData.current.time, weatherData.timezone),
          temperature: numberOrNull(weatherData.current.temperature_2m),
          apparentTemperature: numberOrNull(weatherData.current.apparent_temperature),
          humidity: percentToUnit(weatherData.current.relative_humidity_2m),
          pressure: numberOrNull(weatherData.current.pressure_msl || weatherData.current.surface_pressure),
          windSpeed: numberOrNull(weatherData.current.wind_speed_10m),
          windDirection: numberOrNull(weatherData.current.wind_direction_10m),
          windGust: numberOrNull(weatherData.current.wind_gusts_10m),
          visibility: null,
          uvIndex: null,
          cloudCover: percentToUnit(weatherData.current.cloud_cover),
          precipitationIntensity: mmhToMetric(weatherData.current.precipitation),
          snowfallAmount: mmToMetric(weatherData.current.snowfall),
          conditionCode: openMeteoCondition(weatherData.current.weather_code, weatherData.current.is_day)
        };
      }

      if (weatherData && weatherData.hourly && Array.isArray(weatherData.hourly.time)) {
        const startIndex = currentHourIndex(weatherData.hourly.time);
        payload.hourly = weatherData.hourly.time.slice(startIndex, startIndex + 24).map((time, offset) => {
          const index = startIndex + offset;
          return ({
          forecastStart: toIso(time, weatherData.timezone),
          temperature: at(weatherData.hourly.temperature_2m, index),
          apparentTemperature: at(weatherData.hourly.apparent_temperature, index),
          humidity: percentToUnit(at(weatherData.hourly.relative_humidity_2m, index)),
          pressure: at(weatherData.hourly.pressure_msl, index),
          windSpeed: at(weatherData.hourly.wind_speed_10m, index),
          windDirection: at(weatherData.hourly.wind_direction_10m, index),
          windGust: at(weatherData.hourly.wind_gusts_10m, index),
          visibility: at(weatherData.hourly.visibility, index),
          uvIndex: at(weatherData.hourly.uv_index, index),
          cloudCover: percentToUnit(at(weatherData.hourly.cloud_cover, index)),
          precipitationChance: percentToUnit(at(weatherData.hourly.precipitation_probability, index)),
          precipitationAmount: mmToMetric(at(weatherData.hourly.precipitation, index)),
          precipitationIntensity: mmhToMetric(at(weatherData.hourly.precipitation, index)),
          snowfallAmount: mmToMetric(at(weatherData.hourly.snowfall, index)),
          conditionCode: openMeteoCondition(at(weatherData.hourly.weather_code, index), at(weatherData.hourly.is_day, index))
          });
        });
        payload.minutely = hourlyToSixtyMinutes(payload.hourly);
      }

      if (weatherData && weatherData.daily && Array.isArray(weatherData.daily.time)) {
        payload.daily = weatherData.daily.time.slice(0, 2).map((time, index) => ({
          forecastStart: toIso(time, weatherData.timezone),
          sunrise: toIso(rawAt(weatherData.daily.sunrise, index), weatherData.timezone),
          sunset: toIso(rawAt(weatherData.daily.sunset, index), weatherData.timezone),
          uvIndexMax: at(weatherData.daily.uv_index_max, index),
          precipitationAmount: mmToMetric(at(weatherData.daily.precipitation_sum, index)),
          rainfallAmount: mmToMetric(at(weatherData.daily.rain_sum, index)),
          snowfallAmount: mmToMetric(at(weatherData.daily.snowfall_sum, index)),
          conditionCode: openMeteoCondition(at(weatherData.daily.weather_code, index), 1)
        }));
      }

      if (airData && airData.current) {
        const aqi = numberOrNull(airData.current.us_aqi || airData.current.european_aqi);
        payload.airQuality = {
          asOf: toIso(airData.current.time, airData.timezone),
          source: "Open-Meteo",
          aqi,
          scale: airData.current.us_aqi != null ? "US" : "EU",
          category: aqiCategory(aqi),
          pm25: numberOrNull(airData.current.pm2_5),
          pm10: numberOrNull(airData.current.pm10),
          ozone: numberOrNull(airData.current.ozone),
          nitrogenDioxide: numberOrNull(airData.current.nitrogen_dioxide),
          sulphurDioxide: numberOrNull(airData.current.sulphur_dioxide),
          carbonMonoxide: openMeteoCoToMg(airData.current.carbon_monoxide)
        };
      }

      return hasAnyPayload(payload) ? payload : null;
    }
  };

  const NOAA = {
    supports(location) {
      const lat = Number(location.latitude);
      const lon = Number(location.longitude);
      return lat >= 18 && lat <= 72 && lon >= -170 && lon <= -50;
    },

    async fetch(location) {
      const lat = Number(location.latitude).toFixed(4);
      const lon = Number(location.longitude).toFixed(4);
      const points = await Http.json(`https://api.weather.gov/points/${lat},${lon}`, {
        headers: { "User-Agent": "WeatherCN-Pro/1.2 contact: local" }
      });
      const hourlyUrl = points && points.properties && points.properties.forecastHourly;
      if (!hourlyUrl) {
        return null;
      }
      const forecast = await Http.json(hourlyUrl, {
        headers: { "User-Agent": "WeatherCN-Pro/1.2 contact: local" }
      });
      const periods = forecast && forecast.properties && forecast.properties.periods;
      if (!Array.isArray(periods) || !periods.length) {
        return null;
      }
      const hourly = periods.slice(0, 24).map((item) => ({
        forecastStart: normalizeTime(item.startTime),
        temperature: fahrenheitToCelsius(item.temperature),
        apparentTemperature: null,
        humidity: null,
        pressure: null,
        windSpeed: mphTextToMs(item.windSpeed),
        windDirection: compassToDegree(item.windDirection),
        visibility: null,
        uvIndex: null,
        cloudCover: null,
        precipitationChance: item.probabilityOfPrecipitation ? percentToUnit(item.probabilityOfPrecipitation.value) : null,
        precipitationAmount: null,
        precipitationIntensity: null,
        snowfallAmount: null,
        conditionCode: noaaCondition(item.shortForecast)
      }));
      return {
        source: "NOAA",
        current: hourly[0] || null,
        hourly,
        daily: [],
        minutely: hourlyToSixtyMinutes(hourly),
        airQuality: null,
        alerts: []
      };
    }
  };

  const CMA = {
    async fetchAlerts(_location, lang) {
      const url = "https://weather.cma.cn/api/map/alarm?adcode=100000";
      const data = await Http.json(url, {
        headers: {
          Referer: "https://weather.cma.cn/"
        }
      });
      const list = Array.isArray(data && data.data) ? data.data : [];
      const alerts = list.slice(0, 20).map((item) => normalizeCmaAlert(item, lang)).filter(Boolean);
      return alerts.length ? {
        source: "CMA",
        current: null,
        hourly: [],
        daily: [],
        minutely: [],
        airQuality: null,
        alerts
      } : null;
    }
  };

  function normalizeCmaAlert(item) {
    if (!item) {
      return null;
    }
    const title = compactText(item.title || item.headline || item.name || item.signaltype || item.type);
    if (!title) {
      return null;
    }
    return {
      title,
      description: compactText(item.content || item.description || item.text || item.issuetime || title),
      severity: normalizeSeverity(item.level || item.signallevel || item.severity),
      startTime: normalizeTime(item.issuetime || item.issueTime || item.pubTime),
      expireTime: normalizeTime(item.endtime || item.expireTime),
      source: item.sender || item.province || "CMA",
      region: item.city || item.county || item.province
    };
  }

  const ApplePatch = {
    patch(originalJson, enrichment, request) {
      const json = cloneJson(originalJson);
      if (!json || typeof json !== "object") {
        return originalJson;
      }
      const requestLocation = Location.fromRequest(request);

      if (enrichment) {
        safePatch("capabilities", () => unlockCapabilities(json));
        safePatch("current", () => patchCurrent(json, enrichment.current));
        safePatch("hourly", () => patchHourly(json, enrichment.hourly));
        safePatch("daily", () => patchDaily(json, enrichment.daily));
        if (requestLocation && isLikelyChina(requestLocation)) {
          safePatch("next-hour", () => patchNextHour(json, enrichment.minutely));
        }
        safePatch("air-quality", () => patchAirQuality(json, enrichment.airQuality));
        safePatch("alerts", () => patchAlerts(json, enrichment.alerts));
        safePatch("metadata", () => patchMetadata(json, enrichment, request));
      }

      return json;
    }
  };

  function safePatch(label, patcher) {
    try {
      patcher();
    } catch (error) {
      Logger.warn(`patch ${label} skipped`, error && error.message);
    }
  }

  function unlockCapabilities(root) {
    if (!root || typeof root !== "object") {
      return;
    }
    const visited = new WeakSet();
    const visit = (node) => {
      if (!node || typeof node !== "object" || visited.has(node)) {
        return;
      }
      visited.add(node);
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        const lower = key.toLowerCase();
        const datasetKey = WEATHERKIT_DATASETS.some((item) => lower.includes(item.toLowerCase()));
        const cardKey = WEATHER_CARD_KEYS.some((item) => lower.includes(item.toLowerCase()));
        const capabilityKey = /available|availability|enabled|supported|eligible|restricted|disabled|dataset|capabilit|feature/.test(lower);

        if ((datasetKey || cardKey) && capabilityKey) {
          if (typeof value === "boolean") {
            node[key] = !/restricted|disabled/.test(lower);
          } else if (typeof value === "string") {
            node[key] = value.replace(/unavailable|disabled|restricted|unsupported|false/ig, "available");
          }
        } else if (Array.isArray(value) && /datasets/.test(lower)) {
          node[key] = mergeWeatherKitDatasetArray(value);
        }
        visit(node[key]);
      }
    };
    visit(root);

    if (!root.availability) {
      root.availability = {};
    }
    if (typeof root.availability === "object") {
      root.availability.weatherCNPro = {
        version: VERSION,
        enabled: true,
        availableDataSets: WEATHERKIT_DATASETS.slice(),
        enhancedCards: WEATHER_CARD_KEYS.slice()
      };
    }
  }

  function mergeWeatherKitDatasetArray(value) {
    const array = value.slice();
    if (array.every((item) => typeof item === "string")) {
      for (const dataSet of WEATHERKIT_DATASETS) {
        if (!array.includes(dataSet)) {
          array.push(dataSet);
        }
      }
    }
    return array;
  }

  function patchCurrent(root, current) {
    if (!root || typeof root !== "object" || !current || typeof current !== "object") {
      return;
    }
    const values = {
      asOf: current.asOf,
      cloudCover: current.cloudCover,
      conditionCode: current.conditionCode,
      humidity: current.humidity,
      precipitationIntensity: current.precipitationIntensity,
      pressure: current.pressure,
      pressureTrend: "steady",
      temperature: current.temperature,
      temperatureApparent: current.apparentTemperature,
      uvIndex: current.uvIndex,
      visibility: current.visibility,
      windDirection: current.windDirection,
      windGust: current.windGust,
      windSpeed: current.windSpeed
    };
    const targets = objectTargets(root, "currentWeather", ["current"]);
    Logger.info("Patch Current targets:", targets.length);
    for (const target of targets) {
      assignDefined(target, values);
    }
  }

  function patchHourly(root, hourly) {
    if (!Array.isArray(hourly) || !hourly.length) {
      return;
    }
    const targets = objectTargets(root, "forecastHourly", ["hourlyForecast"]);
    Logger.info("Patch Hourly targets:", targets.length);
    for (const container of targets) {
      const key = forecastArrayKey(container, "hours", ["forecastHourly", "hourlyForecast"]);
      const existing = Array.isArray(container[key]) ? container[key] : [];
      const length = Math.max(existing.length, hourly.length);
      container[key] = Array.from({ length }, (_, index) => {
        const hour = hourly[index] && typeof hourly[index] === "object" ? hourly[index] : null;
        if (!hour) {
          return existing[index];
        }
        return {
          ...(existing[index] || {}),
          ...removeUndefined({
          forecastStart: hour.forecastStart,
          startTime: hour.forecastStart,
          cloudCover: hour.cloudCover,
          conditionCode: hour.conditionCode,
          humidity: hour.humidity,
          precipitationAmount: hour.precipitationAmount,
          precipitationChance: hour.precipitationChance,
          precipitationType: hour.snowfallAmount && hour.snowfallAmount > 0 ? "snow" : "rain",
          precipitationIntensity: hour.precipitationIntensity,
          pressure: hour.pressure,
          snowfallAmount: hour.snowfallAmount,
          snowfallIntensity: hour.snowfallAmount,
          temperature: hour.temperature,
          temperatureApparent: hour.apparentTemperature,
          uvIndex: hour.uvIndex,
          visibility: hour.visibility,
          windDirection: hour.windDirection,
          windGust: hour.windGust,
          windSpeed: hour.windSpeed
          })
        };
      }).filter(Boolean);
    }
  }

  function patchDaily(root, daily) {
    if (!Array.isArray(daily) || !daily.length) {
      return;
    }
    const targets = objectTargets(root, "forecastDaily", ["dailyForecast"]);
    Logger.info("Patch Daily targets:", targets.length);
    for (const container of targets) {
      const key = forecastArrayKey(container, "days", ["forecastDaily", "dailyForecast"]);
      const existing = Array.isArray(container[key]) ? container[key] : [];
      const length = Math.max(existing.length, daily.length);
      container[key] = Array.from({ length }, (_, index) => {
        const day = daily[index] && typeof daily[index] === "object" ? daily[index] : null;
        if (!day) {
          return existing[index];
        }
        return {
          ...(existing[index] || {}),
          ...removeUndefined({
          forecastStart: day.forecastStart,
          startTime: day.forecastStart,
          conditionCode: day.conditionCode,
          forecastEnd: day.forecastEnd || (daily[index + 1] && daily[index + 1].forecastStart),
          moonPhase: day.moonPhase,
          moonrise: day.moonrise,
          moonset: day.moonset,
          precipitationAmount: day.precipitationAmount,
          precipitationChance: day.precipitationChance,
          precipitationType: day.snowfallAmount && day.snowfallAmount > 0 ? "snow" : "rain",
          rainfallAmount: day.rainfallAmount,
          snowfallAmount: day.snowfallAmount,
          sunrise: day.sunrise,
          sunset: day.sunset,
          maxUvIndex: day.uvIndexMax,
          temperatureMax: day.temperatureMax,
          temperatureMin: day.temperatureMin
          })
        };
      }).filter(Boolean);
    }
  }

  function patchNextHour(root, minutely) {
    const minutes = Array.isArray(minutely) && minutely.length ? minutely : [];
    if (!minutes.length) {
      return;
    }
    if (hasMinuteForecast(root)) {
      return;
    }
    const targets = objectTargets(root, "forecastNextHour", ["nextHourForecast", "nextHour", "minuteForecast"]);
    const rootTarget = ensureObject(root, "forecastNextHour");
    if (!targets.includes(rootTarget)) {
      targets.push(rootTarget);
    }
    const minuteItems = minutes.slice(0, 60).map((item) => {
      const minute = item && typeof item === "object" ? item : {};
      return removeUndefined({
        startTime: minute.startTime,
        precipitationChance: minute.precipitationChance,
        precipitationIntensity: minute.precipitationIntensity
      });
    });
    const maxChance = minuteItems.reduce((max, item) => Math.max(max, numberOrNull(item.precipitationChance) || 0), 0);
    const maxIntensity = minuteItems.reduce((max, item) => Math.max(max, numberOrNull(item.precipitationIntensity) || 0), 0);
    const summaryItems = [removeUndefined({
      condition: maxIntensity > 0 ? "precipitation" : "clear",
      startTime: minuteItems[0] && minuteItems[0].startTime,
      endTime: minuteItems[minuteItems.length - 1] && minuteItems[minuteItems.length - 1].startTime,
      precipitationChance: maxChance,
      precipitationIntensity: maxIntensity
    })];
    Logger.info("Patch Minute targets:", targets.length);
    for (const target of targets) {
      const key = forecastArrayKey(target, "minutes", ["forecastMinutes", "minuteForecasts", "minuteForecast", "nextHourForecast", "nextHour", "data"]);
      target[key] = minuteItems;
      target.minutes = minuteItems;
      assignDefined(target, {
        forecastStart: minuteItems[0] && minuteItems[0].startTime,
        forecastEnd: minuteItems[minuteItems.length - 1] && minuteItems[minuteItems.length - 1].startTime
      });
      target.summary = summaryItems;
      target.metadata = {
        ...(target.metadata || {}),
        attributionName: "WeatherCN Pro"
      };
    }
    Logger.info("Patch Minute inserted:", minuteItems.length);
  }

  function objectTargets(root, primaryKey, aliases) {
    const keys = [primaryKey, ...(aliases || [])];
    const targets = findWeatherObjects(root, keys);
    if (targets.length) {
      return targets;
    }
    for (const container of findWeatherObjects(root, ["weatherData", "datasets", "data", "result", "response"])) {
      if (container && typeof container === "object" && !Array.isArray(container)) {
        const target = ensureObject(container, primaryKey);
        if (!targets.includes(target)) {
          targets.push(target);
        }
      }
    }
    if (!targets.length) {
      targets.push(ensureObject(root, primaryKey));
    }
    return targets;
  }

  function findWeatherObjects(root, candidateKeys) {
    const targets = [];
    const seen = new WeakSet();
    const candidates = new Set((candidateKeys || []).map((key) => String(key).toLowerCase()));
    const visit = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) {
        return;
      }
      seen.add(node);
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (candidates.has(key.toLowerCase())) {
          const target = value && typeof value === "object" && !Array.isArray(value) ? value : node;
          if (target && typeof target === "object" && !Array.isArray(target) && !targets.includes(target)) {
            targets.push(target);
          }
        }
        visit(value);
      }
    };
    visit(root);
    return targets;
  }

  function forecastArrayKey(container, preferred, aliases = []) {
    if (!container || typeof container !== "object") {
      return preferred;
    }
    if (Array.isArray(container[preferred])) {
      return preferred;
    }
    for (const key of [...aliases, "hours", "days", "forecast", "forecasts", "data", "items"]) {
      if (Array.isArray(container[key])) {
        return key;
      }
    }
    return preferred;
  }

  function hasMinuteForecast(root) {
    return findWeatherObjects(root, ["forecastNextHour", "nextHourForecast", "nextHour", "minuteForecast"])
      .some((nextHour) => ["minutes", "forecastMinutes", "minuteForecasts", "data"].some((key) => (
        Array.isArray(nextHour[key]) && nextHour[key].some((item) => (
          item &&
          typeof item === "object" &&
          item.startTime &&
          (
            numberOrNull(item.precipitationIntensity) != null ||
            numberOrNull(item.precipitationChance) != null
          )
        ))
      )));
  }

  function patchAirQuality(root, airQuality) {
    if (!root || typeof root !== "object" || !airQuality || typeof airQuality !== "object") {
      return;
    }
    const target = ensureObject(root, "airQuality");
    const pollutants = [
      pollutant("PM2.5", "pm25", airQuality.pm25),
      pollutant("PM10", "pm10", airQuality.pm10),
      pollutant("O3", "ozone", airQuality.ozone),
      pollutant("NO2", "nitrogenDioxide", airQuality.nitrogenDioxide),
      pollutant("SO2", "sulphurDioxide", airQuality.sulphurDioxide),
      pollutant("CO", "carbonMonoxide", airQuality.carbonMonoxide)
    ].filter((item) => item.concentration != null);

    assignDefined(target, {
      asOf: airQuality.asOf,
      aqi: airQuality.aqi,
      scale: airQuality.scale,
      category: airQuality.category,
      source: airQuality.source,
      currentAirQuality: removeUndefined({
        aqi: airQuality.aqi,
        scale: airQuality.scale,
        category: airQuality.category,
        pollutants
      }),
      pollutants
    });
  }

  function pollutant(displayName, code, concentration) {
    return {
      displayName,
      pollutantCode: code,
      concentration,
      unit: code === "carbonMonoxide" ? "mg/m3" : "ug/m3"
    };
  }

  function patchAlerts(root, alerts) {
    if (!Array.isArray(alerts) || !alerts.length) {
      return;
    }
    const target = ensureObject(root, "weatherAlerts");
    target.alerts = alerts.slice(0, 20).map((alert) => {
      const item = alert && typeof alert === "object" ? alert : {};
      return removeUndefined({
        name: item.title,
        title: item.title,
        summary: item.description,
        description: item.description,
        severity: item.severity,
        source: item.source,
        region: item.region,
        issuedTime: item.startTime,
        startTime: item.startTime,
        expireTime: item.expireTime,
        eventSource: "WeatherCN Pro"
      });
    });
  }

  function patchMetadata(root, enrichment, request) {
    if (!root || typeof root !== "object") {
      return;
    }
    const data = enrichment && typeof enrichment === "object" ? enrichment : {};
    const metadata = ensureObject(root, "metadata");
    metadata.weatherCNPro = {
      version: VERSION,
      source: data.source || [],
      enhancedAt: new Date().toISOString(),
      requestHost: safeHost(request && request.url),
      cache: data.cache || "miss"
    };
  }

  function ensureObject(root, key) {
    if (!root || typeof root !== "object") {
      return {};
    }
    if (!root[key] || typeof root[key] !== "object" || Array.isArray(root[key])) {
      root[key] = {};
    }
    return root[key];
  }

  function assignDefined(target, values) {
    if (!target || typeof target !== "object" || !values || typeof values !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && Number.isNaN(value) === false) {
        target[key] = value;
      }
    }
  }

  function removeUndefined(item) {
    const output = {};
    if (!item || typeof item !== "object") {
      return output;
    }
    for (const [key, value] of Object.entries(item)) {
      if (value !== undefined && value !== null && Number.isNaN(value) === false) {
        output[key] = value;
      }
    }
    return output;
  }

  function cloneJson(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function safeHost(urlText) {
    try {
      return new URL(urlText).host;
    } catch (_) {
      return "";
    }
  }

  function hourlyToSixtyMinutes(hourly) {
    if (!Array.isArray(hourly) || !hourly.length) {
      return [];
    }
    const base = Date.now();
    const first = hourly[0] || {};
    const next = hourly[1] || first;
    const output = [];
    for (let minute = 0; minute < 60; minute += 1) {
      const ratio = minute / 60;
      const intensity = interpolate(first.precipitationIntensity, next.precipitationIntensity, ratio);
      const chance = interpolate(first.precipitationChance, next.precipitationChance, ratio);
      output.push({
        startTime: new Date(base + minute * 60 * 1000).toISOString(),
        precipitationIntensity: intensity,
        precipitationChance: chance,
        precipitationType: first.snowfallAmount && first.snowfallAmount > 0 ? "snow" : "rain"
      });
    }
    return output;
  }

  function expandMinutely(points) {
    if (!Array.isArray(points) || !points.length) {
      return [];
    }
    const sorted = points
      .filter((item) => item.startTime)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    const output = [];
    for (let index = 0; index < sorted.length - 1 && output.length < 60; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      const start = new Date(current.startTime).getTime();
      const end = new Date(next.startTime).getTime();
      const spanMinutes = Math.max(1, Math.round((end - start) / 60000));
      for (let offset = 0; offset < spanMinutes && output.length < 60; offset += 1) {
        const ratio = offset / spanMinutes;
        output.push({
          startTime: new Date(start + offset * 60000).toISOString(),
          precipitationIntensity: interpolate(current.precipitationIntensity, next.precipitationIntensity, ratio),
          precipitationChance: interpolate(current.precipitationChance, next.precipitationChance, ratio),
          precipitationType: current.precipitationType || next.precipitationType || "rain"
        });
      }
    }
    while (output.length < 60) {
      const last = output[output.length - 1] || sorted[sorted.length - 1];
      const lastTime = new Date(last.startTime || Date.now()).getTime();
      output.push({
        startTime: new Date(lastTime + 60000).toISOString(),
        precipitationIntensity: last.precipitationIntensity || 0,
        precipitationChance: last.precipitationChance || 0,
        precipitationType: last.precipitationType || "rain"
      });
    }
    return output.slice(0, 60);
  }

  function interpolate(a, b, ratio) {
    const first = numberOrNull(a);
    const second = numberOrNull(b);
    if (first == null && second == null) {
      return null;
    }
    if (first == null) {
      return second;
    }
    if (second == null) {
      return first;
    }
    return Number((first + (second - first) * ratio).toFixed(4));
  }

  function qweatherCondition(icon, text) {
    const code = String(icon || "");
    const label = String(text || "").toLowerCase();
    if (/snow|雪/.test(label) || /^4/.test(code)) {
      return "snow";
    }
    if (/rain|雨/.test(label) || /^3/.test(code)) {
      return "rain";
    }
    if (/storm|雷|thunder/.test(label)) {
      return "thunderstorms";
    }
    if (/fog|mist|雾/.test(label)) {
      return "foggy";
    }
    if (/cloud|阴|云/.test(label)) {
      return "cloudy";
    }
    return "clear";
  }

  function openMeteoCondition(code, isDay) {
    const value = Number(code);
    if ([0].includes(value)) {
      return Number(isDay) === 0 ? "clearNight" : "clear";
    }
    if ([1, 2, 3].includes(value)) {
      return "partlyCloudy";
    }
    if ([45, 48].includes(value)) {
      return "foggy";
    }
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(value)) {
      return "rain";
    }
    if ([71, 73, 75, 77, 85, 86].includes(value)) {
      return "snow";
    }
    if ([95, 96, 99].includes(value)) {
      return "thunderstorms";
    }
    return "cloudy";
  }

  function noaaCondition(text) {
    const lower = String(text || "").toLowerCase();
    if (lower.includes("snow")) {
      return "snow";
    }
    if (lower.includes("thunder")) {
      return "thunderstorms";
    }
    if (lower.includes("rain") || lower.includes("shower")) {
      return "rain";
    }
    if (lower.includes("fog")) {
      return "foggy";
    }
    if (lower.includes("cloud")) {
      return "cloudy";
    }
    return "clear";
  }

  function precipitationType(value) {
    const text = String(value || "").toLowerCase();
    if (text.includes("snow") || text.includes("雪")) {
      return "snow";
    }
    if (text.includes("sleet") || text.includes("ice")) {
      return "sleet";
    }
    return "rain";
  }

  function normalizeSeverity(value) {
    const text = String(value || "").toLowerCase();
    if (/extreme|red|红|severe|major|重大/.test(text)) {
      return "extreme";
    }
    if (/orange|橙|moderate/.test(text)) {
      return "severe";
    }
    if (/yellow|黄|minor|watch/.test(text)) {
      return "moderate";
    }
    return "minor";
  }

  function aqiCategory(aqi) {
    const value = Number(aqi);
    if (!Number.isFinite(value)) {
      return null;
    }
    const category = AIR_CATEGORY_US.find((item) => value <= item.max);
    return category ? category.name : null;
  }

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  function currentHourIndex(times) {
    if (!Array.isArray(times) || !times.length) {
      return 0;
    }
    const floor = Date.now() - 60 * 60 * 1000;
    const found = times.findIndex((value) => {
      const timestamp = new Date(value).getTime();
      return Number.isFinite(timestamp) && timestamp >= floor;
    });
    return found >= 0 ? found : 0;
  }

  function openMeteoCoToMg(value) {
    const number = numberOrNull(value);
    if (number == null) {
      return null;
    }
    return number > 20 ? Number((number / 1000).toFixed(4)) : number;
  }

  function toIso(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function normalizeTime(value) {
    if (!value) {
      return null;
    }
    if (typeof value === "string" && /^\d{2}:\d{2}$/.test(value)) {
      const now = new Date();
      const [hour, minute] = value.split(":").map(Number);
      now.setHours(hour, minute, 0, 0);
      return now.toISOString();
    }
    return toIso(value);
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function percentToUnit(value) {
    const number = numberOrNull(value);
    if (number == null) {
      return null;
    }
    return number > 1 ? Number((number / 100).toFixed(4)) : number;
  }

  function kmhToMs(value) {
    const number = numberOrNull(value);
    return number == null ? null : Number((number / 3.6).toFixed(4));
  }

  function kmToMeters(value) {
    const number = numberOrNull(value);
    return number == null ? null : Number((number * 1000).toFixed(2));
  }

  function mmToMetric(value) {
    const number = numberOrNull(value);
    return number == null ? null : Number(number.toFixed(4));
  }

  function mmhToMetric(value) {
    const number = numberOrNull(value);
    return number == null ? null : Number(number.toFixed(4));
  }

  function fahrenheitToCelsius(value) {
    const number = numberOrNull(value);
    return number == null ? null : Number(((number - 32) * 5 / 9).toFixed(2));
  }

  function mphTextToMs(value) {
    const match = String(value || "").match(/\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }
    return Number((Number(match[0]) * 0.44704).toFixed(4));
  }

  function compassToDegree(value) {
    const map = {
      N: 0,
      NNE: 22.5,
      NE: 45,
      ENE: 67.5,
      E: 90,
      ESE: 112.5,
      SE: 135,
      SSE: 157.5,
      S: 180,
      SSW: 202.5,
      SW: 225,
      WSW: 247.5,
      W: 270,
      WNW: 292.5,
      NW: 315,
      NNW: 337.5
    };
    return map[String(value || "").toUpperCase()] ?? null;
  }

  function moonPhaseToUnit(value) {
    const number = numberOrNull(value);
    if (number == null) {
      return null;
    }
    if (number > 1) {
      return Number((number / 100).toFixed(4));
    }
    return number;
  }

  function at(array, index) {
    return Array.isArray(array) ? numberOrNull(array[index]) : null;
  }

  function rawAt(array, index) {
    return Array.isArray(array) ? array[index] : null;
  }

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  const RequestPatch = {
    patch(request) {
      const urlText = request && request.url ? String(request.url) : "";
      if (!urlText) {
        return {};
      }
      let parsed = null;
      try {
        parsed = new URL(urlText);
      } catch (_) {
        return {};
      }
      const dataSets = parsed.searchParams.get("dataSets") || parsed.searchParams.get("datasets");
      if (dataSets) {
        const requested = dataSets.split(",").map((item) => item.trim()).filter(Boolean);
        const merged = unique([
          ...requested.filter((item) => WEATHERKIT_DATASETS.includes(item)),
          ...WEATHERKIT_DATASETS
        ]);
        if (parsed.searchParams.has("dataSets")) {
          parsed.searchParams.set("dataSets", merged.join(","));
        }
        if (parsed.searchParams.has("datasets")) {
          parsed.searchParams.set("datasets", merged.join(","));
        }
        return { url: parsed.toString() };
      }
      return {};
    }
  };

  async function handleRequest() {
    const request = Env.request();
    Logger.info("URL Matched", request.url || "");
    if (request.headers && request.headers["X-WeatherCN-Pro"]) {
      Env.done({});
      return;
    }
    Env.done(RequestPatch.patch(request));
  }

  async function handleResponse() {
    const request = Env.request();
    Logger.info("URL Matched", request.url || "");
    const response = Env.response();
    const originalBody = response.body;
    if (!originalBody || typeof originalBody !== "string") {
      Env.done({});
      return;
    }

    let originalJson = null;
    try {
      originalJson = JSON.parse(originalBody);
    } catch (_) {
      Env.done({});
      return;
    }
    logResponseJsonKeys(originalJson);

    const location = Location.fromRequest(request);
    let enrichment = null;
    if (location) {
      try {
        enrichment = await Providers.composite(location, state.args, Location.languageFromRequest(request));
      } catch (error) {
        Logger.warn("provider composite failed", error && error.message);
      }
    }

    if (!hasAnyPayload(enrichment)) {
      Env.done({});
      return;
    }

    try {
      const patched = ApplePatch.patch(originalJson, enrichment, request);
      Env.done({
        body: JSON.stringify(patched),
        headers: scrubHeaders(response.headers)
      });
    } catch (error) {
      Logger.warn("response patch failed", error && error.message);
      Env.done({});
    }
  }

  function scrubHeaders(headers) {
    const output = { ...(headers || {}) };
    for (const key of Object.keys(output)) {
      if (/content-length|content-encoding/i.test(key)) {
        delete output[key];
      }
    }
    return output;
  }

  function logResponseJsonKeys(root) {
    if (!state.debug) {
      return;
    }
    if (!root || typeof root !== "object") {
      Logger.info("Response first-level keys:", "<non-object>");
      return;
    }
    const firstKeys = Object.keys(root);
    Logger.info("Response first-level keys:", firstKeys.slice(0, 80).join(","));
    for (const key of firstKeys.slice(0, 30)) {
      const value = root[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Logger.info(`Response second-level keys ${key}:`, Object.keys(value).slice(0, 80).join(","));
      }
    }
  }

  async function main() {
    Args.parse();
    if (Env.isRequest()) {
      await handleRequest();
      return;
    }
    if (Env.isResponse()) {
      await handleResponse();
      return;
    }
    Env.done({});
  }

  return {
    main,
    _private: {
      Location,
      OpenMeteo,
      ApplePatch,
      RequestPatch,
      hourlyToSixtyMinutes,
      expandMinutely
    }
  };
})();

WeatherCN.main().catch((error) => {
  try {
    if (typeof console !== "undefined") {
      console.log("[WeatherCN][fatal]", error && error.message ? error.message : error);
    }
  } catch (_) {
    // no-op
  }
  if (typeof $done === "function") {
    $done({});
  }
});
