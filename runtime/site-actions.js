// Wander site actions — capabilities owned by this website and registered
// with the browser runtime. Each action declares a name, purpose, JSON
// Schema, and effect. The runtime validates arguments against the schema
// and asks the visitor to confirm before any write. Handlers only read the
// site's own catalog and trip draft; nothing is booked and no payment is
// collected. Written from scratch for Wander.
import {
  findCity,
  searchStays,
  searchActivities,
  estimateCost,
  buildItinerary,
} from "./core.js";

/**
 * Build the action table. `ctx` is { catalog, store } where store is
 * { get(), set(trip), save() }.
 */
export function buildSiteActions(ctx) {
  const { catalog, store } = ctx;

  function findRef(type, refId) {
    for (const c of catalog.cities) {
      const list = type === "stay" ? c.stays : c.activities;
      const hit = list.find((x) => x.id === refId);
      if (hit) return { city: c.id, cityName: c.name, ...hit };
    }
    return null;
  }

  return [
    {
      name: "get_trip_state",
      description: "Read the visitor's current trip draft (city, days, travelers, budget, stops).",
      effect: "read",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ trip: store.get() }),
    },
    {
      name: "search_stays",
      description: "Search the site's stays catalog by city, maximum price per night, area, or tags.",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City id or name (kyoto, lisbon, vancouver)." },
          maxPrice: { type: "number", minimum: 0, description: "Maximum price per night in USD." },
          area: { type: "string", description: "Neighborhood or area substring." },
          tags: { type: "array", description: "Tags to match (any).", items: { type: "string" } },
        },
      },
      handler: async (args) => ({ stays: searchStays(catalog, args) }),
    },
    {
      name: "search_activities",
      description: "Search the site's activities catalog by city, maximum price, tags, or indoor/outdoor.",
      effect: "read",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City id or name (kyoto, lisbon, vancouver)." },
          maxPrice: { type: "number", minimum: 0, description: "Maximum price in USD." },
          tags: { type: "array", description: "Tags to match (any).", items: { type: "string" } },
          indoor: { type: "boolean", description: "True for indoor activities only." },
        },
      },
      handler: async (args) => ({ activities: searchActivities(catalog, args) }),
    },
    {
      name: "add_stop",
      description: "Add a stay or activity to the trip draft for a given day.",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          day: { type: "integer", minimum: 1, description: "Trip day (1-based)." },
          type: { type: "string", enum: ["stay", "activity"], description: "Kind of stop." },
          refId: { type: "string", description: "Catalog id of the stay or activity." },
        },
        required: ["day", "type", "refId"],
      },
      handler: async (args) => {
        const ref = findRef(args.type, args.refId);
        if (!ref) throw new Error(`No ${args.type} with id '${args.refId}' in the catalog.`);
        const trip = store.get();
        trip.stops = trip.stops || [];
        trip.stops.push({
          day: args.day,
          type: args.type,
          refId: args.refId,
          name: ref.name,
          priceUsd: args.type === "stay" ? ref.pricePerNightUsd : ref.priceUsd,
          pricePerNightUsd: ref.pricePerNightUsd,
          tags: ref.tags || [],
        });
        if (ref.city && !trip.city) trip.city = ref.city;
        store.set(trip);
        return { added: ref.name, day: args.day, trip };
      },
    },
    {
      name: "set_budget",
      description: "Set the trip budget and trip details (city, days, travelers).",
      effect: "write",
      parameters: {
        type: "object",
        properties: {
          budgetUsd: { type: "number", minimum: 0, description: "Total budget in USD." },
          travelers: { type: "integer", minimum: 1, maximum: 12, description: "Number of travelers." },
          days: { type: "integer", minimum: 1, maximum: 14, description: "Number of trip days." },
          city: { type: "string", description: "City id or name." },
        },
      },
      handler: async (args) => {
        const trip = store.get();
        if (args.budgetUsd !== undefined) trip.budgetUsd = args.budgetUsd;
        if (args.travelers !== undefined) trip.travelers = args.travelers;
        if (args.days !== undefined) trip.days = args.days;
        if (args.city !== undefined) {
          const city = findCity(catalog, args.city);
          if (!city) throw new Error(`Unknown city '${args.city}'. Covered cities: Kyoto, Lisbon, Vancouver.`);
          trip.city = city.id;
        }
        store.set(trip);
        return { trip };
      },
    },
    {
      name: "build_itinerary",
      description: "Build the day-by-day itinerary and cost estimate from the current trip draft.",
      effect: "read",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const trip = store.get();
        const itinerary = buildItinerary(catalog, trip);
        const cost = estimateCost(catalog, trip);
        return { itinerary, cost };
      },
    },
    {
      name: "save_trip",
      description: "Save the current trip draft to this browser (local storage) and return a receipt.",
      effect: "write",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const trip = store.get();
        const receipt = store.save();
        const cost = estimateCost(catalog, trip);
        return { receipt, trip, cost };
      },
    },
  ];
}
