// Wander local router — the no-key "demo model".
// When the visitor has not supplied an LLM key, the runtime uses this
// deterministic router instead of a model. It implements the same agent and
// tool flow the LLM path uses: it routes the inquiry to the right agents,
// calls the same site actions and peer networks, and composes the answer
// only from the results it got back. It never invents stays, activities,
// prices, or availability. This is clearly labeled "Demo mode" in the UI.
// Written from scratch for Wander.
import { findCity, searchStays, searchActivities, searchPeerStays, searchPeerActivities } from "./core.js";

const CITY_WORDS = ["kyoto", "lisbon", "vancouver"];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function wordToNumber(w) {
  return NUMBER_WORDS[String(w).toLowerCase()] ?? null;
}

/** Parse the visitor's inquiry into structured intent. Pure. */
export function detectIntent(inquiry) {
  const text = String(inquiry || "");
  const lower = text.toLowerCase();
  const out = { raw: text };
  for (const c of CITY_WORDS) {
    if (lower.includes(c)) {
      out.city = c;
      break;
    }
  }
  const dayMatch = lower.match(/(\d+)\s*-?\s*day/);
  if (dayMatch) out.days = parseInt(dayMatch[1], 10);
  const travNum = lower.match(/(\d+)\s*(people|travelers|travellers|person)/);
  const travWord = lower.match(/\b(one|two|three|four|five|six)\s+(people|travelers|travellers|person)\b/);
  if (travNum) out.travelers = parseInt(travNum[1], 10);
  else if (travWord) out.travelers = wordToNumber(travWord[1]);
  else if (/\bfor two\b/.test(lower)) out.travelers = 2;
  const budgetMatch = lower.match(/\$?\s*([\d,]+)\s*(budget|usd|dollars|bucks)/) || lower.match(/budget[^0-9]{0,12}\$?\s*([\d,]+)/);
  if (budgetMatch) out.budgetUsd = parseInt(budgetMatch[1].replace(/,/g, ""), 10);
  const underMatch = lower.match(/(under|below|less than|at most|max)\s*\$?\s*([\d,]+)/);
  if (underMatch) out.maxPrice = parseInt(underMatch[2].replace(/,/g, ""), 10);
  out.indoor = /\brain/.test(lower);
  // Intent classification (first match wins). Plurals included: "stays",
  // "hotels", "neighborhoods". Bare "do" is NOT an activity signal — it is
  // usually the auxiliary verb ("What stays do you have…").
  if (/\bsave\b/.test(lower)) out.intent = "save";
  else if (/\b(itinerary|build my|plan (a|my|the)|make a plan)\b/.test(lower)) out.intent = "plan";
  else if (/\b(hotels?|stays?|lodging|rooms?|sleep|where to stay|accommodation)\b/.test(lower)) out.intent = "stay";
  else if (/\b(budget|cost|afford|cheap|price|how much)\b/.test(lower)) out.intent = "budget";
  else if (/\b(neighborhoods?|neighbourhoods?|areas?|districts?|where (is|to)|best (area|place|month))\b/.test(lower)) out.intent = "destination";
  else if (/\b(see|visit|tour|activity|activities|things to do|what to do|rains?)\b/.test(lower)) out.intent = "activity";
  else if (/\b(hi|hello|hey|help)\b/.test(lower)) out.intent = "greet";
  else out.intent = "plan";
  // Interest tags. Time-of-day and "free" only apply to activities/plans,
  // never to stays (a "night" in "a night" must not filter out all stays).
  out.tags = [];
  if (/\bfood\b/.test(lower)) out.tags.push("food");
  if (/\btea\b/.test(lower)) out.tags.push("tea");
  if (/\bmuseum|temple|shrine\b/.test(lower)) out.tags.push("temple");
  if (/\bnature|hike|outdoor\b/.test(lower)) out.tags.push("nature");
  if (/\bcraft|hands-on|workshop\b/.test(lower)) out.tags.push("craft");
  if (out.intent === "activity" || out.intent === "plan") {
    if (/\bfree\b/.test(lower)) out.tags.push("free");
    if (/\bmorning\b/.test(lower)) out.tags.push("morning");
    if (/\bevening|night|sunset\b/.test(lower)) out.tags.push("evening");
  }
  return out;
}

/** Format a stays list as a short grounded answer fragment. */
export function formatStays(stays, sourceLabel) {
  if (!stays.length) return `No stays matched in the ${sourceLabel}.`;
  const lines = stays.slice(0, 4).map(
    (s) => `- ${s.name} (${s.area}, ${s.cityName}): $${s.pricePerNightUsd}/night, rating ${s.rating} — ${s.tags.join(", ")}`
  );
  return `From the ${sourceLabel}:\n${lines.join("\n")}`;
}

