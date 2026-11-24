// Wander runtime core — pure functions (no DOM, no network).
// Implements the minimum behaviors of the Open Agentic Web MVP spec (profile 0.3):
// manifest/network validation (fail closed), peer URL resolution, grounded
// catalog search, itinerary building, and cost estimation.
// This file is written from scratch for Wander; it does not copy any
// reference implementation.

export const SPEC_VERSION = "mvp-0.3";

/** Validate an agent-manifest.json object. Throws a descriptive Error. */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Manifest must be a JSON object.");
  }
  if (!Array.isArray(manifest.networks) || manifest.networks.length === 0) {
    throw new Error("Manifest must list at least one network in 'networks'.");
  }
  const names = new Set();
  for (const n of manifest.networks) {
    if (typeof n.name !== "string" || !n.name) {
      throw new Error("Each manifest network needs a non-empty string 'name'.");
    }
    if (names.has(n.name)) {
      throw new Error(`Duplicate network name in manifest: '${n.name}'.`);
    }
    names.add(n.name);
    if (typeof n.front_man !== "string" || !n.front_man) {
      throw new Error(`Network '${n.name}' needs a 'front_man'.`);
    }
    if (typeof n.hocon !== "string" || !n.hocon) {
      throw new Error(`Network '${n.name}' needs a 'hocon' location.`);
    }
  }
  if (!manifest.llm_router || typeof manifest.llm_router !== "object") {
    throw new Error("Manifest needs an 'llm_router' object.");
  }
  if (!manifest.peer_policy || typeof manifest.peer_policy.mode !== "string") {
    throw new Error("Manifest needs a 'peer_policy' object with a 'mode'.");
  }
  if (manifest.allowed_peers !== undefined && !Array.isArray(manifest.allowed_peers)) {
    throw new Error("Manifest 'allowed_peers' must be an array when present.");
  }
  return manifest;
}

/** Validate a resolved network definition (Neuro SAN JSON shape). Throws. */
export function validateNetwork(network) {
  if (!network || typeof network !== "object" || Array.isArray(network)) {
    throw new Error("Network definition must be a JSON object.");
  }
  if (!Array.isArray(network.tools) || network.tools.length === 0) {
    throw new Error("Network must list at least one agent in 'tools'.");
  }
  const names = new Set();
  for (const agent of network.tools) {
    if (typeof agent.name !== "string" || !agent.name) {
      throw new Error("Each agent needs a non-empty string 'name'.");
    }
    if (names.has(agent.name)) {
      throw new Error(`Duplicate agent name in network: '${agent.name}'.`);
    }
    names.add(agent.name);
    if (!agent.function || typeof agent.function.description !== "string" || !agent.function.description) {
      throw new Error(`Agent '${agent.name}' needs a function description.`);
    }
    if (!agent.function.parameters || agent.function.parameters.type !== "object") {
      throw new Error(`Agent '${agent.name}' needs JSON Schema parameters of type object.`);
    }
    if (typeof agent.instructions !== "string" || !agent.instructions) {
      throw new Error(`Agent '${agent.name}' needs non-empty 'instructions'.`);
    }
    if (!Array.isArray(agent.tools)) {
      throw new Error(`Agent '${agent.name}' needs a 'tools' array (possibly empty).`);
    }
  }
  if (typeof network.max_execution_seconds !== "number" || network.max_execution_seconds <= 0) {
    network.max_execution_seconds = 120;
  }
  return network;
}

/**
 * Check that every tool reference inside a network resolves to one of:
 * a local agent name, a site action (website_*), a peer link name, or an
 * http(s) URL. `linkNames` is the set of symbolic peer names from links.json.
 * Throws on the first unresolvable reference.
 */
