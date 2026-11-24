// Wander browser runtime — runs an open agentic website's agent network in
// the browser, following the Open Agentic Web MVP spec (profile 0.3).
// - Loads and validates the manifest + resolved network definition (fail closed).
// - Runs the agent loop with a pluggable model: the visitor's BYOK LLM
//   (OpenAI-compatible, function calling) or, with no key, the deterministic
//   local demo router. Both paths call the same site actions and peer networks.
// - Peer networks: spec §3.2 protocol — manifest fetch, exact-name match,
//   definition fetch + validate, run locally in the caller's browser with the
//   caller's router and key. Consent before every peer contact; the visitor's
//   key is never sent to a peer. Private context (sly_data) is deny-by-default.
// - Site actions: schema-validated, visitor-confirmed before writes.
// - Execution limits: delegation depth, tool calls, elapsed time; cycles stop.
// Written from scratch for Wander; it does not copy any reference runtime.
import {
  validateManifest,
  validateNetwork,
  checkToolReferences,
  splitPeerUrl,
  resolvePeerUrl,
  validateAgainstSchema,
} from "./core.js";
import { chatCompletions } from "./llm-client.js";
import { mcpListTools, mcpCallTool } from "./mcp-client.js";
import { detectIntent, planSteps, composeAnswer, fulfillPeer } from "./local-router.js";
import { buildSiteActions } from "./site-actions.js";

export const MAX_DEPTH = 4;
export const MAX_TOOL_CALLS = 20;
export const MAX_ROUNDS = 6;

