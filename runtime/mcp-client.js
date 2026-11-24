// Minimal MCP (Model Context Protocol) JSON-RPC client over HTTP POST.
// Used by the Wander runtime for the optional visitor-configured MCP server.
// Fail closed: any transport or protocol error is reported as "MCP unavailable"
// and the runtime continues with its local site actions only.
// Written from scratch for Wander.

/** List tools from an MCP server URL. Returns [{name, description, inputSchema}]. */
export async function mcpListTools(serverUrl, { timeoutMs = 8000 } = {}) {
  const data = await mcpCall(serverUrl, "tools/list", {}, timeoutMs);
  const tools = data?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("MCP server did not return a tools array.");
  }
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  }));
}

/** Call one MCP tool. Returns the raw result object. */
export async function mcpCallTool(serverUrl, name, args, { timeoutMs = 15000 } = {}) {
  const data = await mcpCall(serverUrl, "tools/call", { name, arguments: args || {} }, timeoutMs);
  return data;
}

async function mcpCall(serverUrl, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`MCP server HTTP ${res.status}.`);
    }
    const data = await res.json();
    if (data.error) {
      throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
    }
    return data.result ?? {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error("MCP server timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