export function checkToolReferences(network, linkNames, siteActionNames) {
  const agentNames = new Set(network.tools.map((a) => a.name));
  for (const agent of network.tools) {
    for (const ref of agent.tools) {
      if (typeof ref !== "string") {
        throw new Error(`Agent '${agent.name}' has a non-string tool reference.`);
      }
      const isLocal = agentNames.has(ref);
      const isSiteAction = ref.startsWith("website_") && siteActionNames.has(ref.slice("website_".length));
      const isPeerLink = linkNames.has(ref);
      const isUrl = /^https?:\/\//.test(ref);
      if (!isLocal && !isSiteAction && !isPeerLink && !isUrl) {
        throw new Error(
          `Agent '${agent.name}' references unknown tool '${ref}': not a local agent, site action, peer link, or URL.`
        );
      }
    }
  }
}

/** Resolve a peer-network URL the way the spec §3.2 requires. */
export function resolvePeerUrl(peerUrl, siteBase) {
  // peerUrl may be a full URL, a relative path, or a "siteBase/networkName" pair.
  // The manifest's hocon value is resolved against the peer site base.
  try {
    return new URL(peerUrl, siteBase).toString();
  } catch {
    throw new Error(`Cannot resolve peer URL '${peerUrl}' against base '${siteBase}'.`);
  }
}