/** Format an activities list as a short grounded answer fragment. */
export function formatActivities(acts, sourceLabel) {
  if (!acts.length) return `No activities matched in the ${sourceLabel}.`;
  const lines = acts.slice(0, 4).map(
    (a) => `- ${a.name} (${a.area}, ${a.cityName}): $${a.priceUsd}, ${a.durationHours}h — ${a.tags.join(", ")}`
  );
  return `From the ${sourceLabel}:\n${lines.join("\n")}`;
}

/**
 * Plan the steps for an inquiry in demo mode. Returns { agent, steps } where
 * each step is { kind: "tool", name, args } or { kind: "peer", link, inquiry }.
 * `state` is the current trip draft; `catalog` is the main catalog.
 * Write steps are proposed here; the runtime asks the visitor to confirm
 * them before executing.
 */
export function planSteps(intent, state, catalog) {
  const steps = [];
  let agent = "wander";
  const city = intent.city || state.city || null;
  if (intent.intent === "greet") {
    return { agent, steps: [], note: "greet" };
  }
  if (intent.intent === "save") {
    return { agent, steps: [{ kind: "tool", name: "build_itinerary", args: {} }], note: "save" };
  }
  if (intent.intent === "destination") {
    return { agent: "destination_guide", steps: [], note: "destination", city };
  }
  if (intent.intent === "stay") {
    agent = "stay_finder";
    steps.push({
      kind: "tool",
      name: "search_stays",
      args: { city, maxPrice: intent.maxPrice, tags: intent.tags.length ? intent.tags : undefined },
    });
    // Ask the peer for more options when the visitor wants breadth.
    if (/more|other|peer|also|options/i.test(intent.raw)) {
      steps.push({ kind: "peer", link: "stay", inquiry: intent.raw });
    }
    return { agent, steps, note: "stay", city };
  }
  if (intent.intent === "activity") {
    agent = "experience_finder";
    steps.push({
      kind: "tool",
      name: "search_activities",
      args: {
        city,
        maxPrice: intent.maxPrice,
        tags: intent.tags.length ? intent.tags : undefined,
        indoor: intent.indoor ? true : undefined,
      },
    });
    if (/more|other|peer|also|options/i.test(intent.raw)) {
      steps.push({ kind: "peer", link: "experience", inquiry: intent.raw });
    }
    return { agent, steps, note: "activity", city };
  }
  if (intent.intent === "budget") {
    return { agent: "budget_keeper", steps: [{ kind: "tool", name: "build_itinerary", args: {} }], note: "budget" };
  }
  // Default: plan a trip.
  if (intent.budgetUsd !== undefined || intent.travelers !== undefined || intent.days !== undefined || intent.city) {
    steps.push({
      kind: "tool",
      name: "set_budget",
      args: {
        budgetUsd: intent.budgetUsd,
        travelers: intent.travelers,
        days: intent.days,
        city: intent.city,
      },
    });
  }
  if (city) {
    steps.push({ kind: "tool", name: "search_stays", args: { city } });
    steps.push({ kind: "tool", name: "search_activities", args: { city } });
    // Propose the trip's stops: the top-rated stay and the three cheapest
    // activities, spread across days. These are write steps; the runtime
    // asks the visitor to confirm them all at once before executing.
    const days = intent.days || state.days || 3;
    const stays = searchStays(catalog, { city });
    const acts = searchActivities(catalog, { city });
    if (stays.length) {
      const best = [...stays].sort((a, b) => b.rating - a.rating || a.pricePerNightUsd - b.pricePerNightUsd)[0];
      steps.push({ kind: "tool", name: "add_stop", args: { day: 1, type: "stay", refId: best.id } });
    }
    acts.slice(0, 3).forEach((a, i) => {
      steps.push({ kind: "tool", name: "add_stop", args: { day: Math.min(i + 1, days), type: "activity", refId: a.id } });
    });
  }
  steps.push({ kind: "tool", name: "build_itinerary", args: {} });
  return { agent, steps, note: "plan", city };
}

