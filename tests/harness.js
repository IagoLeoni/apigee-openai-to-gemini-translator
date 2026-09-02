/*
 * harness.js - simula o objeto `context` do Apigee para exercitar os scripts
 * de traducao fora do runtime. Rode com: node tests/harness.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSC = path.join(__dirname, '..', 'apiproxy', 'resources', 'jsc');

function makeContext(initial) {
  const vars = Object.assign({ messageid: 'abc123-de45-6789-fghi-jklmnopqrstu', 'system.timestamp': 1767225600000 }, initial);
  return {
    getVariable: (k) => (k in vars ? vars[k] : null),
    setVariable: (k, v) => { vars[k] = v; },
    _vars: vars
  };
}

function run(scripts, ctx) {
  const sandbox = { context: ctx, JSON, Math, Date, Number, String, Object, isNaN, print: () => {} };
  vm.createContext(sandbox);
  for (const s of scripts) {
    vm.runInContext(fs.readFileSync(path.join(JSC, s), 'utf8'), sandbox, { filename: s });
  }
  return ctx;
}

const MODEL_MAP = JSON.stringify({
  'gemini-3.7-flash': { id: 'gemini-3.7-flash', maxOutputTokens: 65535, thinkingBudget: -1 },
  'gemini-3.1-flash-lite': { id: 'gemini-3.1-flash-lite', maxOutputTokens: 8192, thinkingBudget: 0 }
});

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failures++; console.log('  FAIL  ' + label + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
}

/* ---------------- Teste 1: request simples ---------------- */
console.log('\n[1] GPT -> Gemini: system + user + parametros');
{
  const req = {
    model: 'gemini-3.7-flash',
    messages: [
      { role: 'system', content: 'Voce e um assistente conciso.' },
      { role: 'user', content: 'Qual a capital da Franca?' }
    ],
    temperature: 0.2, max_tokens: 512, top_p: 0.9, stop: ['\n\n']
  };
  const ctx = run(['llm-common.js', 'openai-to-gemini.js'],
    makeContext({ 'request.content': JSON.stringify(req), 'llm.cfg.model_map': MODEL_MAP }));
  const out = JSON.parse(ctx.getVariable('request.content'));
  console.log(JSON.stringify(out, null, 2));
  check('systemInstruction extraida', out.systemInstruction.parts[0].text.indexOf('conciso') > -1);
  check('contents tem 1 turno user', out.contents.length === 1 && out.contents[0].role === 'user');
  check('max_tokens -> maxOutputTokens', out.generationConfig.maxOutputTokens === 512);
  check('top_p -> topP', out.generationConfig.topP === 0.9);
  check('stop -> stopSequences', out.generationConfig.stopSequences[0] === '\n\n');
  check('llm.model.id resolvido', ctx.getVariable('llm.model.id') === 'gemini-3.7-flash');
  check('sem erro de validacao', ctx.getVariable('llm.error.code') === null);
}

/* ---------------- Teste 2: tools + multimodal + historico ---------------- */
console.log('\n[2] GPT -> Gemini: tool_calls, tool result, imagem, tool_choice');
{
  const req = {
    model: 'gemini-3.1-flash-lite',
    messages: [
      { role: 'user', content: [
          { type: 'text', text: 'O que tem nesta foto e qual o clima la?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
      ]},
      { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rio"}' } }
      ]},
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":29}' },
      { role: 'user', content: 'Resuma.' }
    ],
    tools: [{ type: 'function', function: {
      name: 'get_weather', description: 'Clima atual',
      parameters: { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false, properties: { city: { type: 'string' } }, required: ['city'] }
    }}],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    response_format: { type: 'json_object' }
  };
  const ctx = run(['llm-common.js', 'openai-to-gemini.js'],
    makeContext({ 'request.content': JSON.stringify(req), 'llm.cfg.model_map': MODEL_MAP }));
  const out = JSON.parse(ctx.getVariable('request.content'));
  console.log(JSON.stringify(out, null, 2));
  check('imagem virou inlineData', out.contents[0].parts[1].inlineData.mimeType === 'image/png');
  check('assistant virou role model + functionCall', out.contents[1].role === 'model' && out.contents[1].parts[0].functionCall.name === 'get_weather');
  check('tool result virou functionResponse', out.contents[2].parts[0].functionResponse.response.temp_c === 29);
  check('turnos user consecutivos fundidos', out.contents.length === 3);
  check('$schema removido do parameters', out.tools[0].functionDeclarations[0].parameters.$schema === undefined);
  check('additionalProperties removido', out.tools[0].functionDeclarations[0].parameters.additionalProperties === undefined);
  check('tool_choice forcado -> mode ANY', out.toolConfig.functionCallingConfig.mode === 'ANY');
  check('json_object -> responseMimeType', out.generationConfig.responseMimeType === 'application/json');
  check('thinkingBudget do KVM aplicado', out.generationConfig.thinkingConfig.thinkingBudget === 0);
}

/* ---------------- Teste 3: modelo invalido ---------------- */
console.log('\n[3] Validacao: modelo fora do catalogo');
{
  const ctx = run(['llm-common.js', 'openai-to-gemini.js'], makeContext({
    'request.content': JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'oi' }] }),
    'llm.cfg.model_map': MODEL_MAP
  }));
  check('status 404', ctx.getVariable('llm.error.status') === '404');
  check('code model_not_found', ctx.getVariable('llm.error.code') === 'model_not_found');
  check('lista modelos suportados', ctx.getVariable('llm.error.message').indexOf('gemini-3.7-flash') > -1);
}