export class WanderRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - site base URL (origin + path) for the manifest.
   * @param {object} opts.catalog - the site's city catalog (grounded data).
   * @param {object} opts.store - trip store { get(), set(trip), save() }.
   * @param {function} opts.onEvent - (event) => void, activity log.
   * @param {function} opts.onConsent - ({origin, purpose}) => Promise<boolean>.
   * @param {function} opts.onConfirm - ({action, args, summary}) => Promise<boolean>.
   * @param {object} [opts.llm] - { baseUrl, model, apiKey, mcpUrl } (BYOK).
   */
  constructor(opts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "") + "/";
    this.catalog = opts.catalog;
    this.store = opts.store;
    this.onEvent = opts.onEvent || (() => {});
    this.onConsent = opts.onConsent || (async () => false);
    this.onConfirm = opts.onConfirm || (async () => false);
    this.llm = opts.llm || { baseUrl: "", model: "gpt-4o-mini", apiKey: "", mcpUrl: "" };
    this.manifest = null;
    this.network = null;
    this.links = {};
    this.siteActions = [];
    this.mcpTools = [];
    this.userApprovedPeers = new Set();
    this.peerCatalogs = new Map(); // peer network name -> catalog (demo mode)
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      // Logging must never break a run.
    }
  }

  get useLlm() {
    return Boolean(this.llm.apiKey && this.llm.baseUrl);
  }

  async init() {
    this.manifest = validateManifest(await this.fetchJson(this.baseUrl + "agents/agent-manifest.json"));
    const networkEntry = this.manifest.networks[0];
    this.network = validateNetwork(
      await this.fetchJson(resolvePeerUrl(networkEntry.hocon, this.baseUrl + "agents/"))
    );
    try {
      this.links = await this.fetchJson(this.baseUrl + "agents/links.json");
    } catch {
      this.links = { networks: {} };
    }
    this.siteActions = buildSiteActions({ catalog: this.catalog, store: this.store });
    const linkNames = new Set(Object.keys((this.links.networks || {})[networkEntry.name] || {}));
    const actionNames = new Set(this.siteActions.map((a) => a.name));
    checkToolReferences(this.network, linkNames, actionNames);
    this.emit({ type: "ready", networks: this.manifest.networks.map((n) => n.name), front: networkEntry.front_man });
    if (this.llm.mcpUrl) await this.refreshMcpTools();
    return this;
  }

  async fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Could not fetch ${url} (HTTP ${res.status}).`);
    return res.json();
  }

  async refreshMcpTools() {
    if (!this.llm.mcpUrl) {
      this.mcpTools = [];
      return;
    }
    try {
      this.mcpTools = await mcpListTools(this.llm.mcpUrl);
      this.emit({ type: "mcp", status: `MCP connected: ${this.mcpTools.length} tool(s) from ${this.llm.mcpUrl}.` });
    } catch (err) {
      this.mcpTools = [];
      this.emit({ type: "mcp", status: `MCP unavailable (${err.message}). Continuing with local site actions only.` });
    }
  }

  // ---- public entry point ----
  async run(inquiry) {
    const started = Date.now();
    const maxMs = (this.network.max_execution_seconds || 120) * 1000;
    const ctx = {
      started,
      maxMs,
      depth: 0,
      toolCalls: 0,
      seen: new Map(),
      history: [],
    };
    this.emit({ type: "run-start", inquiry, mode: this.useLlm ? "llm" : "demo" });
    try {
      const answer = this.useLlm
        ? await this.runWithLlm(inquiry, ctx)
        : await this.runWithDemoRouter(inquiry, ctx);
      this.emit({ type: "answer", text: answer });
      return answer;
    } catch (err) {
      this.emit({ type: "error", message: err.message });
      throw err;
    }
  }

  checkBudget(ctx, what) {
    if (Date.now() - ctx.started > ctx.maxMs) {
      throw new Error(`Execution stopped: over the ${Math.round(ctx.maxMs / 1000)}s time budget (${what}).`);
    }
    if (ctx.toolCalls >= MAX_TOOL_CALLS) {
      throw new Error(`Execution stopped: over the ${MAX_TOOL_CALLS} tool-call budget (${what}).`);
    }
    if (ctx.depth > MAX_DEPTH) {
      throw new Error(`Execution stopped: delegation depth over ${MAX_DEPTH} (${what}).`);
    }
  }

  checkCycle(ctx, signature) {
    const count = (ctx.seen.get(signature) || 0) + 1;
    ctx.seen.set(signature, count);
    if (count >= 3) {
      throw new Error(`Execution stopped: possible cycle — '${signature}' was invoked ${count} times.`);
    }
  }

  // ---- demo (no-key) path ----
  async runWithDemoRouter(inquiry, ctx) {
    const state = this.store.get();
    const intent = detectIntent(inquiry);
    const plan = planSteps(intent, state, this.catalog);
    this.emit({ type: "agent", name: plan.agent, note: "demo router" });
    const results = [];
    // All write steps in one run share a single confirmation dialog listing
    // every proposed write, so the visitor approves the plan once.
    let writesDecision = null;
    const writeSteps = plan.steps.filter((s) => s.kind === "tool" && this.isWriteAction(s.name));
    for (const step of plan.steps) {
      this.checkBudget(ctx, "demo run");
      if (step.kind === "tool") {
        if (this.isWriteAction(step.name)) {
          if (writesDecision === null) {
            const list = writeSteps.map((w) => `${w.name} ${JSON.stringify(w.args)}`).join("\n");
            writesDecision = await this.onConfirm({
              action: "apply_plan",
              args: {},
              summary: `Apply this plan?\n${list}`,
            });
            if (!writesDecision) {
              this.emit({ type: "tool-result", name: "apply_plan", ok: false, note: "visitor declined the plan" });
            }
          }
          if (!writesDecision) {
            results.push({ kind: "tool", name: step.name, data: null, declined: true });
            continue;
          }
          // Confirmed once: execute without asking again for this run.
          results.push(await this.callSiteActionDirect(step.name, step.args, ctx));
        } else {
          results.push(await this.callSiteAction(step.name, step.args, ctx));
        }
      } else if (step.kind === "peer") {
        const peer = await this.callPeer(step.link, step.inquiry, ctx);
        results.push(peer);
      }
    }
    if (plan.note === "save") {
      const built = results.find((r) => r.kind === "tool" && r.name === "build_itinerary");
      if (!built?.data) throw new Error("Could not build the itinerary to save.");
      const confirmed = await this.onConfirm({
        action: "save_trip",
        args: {},
        summary: "Save this trip in your browser?",
      });
      if (!confirmed) return "Okay — the trip was not saved.";
      const saved = await this.callSiteActionDirect("save_trip", {}, ctx);
      const cost = built.data.cost;
      return (
        `Saved. Receipt ${saved.data.receipt.id} — ${saved.data.receipt.summary}. ` +
        `Total estimated cost $${cost.totalUsd}. Nothing is booked; this is a saved plan.`
      );
    }
    return composeAnswer(intent, plan, results, this.store.get(), this.catalog);
  }

  isWriteAction(name) {
    const action = this.siteActions.find((a) => a.name === name);
    return action?.effect === "write";
  }

  /** Execute a site action after its write was already confirmed once. */
  async callSiteActionDirect(name, args, ctx) {
    const action = this.siteActions.find((a) => a.name === name);
    if (!action) throw new Error(`Unknown site action '${name}'.`);
    const schemaErrors = validateAgainstSchema(args || {}, action.parameters);
    if (schemaErrors.length) {
      throw new Error(`Invalid arguments for '${name}': ${schemaErrors.join(" ")}`);
    }
    this.emit({ type: "tool", name, args });
    const data = await action.handler(args || {});
    this.emit({ type: "tool-result", name, ok: true });
    return { kind: "tool", name, data };
  }

  // ---- LLM (BYOK) path ----
  async runWithLlm(inquiry, ctx) {
    const agent = this.network.tools.find((a) => a.name === this.manifest.networks[0].front_man);
    if (!agent) throw new Error(`Front agent '${this.manifest.networks[0].front_man}' not found in the network.`);
    const tools = this.buildLlmTools();
    const system = [
      agent.instructions,
      "",
      "Grounding: answer only from the site's city catalog and the results of the tools you call. Never invent stays, activities, prices, or availability. Never claim a booking was made.",
      `Current trip draft: ${JSON.stringify(this.store.get())}`,
      `Catalog cities: ${this.catalog.cities.map((c) => `${c.name} (${c.id})`).join(", ")}.`,
      "Private context: no private fields are forwarded to any peer network.",
    ].join("\n");
    const messages = [
      { role: "system", content: system },
      { role: "user", content: inquiry },
    ];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      this.checkBudget(ctx, "LLM run");
      const { content, toolCalls } = await chatCompletions({
        baseUrl: this.llm.baseUrl,
        model: this.llm.model,
        apiKey: this.llm.apiKey,
        messages,
        tools,
      });
      if (!toolCalls.length) {
        return content || "I couldn't produce an answer for that.";
      }
      messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })) });
      for (const tc of toolCalls) {
        ctx.toolCalls++;
        this.checkBudget(ctx, "LLM tool call");
        const result = await this.dispatchLlmTool(tc, ctx);
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("Execution stopped: the model did not finish within the round limit.");
  }

  buildLlmTools() {
    const tools = [];
    for (const a of this.network.tools) {
      if (a.name === this.manifest.networks[0].front_man) continue;
      tools.push({
        type: "function",
        function: {
          name: `agent_${a.name}`,
          description: a.function.description,
          parameters: a.function.parameters,
        },
      });
    }
    for (const a of this.siteActions) {
      tools.push({
        type: "function",
        function: { name: `website_${a.name}`, description: a.description, parameters: a.parameters },
      });
    }
    const linkNames = Object.keys((this.links.networks || {})[this.manifest.networks[0].name] || {});
    for (const link of linkNames) {
      tools.push({
        type: "function",
        function: {
          name: `peer_${link}`,
          description: `Ask the linked peer network '${link}' (runs in this browser after visitor approval).`,
          parameters: {
            type: "object",
            properties: { inquiry: { type: "string", description: "The question for the peer network." } },
            required: ["inquiry"],
          },
        },
      });
    }
    for (const t of this.mcpTools) {
      tools.push({
        type: "function",
        function: { name: `mcp_${t.name}`, description: `MCP tool: ${t.description}`, parameters: t.inputSchema },
      });
    }
    return tools;
  }

  async dispatchLlmTool(tc, ctx) {
    const { name, arguments: args } = tc;
    try {
      if (name.startsWith("agent_")) {
        const agentName = name.slice("agent_".length);
        return await this.callAgent(agentName, args.inquiry || "", args.mode || "Fulfill", ctx);
      }
      if (name.startsWith("website_")) {
        const res = await this.callSiteAction(name.slice("website_".length), args, ctx);
        return res.data;
      }
      if (name.startsWith("peer_")) {
        const res = await this.callPeer(name.slice("peer_".length), args.inquiry || "", ctx);
        return { peerAnswer: res.data || res.error || "Peer unavailable." };
      }
      if (name.startsWith("mcp_")) {
        const res = await mcpCallTool(this.llm.mcpUrl, name.slice("mcp_".length), args);
        return res;
      }
      return { error: `Unknown tool '${name}'.` };
    } catch (err) {
      return { error: err.message };
    }
  }

  async callAgent(agentName, inquiry, mode, ctx) {
    const agent = this.network.tools.find((a) => a.name === agentName);
    if (!agent) throw new Error(`Unknown agent '${agentName}'.`);
    this.checkCycle(ctx, `agent:${agentName}:${normalize(inquiry)}`);
    ctx.depth++;
    this.emit({ type: "agent", name: agentName, note: mode });
    try {
      if (!this.useLlm) {
        // Demo mode: the local router answers for the agent directly.
        return { answer: `(${agentName}) ${inquiry}` };
      }
      const system = [
        agent.instructions,
        "",
        "Grounding: answer only from the site's city catalog and the results of the tools you call. Never invent stays, activities, prices, or availability.",
        `Current trip draft: ${JSON.stringify(this.store.get())}`,
      ].join("\n");
      const tools = this.buildLlmTools();
      const { content, toolCalls } = await chatCompletions({
        baseUrl: this.llm.baseUrl,
        model: this.llm.model,
        apiKey: this.llm.apiKey,
        messages: [
          { role: "system", content: system },
          { role: "user", content: inquiry },
        ],
        tools,
      });
      if (!toolCalls.length) return { answer: content || "" };
      const results = [];
      for (const tc of toolCalls) {
        ctx.toolCalls++;
        this.checkBudget(ctx, "sub-agent tool call");
        results.push(await this.dispatchLlmTool(tc, ctx));
      }
      return { answer: content || "", toolResults: results };
    } finally {
      ctx.depth--;
    }
  }

  // ---- site actions ----
  async callSiteAction(name, args, ctx) {
    const action = this.siteActions.find((a) => a.name === name);
    if (!action) throw new Error(`Unknown site action '${name}'.`);
    const schemaErrors = validateAgainstSchema(args || {}, action.parameters);
    if (schemaErrors.length) {
      throw new Error(`Invalid arguments for '${name}': ${schemaErrors.join(" ")}`);
    }
    if (action.effect === "write") {
      const confirmed = await this.onConfirm({
        action: name,
        args,
        summary: `Allow '${name}' with ${JSON.stringify(args)}?`,
      });
      if (!confirmed) {
        this.emit({ type: "tool-result", name, ok: false, note: "visitor declined" });
        return { kind: "tool", name, data: null, declined: true };
      }
    }
    this.emit({ type: "tool", name, args });
    const data = await action.handler(args || {});
    this.emit({ type: "tool-result", name, ok: true });
    return { kind: "tool", name, data };
  }

  // ---- peer networks (spec §3.2) ----
  async callPeer(linkName, inquiry, ctx) {
    const networkLinks = (this.links.networks || {})[this.manifest.networks[0].name] || {};
    const peerUrl = networkLinks[linkName];
    if (!peerUrl) throw new Error(`No peer link named '${linkName}' in links.json.`);
    return this.callPeerByUrl(peerUrl, inquiry, ctx, linkName);
  }

  /** Load and run a peer network identified by its full URL. */
  async callPeerByUrl(peerUrl, inquiry, ctx, linkName) {
    const { siteBase, networkName } = splitPeerUrl(resolvePeerUrl(peerUrl, this.baseUrl));
    const origin = new URL(siteBase).origin;
    const allowed = this.isPeerAllowed(siteBase);
    if (!allowed) {
      const msg = `Peer origin ${origin} is not in allowed_peers and was not approved by the visitor. Refusing contact.`;
      this.emit({ type: "peer-result", origin, ok: false, note: msg });
      return { kind: "peer", link: linkName || networkName, data: null, error: msg };
    }
    const approved = await this.onConsent({
      origin,
      purpose: `Run the '${networkName}' network from ${origin} in this browser (it will use your active model settings; your key is never sent there).`,
    });
    if (!approved) {
      this.emit({ type: "peer-result", origin, ok: false, note: "visitor declined peer contact" });
      return { kind: "peer", link: linkName || networkName, data: null, error: "Visitor declined peer contact." };
    }
    this.emit({ type: "peer-request", origin, network: networkName });
    try {
      const manifest = validateManifest(await this.fetchJson(siteBase + "agent-manifest.json"));
      const entry = manifest.networks.find((n) => n.name === networkName);
      if (!entry) {
        throw new Error(`Peer manifest at ${origin} has no network named '${networkName}'. Refusing to pick another.`);
      }
      const peerNetwork = validateNetwork(
        await this.fetchJson(resolvePeerUrl(entry.hocon, siteBase))
      );
      checkToolReferences(peerNetwork, new Set(), new Set());
      // Optional peer catalog (Wander extension, declared in the peer manifest).
      let peerCatalog = null;
      if (manifest.catalog) {
        try {
          peerCatalog = await this.fetchJson(resolvePeerUrl(manifest.catalog, siteBase));
        } catch {
          peerCatalog = null;
        }
      }
      let answer;
      if (this.useLlm) {
        const front = peerNetwork.tools.find((a) => a.name === entry.front_man);
        const system = [
          front.instructions,
          "",
          "Grounding: answer only from the peer catalog provided below. Never invent stays, activities, prices, or availability.",
          peerCatalog ? `Peer catalog: ${JSON.stringify(peerCatalog).slice(0, 6000)}` : "No peer catalog was published.",
          "Private context: none is forwarded to you.",
        ].join("\n");
        const { content } = await chatCompletions({
          baseUrl: this.llm.baseUrl,
          model: this.llm.model,
          apiKey: this.llm.apiKey,
          messages: [
            { role: "system", content: system },
            { role: "user", content: inquiry },
          ],
        });
        answer = content || "";
      } else {
        if (!peerCatalog) {
          answer = "The peer published no catalog, so it cannot answer from grounded data.";
        } else {
          answer = fulfillPeer(networkName, peerCatalog, inquiry);
        }
      }
      this.emit({ type: "peer-result", origin, ok: true, note: "sly_data forwarded: none" });
      return { kind: "peer", link: linkName || networkName, data: answer, origin, network: networkName };
    } catch (err) {
      this.emit({ type: "peer-result", origin, ok: false, note: err.message });
      return { kind: "peer", link: linkName || networkName, data: null, error: err.message };
    }
  }

  isPeerAllowed(siteBase) {
    const origin = new URL(siteBase).origin;
    if (this.userApprovedPeers.has(origin)) return true;
    const allowed = (this.manifest.allowed_peers || []).map((p) => {
      try {
        return new URL(resolvePeerUrl(p, this.baseUrl)).origin;
      } catch {
        return p;
      }
    });
    return allowed.includes(origin);
  }

  /** Let the visitor approve an arbitrary peer origin (from the peer panel). */
  approvePeerOrigin(origin) {
    this.userApprovedPeers.add(origin);
  }
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}
