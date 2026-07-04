/*
 * WeatherCN Pro v1.0.0
 * Loon http-response script for Apple WeatherKit.
 *
 * 当前版本目标：稳定接管 WeatherKit 响应、输出日志、保留原始天气数据、提供后续接入
 * 下一小时降水 / AQI / 预警 的安全扩展入口。
 *
 * 重要原则：
 * 1. 不破坏 Apple 原始 JSON 结构。
 * 2. 解析失败时原样返回。
 * 3. 任何增强失败时原样返回。
 */

const WeatherCNPro = {
  version: "1.0.0",
  debug: true,
  tag: "WeatherCN Pro"
};

function log(message) {
  if (WeatherCNPro.debug) {
    console.log(`[${WeatherCNPro.tag}] ${message}`);
  }
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeUrl(url) {
  try {
    return String(url || "");
  } catch (_) {
    return "";
  }
}

function detectEndpoint(url) {
  if (url.includes("weatherkit.apple.com/api/v1/weather/")) return "weatherkit-weather";
  if (url.includes("weather-data.apple.com")) return "weather-data";
  return "unknown";
}

function attachDiagnostics(payload, context) {
  // 只添加不会影响 Apple 天气 App 渲染的诊断字段。
  // 如果后续发现 Apple 严格校验字段，可将此函数改为仅日志不注入。
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  payload.weatherCNPro = {
    enabled: true,
    version: WeatherCNPro.version,
    endpoint: context.endpoint,
    processedAt: new Date().toISOString(),
    note: "WeatherCN Pro response script executed"
  };

  return payload;
}

function enhanceWeatherKit(payload, context) {
  // v1.0 稳定框架版：不伪造天气数据，不破坏原始 WeatherKit 字段。
  // 下一小时降水、AQI、预警将在后续版本在这里接入真实数据源并映射。
  return attachDiagnostics(payload, context);
}

(function main() {
  const url = normalizeUrl($request && $request.url);
  const endpoint = detectEndpoint(url);
  const body = ($response && typeof $response.body === "string") ? $response.body : "";

  log(`version=${WeatherCNPro.version}`);
  log(`endpoint=${endpoint}`);
  log(`url=${url}`);

  if (!body) {
    log("empty response body, return original response");
    $done({});
    return;
  }

  const parsed = safeJsonParse(body);
  if (!parsed.ok) {
    log(`JSON parse failed: ${parsed.error && parsed.error.message ? parsed.error.message : parsed.error}`);
    $done({ body });
    return;
  }

  try {
    const context = { url, endpoint };
    const enhanced = enhanceWeatherKit(parsed.value, context);
    const newBody = JSON.stringify(enhanced);
    log("inject success");
    $done({ body: newBody });
  } catch (error) {
    log(`enhance failed: ${error && error.message ? error.message : error}`);
    $done({ body });
  }
})();