/** Compose the final answer from step results. Pure string building. */
export function composeAnswer(intent, plan, results, state, catalog) {
  const parts = [];
  const city = plan.city ? findCity(catalog, plan.city) : state.city ? findCity(catalog, state.city) : null;
  if (plan.note === "greet") {
    return (
      "Hi, I'm Wander — I plan multi-day city trips. I can help with Kyoto, Lisbon, or Vancouver: " +
      "destinations, stays, activities, budget, and a day-by-day itinerary. " +
      "Try: \"Plan a 3-day trip to Kyoto for two people with a $900 budget.\""
    );
  }
  if (plan.note === "destination") {
    if (!city) {
      return "I cover three cities: Kyoto (Japan), Lisbon (Portugal), and Vancouver (Canada). Which one would you like to explore?";
    }
    const lines = city.neighborhoods.map((n) => `- ${n.name}: ${n.note}`);
    return (
      `${city.name}, ${city.country} — ${city.summary}\nBest months: ${city.bestMonths.join(", ")}.\nNeighborhoods:\n${lines.join("\n")}`
    );
  }
  if (plan.note === "stay" || plan.note === "activity") {
    const local = results.find((r) => r.kind === "tool");
    const peer = results.find((r) => r.kind === "peer");
    if (plan.note === "stay") {
      const stays = local?.data?.stays || [];
      parts.push(formatStays(stays, "site catalog"));
      if (peer?.data) parts.push(peer.data);
      if (!stays.length && !peer) {
        parts.push("I couldn't find a stay matching that. Try a higher price or a different area.");
      }
      if (city) parts.push(`\nWant me to add one to your trip? Tell me the name and the day.`);
      return parts.join("\n\n");
    }
    const acts = local?.data?.activities || [];
    parts.push(formatActivities(acts, "site catalog"));
    if (peer?.data) parts.push(peer.data);
    if (!acts.length && !peer) {
      parts.push("I couldn't find an activity matching that. Try different tags or a higher price.");
    }
    return parts.join("\n\n");
  }
  if (plan.note === "budget") {
    const built = results.find((r) => r.kind === "tool" && r.name === "build_itinerary");
    if (!built?.data) return "I need a trip draft first — tell me the city, days, and travelers.";
    return formatCost(built.data.cost, state);
  }
  if (plan.note === "save") {
    return "Here's your itinerary. Review it in the trip panel, then press Save trip to keep it in this browser.";
  }
  // Plan.
  const built = results.find((r) => r.kind === "tool" && r.name === "build_itinerary");
  const stays = results.find((r) => r.kind === "tool" && r.name === "search_stays");
  const acts = results.find((r) => r.kind === "tool" && r.name === "search_activities");
  if (city) parts.push(`${city.name}, ${city.country} — ${city.summary}`);
  if (stays?.data?.stays?.length) {
    parts.push(`A good base: ${stays.data.stays[0].name} (${stays.data.stays[0].area}) at $${stays.data.stays[0].pricePerNightUsd}/night.`);
  }
  if (acts?.data?.activities?.length) {
    parts.push(formatActivities(acts.data.activities, "site catalog"));
  }
  if (built?.data) {
    parts.push(formatCost(built.data.cost, state));
    const planDays = built.data.itinerary.plan;
    if (planDays.length) {
      const lines = planDays.map(
        (d) => `Day ${d.day}: ${d.activities.length ? d.activities.join("; ") : "free time / explore"}${d.stay ? ` — stay: ${d.stay}` : ""}`
      );
      parts.push(`Suggested itinerary:\n${lines.join("\n")}`);
    }
    parts.push("Say \"save the trip\" and I'll save this plan in your browser. Nothing is booked — this site plans trips only.");
  }
  return parts.join("\n\n") || "Tell me a city, how many days, how many travelers, and a budget, and I'll plan the trip.";
}

function formatCost(cost, state) {
  if (!cost) return "";
  const lines = cost.lines.map((l) => `- ${l.label}: $${l.amountUsd}`);
  const over = state.budgetUsd !== undefined && state.budgetUsd !== null && cost.totalUsd > state.budgetUsd;
  return (
    `Estimated cost (USD):\n${lines.join("\n")}\nTotal: $${cost.totalUsd}` +
    (state.budgetUsd !== undefined && state.budgetUsd !== null
      ? over
        ? `\nThat's $${cost.totalUsd - state.budgetUsd} over your $${state.budgetUsd} budget. I can suggest a cheaper stay or free activities.`
        : `\nThat's within your $${state.budgetUsd} budget.`
      : "")
  );
}

/**
 * Fulfill a peer network's front agent in demo mode, using the peer's own
 * catalog. Returns a grounded answer string. `kind` is "stay" or "experience".
 */
export function fulfillPeer(kind, peerCatalog, inquiry) {
  const intent = detectIntent(inquiry);
  if (kind === "stay") {
    const stays = searchPeerStays(peerCatalog, {
      city: intent.city,
      maxPrice: intent.maxPrice,
      tags: intent.tags.length ? intent.tags : undefined,
    });
    return formatStays(stays, "Harbor Stay peer catalog");
  }
  const acts = searchPeerActivities(peerCatalog, {
    city: intent.city,
    maxPrice: intent.maxPrice,
    tags: intent.tags.length ? intent.tags : undefined,
    indoor: intent.indoor ? true : undefined,
  });
  return formatActivities(acts, "City Experiences peer catalog");
}
