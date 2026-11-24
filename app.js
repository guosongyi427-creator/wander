// Wander site wiring — loads the catalog, manifest, and network, builds the
// runtime, and connects the chat, trip panel, LLM settings, and peer panel.
// No agent logic lives here; all of it is in runtime/.
import { WanderRuntime } from "./runtime/runtime.js";
import { buildItinerary, estimateCost, findCity } from "./runtime/core.js";
import { splitPeerUrl } from "./runtime/core.js";

const $ = (id) => document.getElementById(id);
const chatLog = $("chat-log");
const activityLog = $("activity-log");
const modal = $("modal");
let modalResolve = null;

function addMsg(text, cls) {
  const p = document.createElement("p");
  p.className = "msg " + cls;
  p.textContent = text;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addActivity(text, isErr) {
  const li = document.createElement("li");
  if (isErr) li.className = "err";
  li.textContent = text;
  activityLog.appendChild(li);
  activityLog.scrollTop = activityLog.scrollHeight;
}

function askModal(title, body) {
  return new Promise((resolve) => {
    $("modal-title").textContent = title;
    $("modal-body").textContent = body;
    modal.hidden = false;
    modalResolve = resolve;
  });
}
$("modal-yes").addEventListener("click", () => { modal.hidden = true; modalResolve && modalResolve(true); });
$("modal-no").addEventListener("click", () => { modal.hidden = true; modalResolve && modalResolve(false); });

// ---- trip store (in-memory + localStorage) ----
const STORAGE_KEY = "wander:trip:latest";
let trip = loadTrip();
function loadTrip() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { city: null, days: 3, travelers: 2, budgetUsd: null, stops: [] };
}
const store = {
  get: () => trip,
  set: (t) => { trip = t; renderTrip(); },
  save: () => {
    const id = "trip-" + new Date().toISOString().slice(0, 10) + "-" + Math.floor(Math.random() * 1000);
    trip.savedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trip));
    const cityName = trip.city ? (findCity(catalog, trip.city)?.name || trip.city) : "unspecified city";
    return { id, summary: `${trip.days || "?"}-day trip to ${cityName} for ${trip.travelers || 1} traveler(s), ${(trip.stops || []).length} stop(s).` };
  },
};

let catalog = null;
let runtime = null;

function renderTrip() {
  const panel = $("trip-panel");
  const costPanel = $("cost-panel");
  if (!trip.city && !(trip.stops || []).length && trip.budgetUsd == null) {
    panel.innerHTML = '<p class="hint">No trip yet — ask Wander to plan one.</p>';
    costPanel.innerHTML = "";
    $("save-trip-btn").disabled = true;
    return;
  }
  const cityName = trip.city ? (findCity(catalog, trip.city)?.name || trip.city) : "—";
  const lines = [
    `City: ${cityName}`,
    `Days: ${trip.days || "—"} · Travelers: ${trip.travelers || "—"}`,
    `Budget: ${trip.budgetUsd != null ? "$" + trip.budgetUsd : "—"}`,
    `Stops: ${(trip.stops || []).map((s) => `${s.name} (day ${s.day})`).join("; ") || "none yet"}`,
  ];
  panel.innerHTML = "<p>" + lines.map((l) => escapeHtml(l)).join("<br>") + "</p>";
  try {
    const it = buildItinerary(catalog, trip);
    const cost = estimateCost(catalog, trip);
    const itLines = it.plan.map((d) => `Day ${d.day}: ${d.activities.join("; ") || "free time"}${d.stay ? " — " + d.stay : ""}`);
    costPanel.innerHTML =
      "<p><strong>Itinerary</strong><br>" + itLines.map(escapeHtml).join("<br>") + "</p>" +
      "<p><strong>Estimated cost: $" + cost.totalUsd + "</strong><br>" +
      cost.lines.map((l) => escapeHtml(`${l.label}: $${l.amountUsd}`)).join("<br>") + "</p>";
  } catch {
    costPanel.innerHTML = "";
  }
  $("save-trip-btn").disabled = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setModeBadge() {
  const badge = $("mode-badge");
  const hasKey = Boolean(runtime?.llm?.apiKey);
  badge.textContent = hasKey ? `BYOK — ${runtime.llm.model}` : "Demo mode — no key";
  badge.classList.toggle("llm", hasKey);
  $("llm-status").textContent = hasKey
    ? `Key saved for ${runtime.llm.baseUrl} (model ${runtime.llm.model}). The key is sent only to that router.`
    : "No key saved — running the local demo router.";
}

async function boot() {
  catalog = await (await fetch("./data/cities.json")).json();
  const llm = loadLlmSettings();
  runtime = new WanderRuntime({
    baseUrl: new URL("./", location.href).toString(),
    catalog,
    store,
    llm,
    onEvent: (e) => {
      if (e.type === "agent") addActivity(`Agent: ${e.name}${e.note ? ` (${e.note})` : ""}`);
      else if (e.type === "tool") addActivity(`Tool: ${e.name} ${JSON.stringify(e.args || {})}`);
      else if (e.type === "tool-result") addActivity(`Tool ${e.name}: ${e.ok ? "ok" : "not run"}${e.note ? ` — ${e.note}` : ""}`, !e.ok);
      else if (e.type === "peer-request") addActivity(`Peer contact: ${e.network} at ${e.origin} (visitor approved)`);
      else if (e.type === "peer-result") addActivity(`Peer ${e.origin}: ${e.ok ? "answered" : "failed"}${e.note ? ` — ${e.note}` : ""}`, !e.ok);
      else if (e.type === "mcp") addActivity(e.status);
      else if (e.type === "error") addActivity(`Error: ${e.message}`, true);
      else if (e.type === "ready") addActivity(`Network '${e.networks.join(", ")}' loaded. Front agent: ${e.front}.`);
      if (e.type === "tool-result" || e.type === "answer") renderTrip();
    },
    onConsent: ({ origin, purpose }) => askModal("Contact a peer site?", `${purpose}\n\nOrigin: ${origin}\nYour LLM key (if any) is never sent there.`),
    onConfirm: ({ action, args, summary }) => askModal("Confirm action", `${summary}\n\n${action} ${JSON.stringify(args)}`),
  });
  await runtime.init();
  renderTrip();
  setModeBadge();
  // Sample queries.
  const samples = runtime.manifest.networks[0].sample_queries || [];
  for (const q of samples) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => { $("chat-input").value = q; sendChat(); });
    $("sample-chips").appendChild(b);
  }
  // Peer list.
  const links = runtime.links.networks?.wander || {};
  const list = $("peer-list");
  for (const [name, url] of Object.entries(links)) {
    const li = document.createElement("li");
    li.textContent = `${name}: ${url}`;
    list.appendChild(li);
  }
  addMsg("Hi, I'm Wander. Ask me to plan a trip — for example, \"Plan a 3-day trip to Kyoto for two people with a $900 budget.\"", "agent");
}