/* ---------------- Teste 4: resposta Gemini -> OpenAI ---------------- */
console.log('\n[4] Gemini -> GPT: texto + usage com thinking tokens');
{
  const gemini = {
    candidates: [{ content: { role: 'model', parts: [
        { text: 'raciocinio interno', thought: true },
        { text: 'Paris.' }
      ]}, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 3, thoughtsTokenCount: 40, cachedContentTokenCount: 10, totalTokenCount: 71 }
  };
  const ctx = run(['llm-common.js', 'gemini-to-openai.js'], makeContext({
    'response.content': JSON.stringify(gemini), 'llm.model.alias': 'gemini-3.7-flash'
  }));
  const out = JSON.parse(ctx.getVariable('response.content'));
  console.log(JSON.stringify(out, null, 2));
  check('object chat.completion', out.object === 'chat.completion');
  check('thought part omitida', out.choices[0].message.content === 'Paris.');
  check('finish_reason stop', out.choices[0].finish_reason === 'stop');
  check('prompt_tokens', out.usage.prompt_tokens === 18);
  check('completion_tokens inclui thoughts', out.usage.completion_tokens === 43, out.usage);
  check('total_tokens do upstream', out.usage.total_tokens === 71);
  check('reasoning_tokens detalhado', out.usage.completion_tokens_details.reasoning_tokens === 40);
  check('cached_tokens detalhado', out.usage.prompt_tokens_details.cached_tokens === 10);
  check('var data collector prompt', ctx.getVariable('llm.usage.prompt_tokens') === 18);
  check('var data collector total', ctx.getVariable('llm.usage.total_tokens') === 71);
  check('var data collector finish_reason', ctx.getVariable('llm.finish_reason') === 'stop');
}

/* ---------------- Teste 5: functionCall na resposta ---------------- */
console.log('\n[5] Gemini -> GPT: functionCall vira tool_calls');
{
  const gemini = {
    candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'get_weather', args: { city: 'Rio' } } }
    ]}, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12, totalTokenCount: 62 }
  };
  const ctx = run(['llm-common.js', 'gemini-to-openai.js'], makeContext({
    'response.content': JSON.stringify(gemini), 'llm.model.alias': 'gemini-3.1-flash-lite'
  }));
  const out = JSON.parse(ctx.getVariable('response.content'));
  check('finish_reason tool_calls', out.choices[0].finish_reason === 'tool_calls');
  check('content null', out.choices[0].message.content === null);
  check('arguments serializado', out.choices[0].message.tool_calls[0].function.arguments === '{"city":"Rio"}');
  check('thoughts ausentes -> 0', out.usage.completion_tokens_details.reasoning_tokens === 0);
}

/* ---------------- Teste 6: bloqueio de safety ---------------- */
console.log('\n[6] Gemini -> GPT: prompt bloqueado');
{
  const ctx = run(['llm-common.js', 'gemini-to-openai.js'], makeContext({
    'response.content': JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 } }),
    'llm.model.alias': 'gemini-3.7-flash'
  }));
  const out = JSON.parse(ctx.getVariable('response.content'));
  check('finish_reason content_filter', out.choices[0].finish_reason === 'content_filter');
  check('tokens de prompt ainda contabilizados', ctx.getVariable('llm.usage.prompt_tokens') === 9);
}

/* ---------------- Teste 7: SSE ---------------- */
console.log('\n[7] Emulacao SSE');
{
  const openai = {
    id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'gemini-3.7-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Ola' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, system_fingerprint: 'apigee-llm-gw-v1'
  };
  const ctx = run(['llm-common.js', 'sse-emulation.js'], makeContext({ 'response.content': JSON.stringify(openai) }));
  const sse = ctx.getVariable('response.content');
  console.log(sse);
  check('content-type event-stream', ctx.getVariable('response.header.Content-Type').indexOf('text/event-stream') === 0);
  check('termina com [DONE]', sse.trim().endsWith('data: [DONE]'));
  check('chunk carrega usage', sse.indexOf('"total_tokens":2') > -1);
  check('object chat.completion.chunk', sse.indexOf('chat.completion.chunk') > -1);
}

/* ---------------- Teste 8: erro do Vertex ---------------- */
console.log('\n[8] Erro Vertex -> envelope OpenAI');
{
  const ctx = run(['llm-common.js', 'vertex-error-to-openai.js'], makeContext({
    'response.status.code': 429,
    'response.content': JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } })
  }));
  const out = JSON.parse(ctx.getVariable('response.content'));
  check('type rate_limit_error', out.error.type === 'rate_limit_error');
  check('code rate_limit_exceeded', out.error.code === 'rate_limit_exceeded');
  check('Retry-After setado', ctx.getVariable('response.header.Retry-After') === '30');
}

/* ---------------- Teste 9: /v1/models ---------------- */
console.log('\n[9] GET /v1/models');
{
  const ctx = run(['llm-common.js', 'list-models.js'], makeContext({ 'llm.cfg.model_map': MODEL_MAP }));
  const out = JSON.parse(ctx.getVariable('response.content'));
  check('2 modelos publicados', out.data.length === 2);
  check('ids corretos', out.data.map(m => m.id).sort().join(',') === 'gemini-3.1-flash-lite,gemini-3.7-flash');
}

console.log('\n' + (failures === 0 ? 'TODOS OS TESTES PASSARAM' : failures + ' TESTE(S) FALHARAM'));
process.exit(failures === 0 ? 0 : 1);
