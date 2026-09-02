/*
 * sse-emulation.js
 * Emula o formato SSE do OpenAI quando o cliente envia "stream": true.
 *
 * A resposta ja foi obtida por completo do :generateContent, entao NAO ha ganho de
 * latencia de primeiro token: o objetivo e compatibilidade com SDKs OpenAI que
 * exigem text/event-stream. Streaming real esta documentado no README (Modo B).
 */
(function () {

  var o = LLM.parseJson(context.getVariable('response.content'), null);
  if (!LLM.isObject(o) || !LLM.isArray(o.choices)) { return; }

  var base = {
    id: o.id,
    object: 'chat.completion.chunk',
    created: o.created,
    model: o.model,
    system_fingerprint: o.system_fingerprint
  };

  function frame(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

  var frames = [];

  for (var i = 0; i < o.choices.length; i++) {
    var ch = o.choices[i];
    var idx = ch.index;

    var open = LLM.clone(base);
    open.choices = [{ index: idx, delta: { role: 'assistant', content: '' }, finish_reason: null }];
    frames.push(frame(open));

    var delta = {};
    if (ch.message.content) { delta.content = ch.message.content; }
    if (LLM.isArray(ch.message.tool_calls)) {
      var tcs = [];
      for (var t = 0; t < ch.message.tool_calls.length; t++) {
        var tc = ch.message.tool_calls[t];
        tcs.push({
          index: t,
          id: tc.id,
          type: 'function',
          'function': { name: tc['function'].name, arguments: tc['function'].arguments }
        });
      }
      delta.tool_calls = tcs;
    }
    if (ch.message.refusal) { delta.refusal = ch.message.refusal; }

    var mid = LLM.clone(base);
    mid.choices = [{ index: idx, delta: delta, finish_reason: null }];
    frames.push(frame(mid));

    var close = LLM.clone(base);
    close.choices = [{ index: idx, delta: {}, finish_reason: ch.finish_reason }];
    frames.push(frame(close));
  }

  var usageFrame = LLM.clone(base);
  usageFrame.choices = [];
  usageFrame.usage = o.usage;
  frames.push(frame(usageFrame));
  frames.push('data: [DONE]\n\n');

  context.setVariable('response.content', frames.join(''));
  context.setVariable('response.header.Content-Type', 'text/event-stream; charset=utf-8');
  context.setVariable('response.header.Cache-Control', 'no-cache');
  context.setVariable('response.header.Connection', 'keep-alive');
  context.setVariable('response.header.X-Accel-Buffering', 'no');

})();