function loadLlmSettings() {
  try {
    const raw = localStorage.getItem("wander:llm");
    if (raw) {
      const s = JSON.parse(raw);
      $("llm-base").value = s.baseUrl || "https://api.openai.com/v1";
      $("llm-model").value = s.model || "gpt-4o-mini";
      $("llm-key").value = s.apiKey || "";
      $("mcp-url").value = s.mcpUrl || "";
      return s;
    }
  } catch { /* ignore */ }
  return { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "", mcpUrl: "" };
}

$("llm-save").addEventListener("click", async () => {
  const s = {
    baseUrl: $("llm-base").value.trim(),
    model: $("llm-model").value.trim() || "gpt-4o-mini",
    apiKey: $("llm-key").value,
    mcpUrl: $("mcp-url").value.trim(),
  };
  localStorage.setItem("wander:llm", JSON.stringify(s));
  runtime.llm = s;
  setModeBadge();
  addActivity("LLM settings saved.");
  if (s.mcpUrl) await runtime.refreshMcpTools();
  if (!s.apiKey) addMsg("No API key was entered, so I'm still using the local demo router. Add a key to use a real model.", "sys");
});

$("llm-delete").addEventListener("click", () => {
  localStorage.removeItem("wander:llm");
  $("llm-key").value = "";
  $("mcp-url").value = "";
  runtime.llm = { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "", mcpUrl: "" };
  runtime.mcpTools = [];
  setModeBadge();
  addActivity("LLM key deleted.");
});

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !runtime) return;
  input.value = "";
  addMsg(text, "user");
  addMsg("Wander is thinking…", "sys");
  const thinking = chatLog.lastElementChild;
  try {
    const answer = await runtime.run(text);
    thinking.remove();
    addMsg(answer, "agent");
  } catch (err) {
    thinking.remove();
    addMsg(`I couldn't complete that: ${err.message}`, "sys");
  }
  renderTrip();
}
$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });

$("save-trip-btn").addEventListener("click", async () => {
  const ok = await askModal("Save trip?", "Save this trip plan in your browser? Nothing is booked.");
  if (!ok) return;
  const res = await runtime.callSiteAction("save_trip", {}, { started: Date.now(), maxMs: 30000, depth: 0, toolCalls: 0, seen: new Map() });
  addMsg(`Saved. Receipt ${res.data.receipt.id} — ${res.data.receipt.summary}`, "agent");
  renderTrip();
});

$("clear-trip-btn").addEventListener("click", () => {
  trip = { city: null, days: 3, travelers: 2, budgetUsd: null, stops: [] };
  localStorage.removeItem(STORAGE_KEY);
  renderTrip();
  addMsg("Trip cleared.", "sys");
});

$("peer-load").addEventListener("click", async () => {
  const url = $("peer-url").value.trim();
  const question = $("peer-question").value.trim() || "What do you offer?";
  const status = $("peer-status");
  const answerBox = $("peer-answer");
  if (!url) { status.textContent = "Paste a peer network URL first."; return; }
  status.textContent = "Loading peer…";
  answerBox.textContent = "";
  try {
    const { siteBase, networkName } = splitPeerUrl(url);
    const origin = new URL(siteBase).origin;
    const manifest = await runtime.fetchJson(siteBase + "agent-manifest.json");
    const entry = manifest.networks.find((n) => n.name === networkName);
    if (!entry) throw new Error(`That manifest has no network named '${networkName}'.`);
    runtime.approvePeerOrigin(origin);
    runtime.links.networks.wander[networkName] = url;
    status.textContent = `Loaded '${networkName}' (front agent ${entry.front_man}) from ${origin}. Asking it your question…`;
    addActivity(`Peer loaded by URL: ${networkName} at ${origin}.`);
    const ctx = { started: Date.now(), maxMs: 60000, depth: 0, toolCalls: 0, seen: new Map() };
    const res = await runtime.callPeerByUrl(url, question, ctx);
    if (res.error) {
      status.textContent = `Peer loaded, but it could not answer: ${res.error}`;
    } else {
      status.textContent = `Peer '${networkName}' answered (sly_data forwarded: none).`;
      answerBox.textContent = res.data;
      addMsg(`Peer ${networkName}: ${res.data}`, "agent");
    }
  } catch (err) {
    status.textContent = `Could not load peer: ${err.message}`;
  }
});

boot().catch((err) => {
  addMsg(`The site could not start: ${err.message}`, "sys");
  addActivity(`Boot failed: ${err.message}`, true);
});