/** Split a peer-network URL into { siteBase, networkName } per spec §3.2. */
export function splitPeerUrl(peerUrl) {
  const u = new URL(peerUrl);
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Peer URL '${peerUrl}' has no network name in its path.`);
  }
  const networkName = parts[parts.length - 1];
  const basePath = parts.slice(0, -1).join("/");
  const siteBase = `${u.origin}/${basePath ? basePath + "/" : ""}`;
  return { siteBase, networkName };
}

// ---- Grounded catalog search (read-only, pure) ----

/** Find a city by id or by name (case-insensitive, substring). */
export function findCity(catalog, query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  return (
    catalog.cities.find((c) => c.id === q || c.name.toLowerCase() === q) ||
    catalog.cities.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())) ||
    null
  );
}

/** Search stays in the catalog. Filters: city (id/name), maxPrice, area, tags[]. */
export function searchStays(catalog, { city, maxPrice, area, tags } = {}) {
  const out = [];
  for (const c of catalog.cities) {
    if (city && findCity(catalog, city)?.id !== c.id) continue;
    for (const s of c.stays) {
      if (maxPrice !== undefined && s.pricePerNightUsd > maxPrice) continue;
      if (area && !s.area.toLowerCase().includes(String(area).toLowerCase())) continue;
      if (tags && tags.length && !tags.some((t) => s.tags.includes(t))) continue;
      out.push({ city: c.id, cityName: c.name, ...s });
    }
  }
  return out.sort((a, b) => a.pricePerNightUsd - b.pricePerNightUsd);
}

/** Search activities in the catalog. Filters: city, maxPrice, tags[], indoor. */
export function searchActivities(catalog, { city, maxPrice, tags, indoor } = {}) {
  const out = [];
  for (const c of catalog.cities) {
    if (city && findCity(catalog, city)?.id !== c.id) continue;
    for (const a of c.activities) {
      if (maxPrice !== undefined && a.priceUsd > maxPrice) continue;
      if (tags && tags.length && !tags.some((t) => a.tags.includes(t))) continue;
      if (indoor === true && !a.tags.includes("indoor")) continue;
      if (indoor === false && a.tags.includes("indoor")) continue;
      out.push({ city: c.id, cityName: c.name, ...a });
    }
  }
  return out.sort((a, b) => a.priceUsd - b.priceUsd);
}

/** Search a peer stays catalog (same shape as the main catalog's stays). */
export function searchPeerStays(peerCatalog, { city, maxPrice, area, tags } = {}) {
  const out = [];
  for (const c of peerCatalog.cities) {
    if (city && c.id !== String(city).toLowerCase() && c.name.toLowerCase() !== String(city).toLowerCase()) continue;
    for (const s of c.stays) {
      if (maxPrice !== undefined && s.pricePerNightUsd > maxPrice) continue;
      if (area && !s.area.toLowerCase().includes(String(area).toLowerCase())) continue;
      if (tags && tags.length && !tags.some((t) => s.tags.includes(t))) continue;
      out.push({ city: c.id, cityName: c.name, ...s });
    }
  }
  return out.sort((a, b) => a.pricePerNightUsd - b.pricePerNightUsd);
}

/** Search a peer activities catalog. */
export function searchPeerActivities(peerCatalog, { city, maxPrice, tags, indoor } = {}) {
  const out = [];
  for (const c of peerCatalog.cities) {
    if (city && c.id !== String(city).toLowerCase() && c.name.toLowerCase() !== String(city).toLowerCase()) continue;
    for (const a of c.activities) {
      if (maxPrice !== undefined && a.priceUsd > maxPrice) continue;
      if (tags && tags.length && !tags.some((t) => a.tags.includes(t))) continue;
      if (indoor === true && !a.tags.includes("indoor")) continue;
      out.push({ city: c.id, cityName: c.name, ...a });
    }
  }
  return out.sort((a, b) => a.priceUsd - b.priceUsd);
}

// ---- Trip math (pure) ----

/** Estimate a trip's cost from catalog prices and trip state. */
export function estimateCost(catalog, trip) {
  const city = trip.city ? findCity(catalog, trip.city) : null;
  const days = trip.days || 0;
  const nights = Math.max(days - 1, 0);
  const travelers = trip.travelers || 1;
  const lines = [];
  let total = 0;
  const stayStops = (trip.stops || []).filter((s) => s.type === "stay");
  const actStops = (trip.stops || []).filter((s) => s.type === "activity");
  for (const s of stayStops) {
    const cost = s.pricePerNightUsd * nights;
    lines.push({ label: `Stay: ${s.name} (${nights} nights)`, amountUsd: cost });
    total += cost;
  }
  for (const a of actStops) {
    const cost = a.priceUsd * travelers;
    lines.push({ label: `Activity: ${a.name}`, amountUsd: cost });
    total += cost;
  }
  if (city) {
    const food = city.dailyFoodUsd * days * travelers;
    const transit = city.dailyTransitUsd * days * travelers;
    lines.push({ label: `Food (${days} days x ${travelers} travelers)`, amountUsd: food });
    lines.push({ label: `Transit (${days} days x ${travelers} travelers)`, amountUsd: transit });
    total += food + transit;
  }
  return { lines, totalUsd: total, currency: "USD" };
}

/**
 * Build a day-by-day itinerary from trip state: assign the stay to every
 * night and spread activities across days (max 3 per day, mornings first).
 */
export function buildItinerary(catalog, trip) {
  const city = trip.city ? findCity(catalog, trip.city) : null;
  const days = trip.days || 0;
  const stay = (trip.stops || []).find((s) => s.type === "stay") || null;
  const acts = (trip.stops || []).filter((s) => s.type === "activity");
  const plan = [];
  for (let d = 1; d <= days; d++) {
    plan.push({ day: d, stay: stay ? stay.name : null, activities: [] });
  }
  // Morning-tagged activities first, then the rest, round-robin by day.
  const ordered = [...acts].sort((a, b) => {
    const am = (a.tags || []).includes("morning") ? 0 : 1;
    const bm = (b.tags || []).includes("morning") ? 0 : 1;
    return am - bm;
  });
  ordered.forEach((a, i) => {
    const day = plan[i % Math.max(days, 1)];
    if (day && day.activities.length < 3) day.activities.push(a.name);
  });
  return {
    city: city ? city.name : null,
    days,
    travelers: trip.travelers || 1,
    budgetUsd: trip.budgetUsd ?? null,
    plan,
  };
}

/** Very small JSON Schema validator (object type, properties, required, enum, minimum/maximum). */
export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object.`);
      return errors;
    }
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${path}.${req}: required.`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) continue;
      errors.push(...validateAgainstSchema(value[key], sub, `${path}.${key}`));
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string.`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(", ")}.`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`${path}: expected number.`);
    } else {
      if (schema.type === "integer" && !Number.isInteger(value)) errors.push(`${path}: expected integer.`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}.`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) errors.push(`${path}: expected array.`);
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean.`);
  }
  return errors;
}
