/*
 * vertex-error-to-openai.js
 * Normaliza erros do Vertex AI para o envelope de erro do OpenAI, para que o cliente
 * (SDK OpenAI) trate 400/401/429/5xx sem branch especifico de fornecedor.
 *
 * Roda apenas quando response.status.code != 200. Exige success.codes = 1xx..5xx
 * no HTTPTargetConnection, senao o Apigee levanta fault antes desta policy.
 */
(function () {

  var status = LLM.num(context.getVariable('response.status.code'), 500);
  var raw = LLM.parseJson(context.getVariable('response.content'), null);

  var g = raw;
  if (LLM.isArray(raw) && raw.length > 0) { g = raw[0]; }  /* Vertex as vezes devolve array */

  var message = 'Erro no upstream Vertex AI.';
  var code = 'upstream_error';
  var type = 'api_error';

  if (LLM.isObject(g) && LLM.isObject(g.error)) {
    if (g.error.message) { message = String(g.error.message); }
    if (g.error.status) { code = String(g.error.status); }
  }

  if (status === 429 || code === 'RESOURCE_EXHAUSTED') {
    type = 'rate_limit_error';
    code = 'rate_limit_exceeded';
    context.setVariable('response.header.Retry-After', '30');
  } else if (status === 400) {
    type = 'invalid_request_error';
  } else if (status === 404) {
    type = 'invalid_request_error';
    code = 'model_not_found';
    message = 'O modelo nao esta disponivel na regiao/projeto configurados. Verifique vertex_location e o model id no KVM llm-gateway-config.';
  } else if (status === 401 || status === 403) {
    type = 'authentication_error';
    code = 'upstream_forbidden';
    message = 'O gateway nao conseguiu autenticar no Vertex AI. Verifique se a service account de deploy tem roles/aiplatform.user no projeto.';
  } else if (status >= 500) {
    type = 'api_error';
  }

  context.setVariable('response.content', JSON.stringify({
    error: { message: message.replace(/"/g, "'"), type: type, param: null, code: code }
  }));
  context.setVariable('response.header.Content-Type', 'application/json; charset=utf-8');
  context.setVariable('llm.upstream.error_code', code);
  context.setVariable('llm.finish_reason', 'error');

})();
