/*
 * gemini-to-openai.js
 * Traduz a resposta :generateContent do Vertex AI para o objeto OpenAI chat.completion
 * e publica as variaveis de consumo de tokens lidas pela DataCapture policy.
 *
 * Entradas : response.content, llm.model.alias
 * Saidas   : response.content (objeto OpenAI), llm.usage.*, llm.finish_reason
 */
(function () {

  var g = LLM.parseJson(context.getVariable('response.content'), null);
  var model = context.getVariable('llm.model.alias') || '';
  var id = LLM.requestId('chatcmpl-');
  var created = LLM.nowSeconds();

  function mapFinishReason(fr, hasToolCalls) {
    if (hasToolCalls) { return 'tool_calls'; }
    switch (fr) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY':
      case 'RECITATION':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
        return 'content_filter';
      case 'MALFORMED_FUNCTION_CALL': return 'tool_calls';
      default: return fr ? 'stop' : null;
    }
  }

  if (!LLM.isObject(g)) {
    /* Upstream devolveu 200 com corpo inesperado: nao mascara, devolve erro explicito. */
    context.setVariable('response.content', JSON.stringify({
      error: {
        message: 'Resposta do Vertex AI em formato inesperado.',
        type: 'api_error', param: null, code: 'upstream_malformed_response'
      }
    }));
    context.setVariable('response.status.code', 502);
    context.setVariable('response.header.Content-Type', 'application/json');
    return;
  }

  var choices = [];
  var candidates = LLM.isArray(g.candidates) ? g.candidates : [];

  /* Prompt bloqueado antes de gerar candidatos. */
  if (candidates.length === 0 && LLM.isObject(g.promptFeedback) && g.promptFeedback.blockReason) {
    choices.push({
      index: 0,
      message: { role: 'assistant', content: null, refusal: 'Conteudo bloqueado pelas politicas de seguranca do modelo (' + g.promptFeedback.blockReason + ').' },
      finish_reason: 'content_filter',
      logprobs: null
    });
  }

  var toolCallSeq = 0;

  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    var text = '';
    var toolCalls = [];
    var parts = (LLM.isObject(cand.content) && LLM.isArray(cand.content.parts)) ? cand.content.parts : [];

    for (var p = 0; p < parts.length; p++) {
      var part = parts[p];
      if (!LLM.isObject(part)) { continue; }
      if (part.thought === true) { continue; }  /* nao expoe o raciocinio interno ao cliente */
      if (typeof part.text === 'string') {
        text += part.text;
      } else if (LLM.isObject(part.functionCall)) {
        toolCallSeq++;
        toolCalls.push({
          id: 'call_' + String(toolCallSeq) + '_' + id.substring(9, 21),
          type: 'function',
          'function': {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {})
          }
        });
      }
    }

    var message = { role: 'assistant', content: (toolCalls.length > 0 && text === '') ? null : text };
    if (toolCalls.length > 0) { message.tool_calls = toolCalls; }

    choices.push({
      index: (cand.index !== undefined && cand.index !== null) ? cand.index : i,
      message: message,
      finish_reason: mapFinishReason(cand.finishReason, toolCalls.length > 0),
      logprobs: null
    });
  }

  /* ---------- Contabilizacao de tokens ---------- */

  var um = LLM.isObject(g.usageMetadata) ? g.usageMetadata : {};
  var promptTokens = LLM.num(um.promptTokenCount, 0);
  var candidateTokens = LLM.num(um.candidatesTokenCount, 0);
  var thoughtTokens = LLM.num(um.thoughtsTokenCount, 0);
  var cachedTokens = LLM.num(um.cachedContentTokenCount, 0);

  /* No schema OpenAI os reasoning tokens sao faturados dentro de completion_tokens. */
  var completionTokens = candidateTokens + thoughtTokens;
  var totalTokens = LLM.num(um.totalTokenCount, promptTokens + completionTokens);

  var out = {
    id: id,
    object: 'chat.completion',
    created: created,
    model: model,
    choices: choices,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: thoughtTokens, audio_tokens: 0 }
    },
    system_fingerprint: 'apigee-llm-gw-v1'
  };

  context.setVariable('response.content', JSON.stringify(out));
  context.setVariable('response.header.Content-Type', 'application/json; charset=utf-8');

  /* Variaveis consumidas pela DataCapture (tipos numericos, nao strings). */
  context.setVariable('llm.usage.prompt_tokens', promptTokens);
  context.setVariable('llm.usage.completion_tokens', completionTokens);
  context.setVariable('llm.usage.total_tokens', totalTokens);
  context.setVariable('llm.usage.cached_tokens', cachedTokens);
  context.setVariable('llm.usage.reasoning_tokens', thoughtTokens);
  context.setVariable('llm.finish_reason', (choices.length > 0 && choices[0].finish_reason) ? choices[0].finish_reason : 'none');

})();
