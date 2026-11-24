// OpenAI-compatible chat completions client for the Wander runtime (BYOK).
// The visitor's key is attached only to requests sent to the selected router
// and is never placed in URLs, manifests, prompts, or peer-site requests.
// Written from scratch for Wander.

/**
 * Call an OpenAI-compatible /chat/completions endpoint.
 * `tools` is an array of {type:"function", function:{name, description, parameters}}.
 * Returns { content, toolCalls: [{id, name, arguments}], usage }.
 * When onToken is provided, streams tokens (SSE) and calls it per token.
 */
export async function chatCompletions({ baseUrl, model, apiKey, messages, tools, onToken, signal }) {
  const url = String(baseUrl).replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model,
    messages,
    stream: Boolean(onToken),
  };
  if (tools && tools.length) body.tools = tools;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM router ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  if (!onToken) {
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error("LLM router returned no choices.");
    const msg = choice.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeJsonParse(tc.function?.arguments || "{}"),
    }));
    return { content: msg.content || "", toolCalls, usage: data.usage || null };
  }
  // Streaming (SSE) path.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallParts = {};
  const finish = { reason: null };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        toolCallParts[idx] = toolCallParts[idx] || { id: "", name: "", arguments: "" };
        if (tc.id) toolCallParts[idx].id = tc.id;
        if (tc.function?.name) toolCallParts[idx].name = tc.function.name;
        if (typeof tc.function?.arguments === "string") toolCallParts[idx].arguments += tc.function.arguments;
      }
      if (chunk.choices?.[0]?.finish_reason) finish.reason = chunk.choices[0].finish_reason;
    }
  }
  const toolCalls = Object.values(toolCallParts)
    .filter((p) => p.name)
    .map((p) => ({ id: p.id, name: p.name, arguments: safeJsonParse(p.arguments || "{}") }));
  return { content, toolCalls, usage: null };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
