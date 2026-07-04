/*
WeatherCN Pro v0.3.0
Loon http-response script
This file must be pure JavaScript. Do not put #! plugin headers here.
*/

const VERSION = '0.3.0';

function log(message) {
  console.log(`[WeatherCN Pro ${VERSION}] ${message}`);
}

try {
  const url = $request && $request.url ? $request.url : '';
  let body = $response && $response.body ? $response.body : '';

  log(`matched url=${url}`);

  if (!body) {
    log('empty response body, pass through');
    $done({});
  } else {
    let obj = JSON.parse(body);

    // v0.3.0 only verifies interception safely.
    // Do not alter Apple Weather fields yet.
    obj.weatherCNProDebug = {
      enabled: true,
      version: VERSION,
      url,
      injectedAt: new Date().toISOString()
    };

    log('inject success');
    $done({ body: JSON.stringify(obj) });
  }
} catch (err) {
  log(`error=${err && err.message ? err.message : String(err)}`);
  $done({});
}
