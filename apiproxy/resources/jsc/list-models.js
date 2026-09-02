/*
 * list-models.js
 * Responde GET /v1/models no schema OpenAI, derivado do KVM llm-gateway-config.
 * Fonte unica de verdade: adicionar um modelo ao model_map ja o publica aqui.
 */
(function () {

  var modelMap = LLM.parseJson(context.getVariable('llm.cfg.model_map'), {});
  var created = LLM.nowSeconds();
  var data = [];

  for (var alias in modelMap) {
    if (!modelMap.hasOwnProperty(alias)) { continue; }
    data.push({
      id: alias,
      object: 'model',
      created: created,
      owned_by: 'google-vertex-ai'
    });
  }

  context.setVariable('response.content', JSON.stringify({ object: 'list', data: data }));
  context.setVariable('response.header.Content-Type', 'application/json; charset=utf-8');
  context.setVariable('response.status.code', 200);

})();
