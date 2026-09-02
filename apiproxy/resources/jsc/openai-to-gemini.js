/*
 * openai-to-gemini.js
 * Traduz o corpo OpenAI /v1/chat/completions para o corpo Vertex AI :generateContent.
 *
 * Entradas : request.content, llm.cfg.model_map (KVM)
 * Saidas   : request.content (payload Gemini), llm.model.id, llm.model.alias,
 *            llm.stream, llm.end_user, llm.error.* em caso de validacao reprovada
 */
(function () {

  /* ---------- 1. Parse e validacao basica ---------- */

  var body = LLM.parseJson(context.getVariable('request.content'), null);
  if (!LLM.isObject(body)) {
    LLM.setError(400, 'invalid_request_error', 'invalid_json',
      'Corpo da requisicao ausente ou JSON malformado.', 'body', 'Bad Request');
    return;
  }

  var alias = body.model;
  if (!LLM.isString(alias) || alias === '') {
    LLM.setError(400, 'invalid_request_error', 'missing_required_parameter',
      'O campo "model" e obrigatorio.', 'model', 'Bad Request');
    return;
  }

  /* ---------- 2. Resolucao do modelo via KVM ---------- */

  var modelMap = LLM.parseJson(context.getVariable('llm.cfg.model_map'), {});
  var cfg = modelMap[alias];
  if (!cfg) {
    var supported = [];
    for (var k in modelMap) { if (modelMap.hasOwnProperty(k)) { supported.push(k); } }
    LLM.setError(404, 'invalid_request_error', 'model_not_found',
      'O modelo "' + alias + '" nao existe ou nao esta habilitado neste gateway. Modelos disponiveis: ' + supported.join(', ') + '.',
      'model', 'Not Found');
    return;
  }

  context.setVariable('llm.model.alias', alias);
  context.setVariable('llm.model.id', cfg.id || alias);
  context.setVariable('llm.stream', body.stream === true);
  context.setVariable('llm.end_user', body.user || '');

  var messages = body.messages;
  if (!LLM.isArray(messages) || messages.length === 0) {
    LLM.setError(400, 'invalid_request_error', 'missing_required_parameter',
      'O campo "messages" e obrigatorio e deve ser um array nao vazio.', 'messages', 'Bad Request');
    return;
  }

  /* ---------- 3. Helpers de conversao de conteudo ---------- */

  function mimeFromUrl(url) {
    var u = String(url).toLowerCase();
    if (u.indexOf('.png') > -1) { return 'image/png'; }
    if (u.indexOf('.webp') > -1) { return 'image/webp'; }
    if (u.indexOf('.gif') > -1) { return 'image/gif'; }
    if (u.indexOf('.pdf') > -1) { return 'application/pdf'; }
    return 'image/jpeg';
  }

  function imagePart(url) {
    if (String(url).indexOf('data:') === 0) {
      var comma = url.indexOf(',');
      var meta = url.substring(5, comma);
      var semi = meta.indexOf(';');
      var mime = semi > -1 ? meta.substring(0, semi) : meta;
      return { inlineData: { mimeType: mime, data: url.substring(comma + 1) } };
    }
    /* gs:// e https:// vao como fileData (o Vertex faz o fetch) */
    return { fileData: { mimeType: mimeFromUrl(url), fileUri: url } };
  }

  function partsFromContent(content) {
    var parts = [];
    if (LLM.isString(content)) {
      if (content.length > 0) { parts.push({ text: content }); }
      return parts;
    }
    if (LLM.isArray(content)) {
      for (var i = 0; i < content.length; i++) {
        var c = content[i];
        if (!LLM.isObject(c)) { continue; }
        if (c.type === 'text' && LLM.isString(c.text) && c.text.length > 0) {
          parts.push({ text: c.text });
        } else if (c.type === 'image_url' && LLM.isObject(c.image_url) && c.image_url.url) {
          parts.push(imagePart(c.image_url.url));
        } else if (c.type === 'input_audio' && LLM.isObject(c.input_audio) && c.input_audio.data) {
          parts.push({ inlineData: { mimeType: 'audio/' + (c.input_audio.format || 'wav'), data: c.input_audio.data } });
        }
      }
    }
    return parts;
  }

  /* Gemini aceita apenas um subconjunto do OpenAPI Schema. Remove o que nao e suportado. */
  var ALLOWED_SCHEMA_KEYS = {
    type: 1, format: 1, description: 1, nullable: 1, 'enum': 1, items: 1,
    properties: 1, required: 1, anyOf: 1, propertyOrdering: 1,
    minimum: 1, maximum: 1, minItems: 1, maxItems: 1,
    minLength: 1, maxLength: 1, pattern: 1, title: 1, example: 1, 'default': 1
  };

  function sanitizeSchema(s) {
    if (!LLM.isObject(s)) { return s; }
    var out = {};
    for (var key in s) {
      if (!s.hasOwnProperty(key)) { continue; }
      if (!ALLOWED_SCHEMA_KEYS[key]) { continue; }
      var v = s[key];
      if (key === 'properties' && LLM.isObject(v)) {
        var props = {};
        for (var pk in v) { if (v.hasOwnProperty(pk)) { props[pk] = sanitizeSchema(v[pk]); } }
        out[key] = props;
      } else if (key === 'items') {
        out[key] = sanitizeSchema(v);
      } else if (key === 'anyOf' && LLM.isArray(v)) {
        var arr = [];
        for (var i = 0; i < v.length; i++) { arr.push(sanitizeSchema(v[i])); }
        out[key] = arr;
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  /* ---------- 4. messages[] -> contents[] + systemInstruction ---------- */

  var contents = [];
  var systemTexts = [];
  var toolCallNames = {};   /* tool_call_id -> nome da funcao, para casar o functionResponse */

  for (var m = 0; m < messages.length; m++) {
    var msg = messages[m];
    if (!LLM.isObject(msg)) { continue; }
    var role = msg.role;

    if (role === 'system' || role === 'developer') {
      var sysParts = partsFromContent(msg.content);
      for (var s = 0; s < sysParts.length; s++) {
        if (sysParts[s].text) { systemTexts.push(sysParts[s].text); }
      }
      continue;
    }

    if (role === 'tool' || role === 'function') {
      var fnName = msg.name || toolCallNames[msg.tool_call_id] || 'unknown_function';
      var parsed = LLM.parseJson(msg.content, null);
      var respObj;
      if (LLM.isObject(parsed)) { respObj = parsed; }
      else if (parsed !== null) { respObj = { result: parsed }; }
      else { respObj = { result: msg.content }; }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: fnName, response: respObj } }]
      });
      continue;
    }

    if (role === 'assistant') {
      var aParts = partsFromContent(msg.content);
      if (LLM.isArray(msg.tool_calls)) {
        for (var t = 0; t < msg.tool_calls.length; t++) {
          var tc = msg.tool_calls[t];
          if (LLM.isObject(tc) && LLM.isObject(tc['function'])) {
            var name = tc['function'].name;
            if (tc.id) { toolCallNames[tc.id] = name; }
            aParts.push({
              functionCall: { name: name, args: LLM.parseJson(tc['function'].arguments, {}) }
            });
          }
        }
      }
      if (aParts.length > 0) { contents.push({ role: 'model', parts: aParts }); }
      continue;
    }

    /* role === 'user' (e qualquer outro nao reconhecido) */
    var uParts = partsFromContent(msg.content);
    if (uParts.length > 0) { contents.push({ role: 'user', parts: uParts }); }
  }

  /* Gemini prefere turnos alternados: funde mensagens consecutivas do mesmo role. */
  var merged = [];
  for (var c = 0; c < contents.length; c++) {
    if (merged.length > 0 && merged[merged.length - 1].role === contents[c].role) {
      merged[merged.length - 1].parts = merged[merged.length - 1].parts.concat(contents[c].parts);
    } else {
      merged.push(contents[c]);
    }
  }

  if (merged.length === 0) {
    LLM.setError(400, 'invalid_request_error', 'empty_conversation',
      'Nenhuma mensagem de usuario ou assistente utilizavel foi encontrada em "messages".', 'messages', 'Bad Request');
    return;
  }

  /* ---------- 5. Parametros de geracao ---------- */

  var gc = {};
  var maxOut = body.max_completion_tokens;
  if (maxOut === undefined || maxOut === null) { maxOut = body.max_tokens; }
  if (maxOut !== undefined && maxOut !== null) {
    var cap = LLM.num(cfg.maxOutputTokens, 65535);
    gc.maxOutputTokens = Math.min(LLM.num(maxOut, cap), cap);
  } else if (cfg.defaultMaxOutputTokens) {
    gc.maxOutputTokens = LLM.num(cfg.defaultMaxOutputTokens, 4096);
  }

  if (body.temperature !== undefined && body.temperature !== null) { gc.temperature = LLM.num(body.temperature, 1); }
  if (body.top_p !== undefined && body.top_p !== null) { gc.topP = LLM.num(body.top_p, 1); }
  if (body.seed !== undefined && body.seed !== null) { gc.seed = LLM.num(body.seed, 0); }
  if (body.presence_penalty !== undefined && body.presence_penalty !== null) { gc.presencePenalty = LLM.num(body.presence_penalty, 0); }
  if (body.frequency_penalty !== undefined && body.frequency_penalty !== null) { gc.frequencyPenalty = LLM.num(body.frequency_penalty, 0); }
  if (body.n !== undefined && body.n !== null) { gc.candidateCount = LLM.num(body.n, 1); }

  if (body.stop) {
    gc.stopSequences = LLM.isArray(body.stop) ? body.stop : [String(body.stop)];
  }

  if (body.logprobs === true) {
    gc.responseLogprobs = true;
    if (body.top_logprobs) { gc.logprobs = LLM.num(body.top_logprobs, 1); }
  }

  if (LLM.isObject(body.response_format)) {
    if (body.response_format.type === 'json_object') {
      gc.responseMimeType = 'application/json';
    } else if (body.response_format.type === 'json_schema' && LLM.isObject(body.response_format.json_schema)) {
      gc.responseMimeType = 'application/json';
      gc.responseSchema = sanitizeSchema(body.response_format.json_schema.schema);
    }
  }

  /* reasoning_effort (OpenAI) -> thinkingConfig (Gemini) */
  if (body.reasoning_effort) {
    var budgets = { minimal: 0, low: 1024, medium: 8192, high: 24576 };
    var budget = budgets[body.reasoning_effort];
    gc.thinkingConfig = { thinkingBudget: (budget === undefined ? -1 : budget), includeThoughts: false };
  } else if (cfg.thinkingBudget !== undefined && cfg.thinkingBudget !== null) {
    gc.thinkingConfig = { thinkingBudget: LLM.num(cfg.thinkingBudget, -1), includeThoughts: false };
  }

  /* ---------- 6. Tools / function calling ---------- */

  var declarations = [];
  if (LLM.isArray(body.tools)) {
    for (var i = 0; i < body.tools.length; i++) {
      var tool = body.tools[i];
      if (LLM.isObject(tool) && tool.type === 'function' && LLM.isObject(tool['function'])) {
        var f = tool['function'];
        var decl = { name: f.name };
        if (f.description) { decl.description = f.description; }
        if (LLM.isObject(f.parameters)) { decl.parameters = sanitizeSchema(f.parameters); }
        declarations.push(decl);
      }
    }
  } else if (LLM.isArray(body.functions)) {
    for (var j = 0; j < body.functions.length; j++) {
      var fn = body.functions[j];
      if (LLM.isObject(fn)) {
        var d = { name: fn.name };
        if (fn.description) { d.description = fn.description; }
        if (LLM.isObject(fn.parameters)) { d.parameters = sanitizeSchema(fn.parameters); }
        declarations.push(d);
      }
    }
  }

  var toolConfig = null;
  var tc2 = body.tool_choice || body.function_call;
  if (tc2) {
    if (tc2 === 'none') {
      toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (tc2 === 'auto') {
      toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    } else if (tc2 === 'required') {
      toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (LLM.isObject(tc2)) {
      var forced = (tc2['function'] && tc2['function'].name) ? tc2['function'].name : tc2.name;
      if (forced) {
        toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [forced] } };
      }
    }
  }

  /* ---------- 7. Montagem do payload Gemini ---------- */

  var gemini = { contents: merged };

  if (systemTexts.length > 0) {
    gemini.systemInstruction = { role: 'system', parts: [{ text: systemTexts.join('\n\n') }] };
  }
  if (declarations.length > 0) {
    gemini.tools = [{ functionDeclarations: declarations }];
  }
  if (toolConfig) { gemini.toolConfig = toolConfig; }
  if (LLM.isArray(cfg.safetySettings)) { gemini.safetySettings = cfg.safetySettings; }

  gemini.generationConfig = gc;

  var payload = JSON.stringify(gemini);
  context.setVariable('request.content', payload);
  context.setVariable('llm.request.messages_count', messages.length);
  context.setVariable('llm.request.bytes', payload.length);
  context.setVariable('llm.request.has_tools', declarations.length > 0);

})();
