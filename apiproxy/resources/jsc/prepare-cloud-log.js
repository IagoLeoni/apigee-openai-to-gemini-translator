/*
 * prepare-cloud-log.js
 * Monta o payload JSON estruturado de auditoria e telemetria para o Cloud Logging.
 * Roda no PostFlow e DefaultFaultRule para ser despachado assincronamente no PostClientFlow.
 */
(function () {
  var logObj = {
    timestamp: LLM.nowSeconds(),
    messageId: context.getVariable('messageid'),
    proxy: context.getVariable('apiproxy.name'),
    environment: context.getVariable('environment.name'),
    clientIp: context.getVariable('client.ip'),
    developerApp: context.getVariable('developer.app.name') || 'anonymous',
    developerEmail: context.getVariable('developer.email') || 'anonymous',
    apiProduct: context.getVariable('verifyapikey.VA-VerifyApiKey.apiproduct.name') || 'none',
    httpMethod: context.getVariable('request.verb'),
    path: context.getVariable('proxy.pathsuffix'),
    statusCode: LLM.num(context.getVariable('response.status.code'), 200),
    model: context.getVariable('llm.model.alias') || 'unknown',
    modelId: context.getVariable('llm.model.id') || 'unknown',
    endUser: context.getVariable('llm.end_user') || '',
    isStreaming: context.getVariable('llm.stream') === true,
    usage: {
      promptTokens: LLM.num(context.getVariable('llm.usage.prompt_tokens'), 0),
      completionTokens: LLM.num(context.getVariable('llm.usage.completion_tokens'), 0),
      reasoningTokens: LLM.num(context.getVariable('llm.usage.reasoning_tokens'), 0),
      totalTokens: LLM.num(context.getVariable('llm.usage.total_tokens'), 0)
    },
    finishReason: context.getVariable('llm.finish_reason') || 'stop',
    requestPayload: LLM.parseJson(context.getVariable('request.content'), context.getVariable('request.content')),
    responsePayload: LLM.parseJson(context.getVariable('response.content'), context.getVariable('response.content'))
  };

  context.setVariable('llm.log.json', JSON.stringify(logObj));
})();
