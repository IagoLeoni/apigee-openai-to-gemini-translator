/*
 * llm-common.js
 * Helpers compartilhados. Carregado via <IncludeURL> antes de cada <ResourceURL>.
 * IMPORTANTE: o motor JS do Apigee e Rhino (ES5). Nao use let/const/arrow/template literals.
 */
var LLM = (function () {

  function parseJson(s, fallback) {
    if (s === null || s === undefined || s === '') { return fallback; }
    try { return JSON.parse(String(s)); } catch (e) { return fallback; }
  }

  function isArray(o) { return Object.prototype.toString.call(o) === '[object Array]'; }
  function isString(o) { return typeof o === 'string'; }
  function isObject(o) { return o !== null && typeof o === 'object' && !isArray(o); }

  function num(v, dflt) {
    if (v === null || v === undefined || v === '') { return dflt; }
    var n = Number(v);
    return isNaN(n) ? dflt : n;
  }

  /* Marca um erro de cliente. RF-ClientError le estas variaveis e monta o payload OpenAI. */
  function setError(status, type, code, message, param, reason) {
    context.setVariable('llm.error.status', String(status));
    context.setVariable('llm.error.type', type);
    context.setVariable('llm.error.code', code);
    context.setVariable('llm.error.message', String(message).replace(/"/g, "'"));
    context.setVariable('llm.error.param', param || '');
    context.setVariable('llm.error.reason', reason || 'Bad Request');
  }

  /* Id determinístico e rastreavel: reaproveita o messageid do Apigee. */
  function requestId(prefix) {
    var mid = context.getVariable('messageid');
    if (!mid) {
      mid = '';
      var hex = '0123456789abcdef';
      for (var i = 0; i < 32; i++) { mid += hex.charAt(Math.floor(Math.random() * 16)); }
    }
    return prefix + String(mid).replace(/-/g, '');
  }

  function nowSeconds() {
    var ts = num(context.getVariable('system.timestamp'), 0);
    if (ts > 0) { return Math.floor(ts / 1000); }
    return Math.floor(new Date().getTime() / 1000);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  return {
    parseJson: parseJson,
    isArray: isArray,
    isString: isString,
    isObject: isObject,
    num: num,
    setError: setError,
    requestId: requestId,
    nowSeconds: nowSeconds,
    clone: clone
  };
})();
