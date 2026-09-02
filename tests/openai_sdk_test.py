"""
Prova de compatibilidade: o SDK oficial da OpenAI apontando para o gateway Apigee.
Nenhuma linha de codigo do agente precisa mudar alem de base_url e do header.

    pip install openai
    export APIGEE_HOST=api.minhaempresa.com.br
    export APIKEY=<consumerKey>
    python tests/openai_sdk_test.py
"""
import os
from openai import OpenAI

host = os.environ["APIGEE_HOST"]
apikey = os.environ["APIKEY"]

client = OpenAI(
    base_url=f"https://{host}/llm/v1",
    api_key="nao-usado",                 # a auth real vai no header abaixo
    default_headers={"x-apikey": apikey},
)

print("--- modelos disponiveis ---")
for m in client.models.list().data:
    print(" ", m.id)

print("\n--- chat completion ---")
resp = client.chat.completions.create(
    model="gemini-3.7-flash",
    messages=[
        {"role": "system", "content": "Voce e um engenheiro de plataforma. Seja direto."},
        {"role": "user", "content": "Em duas frases: por que colocar um gateway na frente de um LLM?"},
    ],
    temperature=0.3,
    max_tokens=300,
)
print(resp.choices[0].message.content)
print("usage:", resp.usage)

print("\n--- function calling ---")
resp = client.chat.completions.create(
    model="gemini-3.1-flash-lite",
    messages=[{"role": "user", "content": "Qual o clima em Curitiba?"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Clima atual de uma cidade",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)
print(resp.choices[0].message.tool_calls)

print("\n--- streaming ---")
stream = client.chat.completions.create(
    model="gemini-3.7-flash",
    messages=[{"role": "user", "content": "Liste 3 vantagens de um LLM gateway."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
