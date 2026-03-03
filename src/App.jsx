import React, { useState, useMemo, useRef, useEffect } from "react";

/* ─── Helpers ────────────────────────────────────────────────────── */
const fmt = (n) => (n != null && !isNaN(n) ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
const fmtC = (n) => (n != null && !isNaN(n) ? (Math.abs(n) >= 1e6 ? "$" + (n / 1e6).toFixed(3) + "M" : fmt(n)) : "—");
const fmtNum = (n) => (n != null && !isNaN(n) ? Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
const parseNum = (v) => { if (v == null || v === "") return null; const n = parseFloat(String(v).replace(/[$,%\s]/g, "")); return isNaN(n) ? null : n; };

const RATING_CATS = ["Kitchen", "Living Area", "Master", "Office", "Bedrooms"];
const emptyRatings = () => ({ kitchen: 0, living: 0, master: 0, office: 0, bedrooms: 0 });
const avgRating = (r) => { if (!r) return 0; const vals = Object.values(r).filter((v) => v > 0); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; };
const ratingKey = (label) => label.toLowerCase().replace(" area", "");

const FIELD_MAP = {
  address: ["ADDRESS", "STREET ADDRESS", "STREET"],
  city: ["CITY"],
  state: ["STATE OR PROVINCE", "STATE"],
  zip: ["ZIP OR POSTAL CODE", "ZIP", "POSTAL CODE"],
  price: ["PRICE", "LIST PRICE", "LISTING PRICE"],
  beds: ["BEDS", "BEDROOMS"],
  baths: ["BATHS", "BATHROOMS"],
  sqft: ["SQUARE FEET", "SQFT", "SQUARE FOOTAGE"],
  lotSize: ["LOT SIZE", "LOT SQFT"],
  yearBuilt: ["YEAR BUILT"],
  dom: ["DAYS ON MARKET", "DOM"],
  ppsf: ["$/SQUARE FEET", "PRICE/SQFT", "$/SQFT", "PPSF"],
  hoa: ["HOA/MONTH", "HOA"],
  propertyType: ["PROPERTY TYPE", "TYPE"],
  status: ["STATUS"],
  url: ["URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)", "URL", "REDFIN URL"],
  lat: ["LATITUDE", "LAT"],
  lng: ["LONGITUDE", "LNG", "LON", "LONG"],
};

const NUM_FIELDS = ["price", "beds", "baths", "sqft", "lotSize", "yearBuilt", "dom", "ppsf", "hoa", "lat", "lng"];

const SOLD_EXTRA_MAP = {
  soldDate: ["SOLD DATE", "SALE DATE", "CLOSE DATE"],
  saleType: ["SALE TYPE", "TYPE OF SALE"],
};

function mapRow(raw) {
  const out = { id: Math.random().toString(36).slice(2, 10), viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null };
  const keys = Object.keys(raw);
  for (const [field, alts] of Object.entries(FIELD_MAP)) {
    const k = keys.find((k) => alts.some((a) => k.trim().toUpperCase() === a.toUpperCase()));
    if (k) out[field] = NUM_FIELDS.includes(field) ? parseNum(raw[k]) : raw[k]?.trim?.() || "";
  }
  if (!out.ppsf && out.price && out.sqft) out.ppsf = Math.round(out.price / out.sqft);
  return out;
}

function mapSoldRow(raw) {
  const base = mapRow(raw);
  const keys = Object.keys(raw);
  for (const [field, alts] of Object.entries(SOLD_EXTRA_MAP)) {
    const k = keys.find((k) => alts.some((a) => k.trim().toUpperCase() === a.toUpperCase()));
    if (k) base[field] = raw[k]?.trim?.() || "";
  }
  base.isSold = true;
  return base;
}

/* Composite value score (0-100) — higher = better value */
function calcValueScore(h, allHomes) {
  let score = 50; // Start neutral

  // ── Price vs Appraisal (±20 pts) ──────────────────────────────
  if (h.appraisal?.value && h.price) {
    const gap = (h.price - h.appraisal.value) / h.appraisal.value;
    // -20% below appraisal = +20, +20% above = -20
    score += Math.max(-20, Math.min(20, -gap * 100));
  }

  // ── $/sqft vs area median (±15 pts) ───────────────────────────
  if (h.ppsf && allHomes.length > 3) {
    const ppsfList = allHomes.filter(x => x.ppsf).map(x => x.ppsf).sort((a, b) => a - b);
    const median = ppsfList[Math.floor(ppsfList.length / 2)];
    if (median) {
      const diff = (h.ppsf - median) / median;
      score += Math.max(-15, Math.min(15, -diff * 50));
    }
  }

  // ── School rating (0-15 pts) ──────────────────────────────────
  if (h.school?.rating != null) {
    score += (h.school.rating / 10) * 15; // 10/10 = +15, 1/10 = +1.5
  }

  // ── Flood risk (0 to -12 pts) ─────────────────────────────────
  if (h.flood?.risk === "high") score -= 12;
  else if (h.flood?.risk === "moderate") score -= 5;
  else if (h.flood?.risk === "low") score += 3;

  // ── Crime (0 to -8 pts) ───────────────────────────────────────
  if (h.crime?.risk === "high") score -= 8;
  else if (h.crime?.risk === "low") score += 4;

  // ── Parks & Green Space (0 to +8 pts) ────────────────────────
  if (h.parks?.greenSpaceScore === "excellent") score += 8;
  else if (h.parks?.greenSpaceScore === "good") score += 5;
  else if (h.parks?.greenSpaceScore === "fair") score += 2;
  if (h.parks?.hasTrail) score += 2;
  if (h.parks?.hasPlayground) score += 1;

  // ── DOM leverage (0-10 pts) ───────────────────────────────────
  const dom = h.dom || 0;
  if (dom > 90) score += 10;
  else if (dom > 60) score += 7;
  else if (dom > 30) score += 4;
  else if (dom > 14) score += 2;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* Quick monthly estimate for list view (no full calc needed) */
function quickMonthly(price, cashBudget = 750000, hoaMonthly = 0, rateAnnual = 6.0, closingPct = 2.5, taxPct = 1.8, home = null) {
  const closing = price * (closingPct / 100);
  const down = Math.max(0, Math.min(cashBudget - closing, price));
  const loan = price - down, r = rateAnnual / 100 / 12, n = 360;
  const pi = r > 0 ? (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : loan / n;
  const ins = home ? estimateInsurance(home).totalAnnual / 12 : 300;
  return pi + (price * taxPct / 100) / 12 + ins + hoaMonthly;
}

const DEFAULT_RATE = 6.0;

/* Calculate maximum affordable home price from income/debts */
function calcMaxBudget(fin) {
  if (!fin.grossIncome || fin.grossIncome <= 0) return null;
  const maxMonthlyHousing = (fin.grossIncome / 12) * ((fin.dtiLimit || 36) / 100) - (fin.monthlyDebts || 0);
  if (maxMonthlyHousing <= 0) return null;
  const r = (fin.rate || 6) / 100 / 12, n = (fin.term || 30) * 12;
  const piFactor = r > 0 ? (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : 1 / n;
  const taxMonthlyFactor = (fin.propTax || 1.8) / 100 / 12;
  const estInsMonthly = 350; // rough avg insurance estimate
  const closingPct = (fin.closing || 2.5) / 100;
  const cashForDown = Math.max(0, fin.cash - 0); // will iterate
  // Solve: price * (piFactor*(1-closingPct) + taxMonthlyFactor) + estInsMonthly = maxMonthlyHousing + cashForDown * piFactor
  // price*(piFactor - piFactor*downRatio + taxMonthlyFactor) = maxMonthlyHousing - estInsMonthly + down*piFactor
  // Iterative: start with down = cash * 0.8, solve for price, adjust
  let price = 0;
  for (let i = 0; i < 5; i++) {
    const closing = price * closingPct;
    const down = Math.max(0, Math.min(fin.cash - closing, price));
    const loan = price - down;
    const pi = loan * piFactor;
    const tax = price * taxMonthlyFactor;
    const total = pi + tax + estInsMonthly;
    const diff = maxMonthlyHousing - total;
    if (i === 0) {
      // Initial estimate
      price = (maxMonthlyHousing - estInsMonthly + fin.cash * piFactor) / (piFactor + taxMonthlyFactor);
    } else {
      price += diff / (piFactor + taxMonthlyFactor);
    }
    if (price < 0) { price = 0; break; }
  }
  return { maxPrice: Math.round(price), maxMonthly: Math.round(maxMonthlyHousing) };
}

async function fetchLiveRate() {
  // Check localStorage cache first (valid for 6h)
  try {
    const cached = JSON.parse(localStorage.getItem("cribs_live_rate") || "null");
    if (cached && cached.rate && Date.now() - cached.ts < 21600000) {
      return { rate: cached.rate, source: cached.source || "Freddie Mac PMMS", asOf: cached.asOf };
    }
  } catch {}
  try {
    // Call our Vercel serverless function (fetches from Freddie Mac)
    const res = await fetch("/api/rate", { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.rate && typeof data.rate === "number" && data.rate > 0 && data.rate < 20) {
      try { localStorage.setItem("cribs_live_rate", JSON.stringify({ rate: data.rate, source: data.source, asOf: data.asOf, ts: Date.now() })); } catch {}
      return data;
    }
  } catch (e) { /* fall through */ }
  // Check cache as fallback (even if expired)
  try {
    const cached = JSON.parse(localStorage.getItem("cribs_live_rate") || "null");
    if (cached && cached.rate) {
      return { rate: cached.rate, source: "Cached", asOf: cached.asOf };
    }
  } catch {}
  return null;
}


async function fetchAppraisal(address, city, state) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "You are a property data extraction tool. Search for the latest county tax appraisal value for the given property. For Texas properties, check the county appraisal district (e.g. HCAD for Harris County). Return ONLY a JSON object with no other text, no markdown, no backticks. Shape: {\"appraisalValue\": <number>, \"appraisalYear\": <number like 2025>, \"source\": \"<district name>\"}. If you cannot find the value, return {\"appraisalValue\": null, \"appraisalYear\": null, \"source\": null}.",
        messages: [{ role: "user", content: `Find the latest property tax appraisal value for: ${address}, ${city}, ${state}. Search the county appraisal district website. Return only the JSON.` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await res.json();
    const text = data.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.appraisalValue && typeof parsed.appraisalValue === "number" && parsed.appraisalValue > 0) {
      return parsed;
    }
  } catch (e) { /* fall through */ }
  return null;
}

async function fetchFloodZone(address, city, state, zip) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a flood risk data extraction tool. Search for FEMA flood zone designation for the given property address. Look up the address on FEMA's Flood Map Service Center or any reliable flood zone lookup tool. Return ONLY a JSON object with no other text, no markdown, no backticks. Shape: {"zone": "<FEMA zone code like X, AE, A, AO, VE, etc>", "zoneDesc": "<short description like 'Minimal Flood Hazard' or '100-Year Floodplain'>", "risk": "<low|moderate|high>", "panel": "<FEMA map panel number if found, or null>", "notes": "<any relevant detail like BFE or special considerations>"}. Risk mapping: Zone X/C = low, Zone X shaded/B/0.2% = moderate, Zones A/AE/AO/AH/V/VE = high. If you cannot find the info, return {"zone": null, "zoneDesc": null, "risk": null, "panel": null, "notes": null}.`,
        messages: [{ role: "user", content: `Find the FEMA flood zone designation for: ${address}, ${city}, ${state} ${zip || ""}. Search FEMA flood maps or any flood zone lookup service. Return only the JSON.` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await res.json();
    const text = data.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.zone) return parsed;
  } catch (e) { /* fall through */ }
  return null;
}

async function fetchCrime(address, city, state, zip) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a neighborhood crime data extraction tool. Search for crime statistics and safety ratings for the given property's neighborhood or ZIP code. Look for data from sources like NeighborhoodScout, CrimeGrade, SpotCrime, local police department crime maps, or city open data portals. Return ONLY a JSON object with no other text, no markdown, no backticks. Shape: {"risk": "<low|moderate|high>", "grade": "<A+|A|A-|B+|B|B-|C+|C|C-|D+|D|D-|F or null>", "violentPerK": <violent crimes per 1000 residents per year or null>, "propertyPerK": <property crimes per 1000 residents per year or null>, "nationalAvgViolent": 4.0, "nationalAvgProperty": 19.6, "topConcerns": ["<top 2-3 crime types in area>"], "source": "<data source name>", "notes": "<any relevant context like trends, nearby areas, or specific safety considerations>"}. Risk mapping: grade A/B = low, C = moderate, D/F = high. If you cannot find data, return {"risk": null, "grade": null, "violentPerK": null, "propertyPerK": null, "nationalAvgViolent": 4.0, "nationalAvgProperty": 19.6, "topConcerns": [], "source": null, "notes": null}.`,
        messages: [{ role: "user", content: `Find neighborhood crime statistics and safety rating for the area around: ${address}, ${city}, ${state} ${zip || ""}. Search crime data sources. Return only the JSON.` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await res.json();
    const text = data.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.risk) return parsed;
  } catch (e) { /* fall through */ }
  return null;
}

async function fetchSchool(address, city, state, zip) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: `You are a school zoning data extraction tool. Search for the zoned elementary school for the given property address. Look for data from the local school district (e.g. HISD for Houston), GreatSchools.org, Niche.com, or similar sources. Find the specific elementary school the address is zoned to and its rating. Return ONLY a JSON object with no other text, no markdown, no backticks. Shape: {"schoolName": "<full school name>", "district": "<school district name>", "rating": <GreatSchools rating 1-10 or null>, "ratingSource": "<GreatSchools|Niche|etc>", "tier": "<great|good|below>", "grades": "<grade range like PK-5 or K-5>", "enrollment": <number or null>, "distance": "<approximate distance like 0.4 mi or null>", "nicheGrade": "<A+|A|A-|B+|B|B-|C+|C|C-|D|F or null>", "testScores": <percentage of students at or above proficiency in math+reading, integer 0-100 or null>, "studentTeacherRatio": <student-to-teacher ratio as integer like 14 or 16, or null>, "notes": "<any relevant detail like magnet programs, dual language, recent improvements, or boundary changes>"}. Tier mapping: rating 8-10 = great, 5-7 = good, 1-4 = below. If you cannot find the info, return {"schoolName": null, "district": null, "rating": null, "ratingSource": null, "tier": null, "grades": null, "enrollment": null, "distance": null, "nicheGrade": null, "testScores": null, "studentTeacherRatio": null, "notes": null}.`,
        messages: [{ role: "user", content: `Find the zoned elementary school for the property at: ${address}, ${city}, ${state} ${zip || ""}. Search for which elementary school this address is zoned to and its GreatSchools or Niche rating. Return only the JSON.` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await res.json();
    const text = data.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.schoolName) return parsed;
  } catch (e) { /* fall through */ }
  return null;
}

async function fetchNearbyParks(address, city, state, zip, lat, lng) {
  if (!lat || !lng) return null;
  try {
    const radius = 1609; // 1 mile in meters
    const query = `[out:json][timeout:10];(nwr["leisure"="park"](around:${radius},${lat},${lng});nwr["leisure"="nature_reserve"](around:${radius},${lat},${lng});nwr["leisure"="playground"](around:${radius},${lat},${lng});way["highway"~"path|cycleway"]["name"](around:${radius},${lat},${lng}););out center tags qt 40;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.elements || !Array.isArray(data.elements)) return null;

    // Dedupe by name (OSM often has node + way for same park)
    const seen = new Set();
    const parks = [];
    let hasTrailFlag = false, hasPlaygroundFlag = false;

    for (const el of data.elements) {
      const name = el.tags?.name;
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;
      if (!elLat || !elLng) continue;

      const dist = haversine(lat, lng, elLat, elLng);
      if (dist > 1.05) continue; // small buffer for rounding

      const tags = el.tags || {};
      const leisure = tags.leisure || "";
      const highway = tags.highway || "";

      // Determine type
      let type = "Park";
      if (leisure === "nature_reserve") type = "Nature Preserve";
      else if (leisure === "playground") type = "Playground";
      else if (highway === "path" || highway === "cycleway") type = "Trail";
      else if (tags.garden || leisure === "garden") type = "Garden";

      if (type === "Trail" || highway === "path" || highway === "cycleway") hasTrailFlag = true;
      if (leisure === "playground" || tags.playground) hasPlaygroundFlag = true;

      // Extract amenities from tags
      const amenities = [];
      if (tags.sport) amenities.push(...tags.sport.split(";").map(s => s.trim()));
      if (tags.playground || leisure === "playground") amenities.push("Playground");
      if (tags.swimming_pool === "yes" || tags.sport?.includes("swimming")) amenities.push("Pool");
      if (tags.leisure === "pitch" || tags.sport) { /* already added sport */ }
      if (tags.lit === "yes") amenities.push("Lit paths");
      if (tags.dog === "yes" || tags.dogs === "yes") amenities.push("Dogs allowed");
      if (tags.bicycle === "yes" || highway === "cycleway") amenities.push("Cycling");
      if (tags.picnic_table === "yes" || tags.bbq === "yes") amenities.push("Picnic area");

      // Estimate acres from way_area tag or leave null
      let acres = null;
      if (tags.way_area) acres = Math.round(parseFloat(tags.way_area) * 0.000247105 * 10) / 10;

      parks.push({ name, distanceMi: Math.round(dist * 100) / 100, type, acres, amenities: [...new Set(amenities)].slice(0, 5) });
    }

    // Also check if any park had playground tagged inside
    for (const el of data.elements) {
      if (el.tags?.leisure === "playground") hasPlaygroundFlag = true;
    }

    parks.sort((a, b) => a.distanceMi - b.distanceMi);
    const top = parks.slice(0, 4);
    const count = parks.length;
    const nearest = top[0] || null;
    const score = count >= 4 ? "excellent" : count >= 2 ? "good" : count >= 1 ? "fair" : "poor";

    return {
      parks: top,
      nearestParkName: nearest?.name || null,
      nearestDistanceMi: nearest?.distanceMi ?? null,
      parkCount1Mi: count,
      hasTrail: hasTrailFlag,
      hasPlayground: hasPlaygroundFlag,
      greenSpaceScore: score,
      notes: count > 0 ? `${count} green space${count !== 1 ? "s" : ""} within 1 mile. Nearest: ${nearest?.name} (${nearest?.distanceMi} mi).` : "No parks found within 1 mile.",
    };
  } catch (e) { /* Overpass failed, use known park locations */ }
  return generateParks(lat, lng);
}

// Known Spring Branch / Memorial area parks for instant distance calc
const HOUSTON_PARKS = [
  { name: "Binglewood Park", lat: 29.8035, lng: -95.4902, type: "Park", acres: 4, amenities: ["Playground", "Pavilion"] },
  { name: "Spring Branch Park", lat: 29.7942, lng: -95.4718, type: "Park", acres: 8, amenities: ["Playground", "Sports fields", "Basketball"] },
  { name: "Bendwood Park", lat: 29.7975, lng: -95.4810, type: "Park", acres: 5, amenities: ["Playground", "Tennis"] },
  { name: "Memorial Park", lat: 29.7641, lng: -95.4391, type: "Park", acres: 1466, amenities: ["Trail", "Golf", "Sports fields", "Cycling"] },
  { name: "Terry Hershey Park", lat: 29.7628, lng: -95.5683, type: "Trail", acres: 500, amenities: ["Trail", "Cycling", "Jogging"] },
  { name: "Bear Creek Pioneers Park", lat: 29.8125, lng: -95.6233, type: "Park", acres: 2154, amenities: ["Trail", "Playground", "Sports fields"] },
  { name: "Nottingham Park", lat: 29.7832, lng: -95.4986, type: "Park", acres: 12, amenities: ["Playground", "Sports fields", "Pavilion"] },
  { name: "Hunters Creek Park", lat: 29.7702, lng: -95.4685, type: "Park", acres: 3, amenities: ["Playground"] },
  { name: "Spring Branch West Park", lat: 29.8010, lng: -95.5145, type: "Park", acres: 6, amenities: ["Playground", "Basketball"] },
  { name: "Westwood Park", lat: 29.7990, lng: -95.4587, type: "Park", acres: 3, amenities: ["Playground"] },
  { name: "Rummel Creek Park", lat: 29.7870, lng: -95.5340, type: "Park", acres: 7, amenities: ["Playground", "Sports fields"] },
  { name: "Pine Chase Park", lat: 29.8076, lng: -95.5050, type: "Park", acres: 4, amenities: ["Playground", "Pavilion"] },
  { name: "Shadowbriar Park", lat: 29.7300, lng: -95.4890, type: "Park", acres: 3, amenities: ["Playground"] },
  { name: "Briarbend Park", lat: 29.7216, lng: -95.4636, type: "Park", acres: 5, amenities: ["Playground", "Tennis"] },
];

function generateParks(lat, lng) {
  if (!lat || !lng) return null;
  const parks = [];
  let hasTrailFlag = false, hasPlaygroundFlag = false;
  for (const p of HOUSTON_PARKS) {
    const dist = haversine(lat, lng, p.lat, p.lng);
    if (dist > 1.05) continue;
    parks.push({ name: p.name, distanceMi: Math.round(dist * 100) / 100, type: p.type, acres: p.acres, amenities: p.amenities });
    if (p.type === "Trail" || p.amenities.includes("Trail")) hasTrailFlag = true;
    if (p.amenities.includes("Playground")) hasPlaygroundFlag = true;
  }
  parks.sort((a, b) => a.distanceMi - b.distanceMi);
  const top = parks.slice(0, 4);
  const count = parks.length;
  const nearest = top[0] || null;
  const score = count >= 4 ? "excellent" : count >= 2 ? "good" : count >= 1 ? "fair" : "poor";
  return {
    parks: top,
    nearestParkName: nearest?.name || null,
    nearestDistanceMi: nearest?.distanceMi ?? null,
    parkCount1Mi: count,
    hasTrail: hasTrailFlag,
    hasPlayground: hasPlaygroundFlag,
    greenSpaceScore: score,
    notes: count > 0 ? `${count} green space${count !== 1 ? "s" : ""} within 1 mile.` : "No parks found within 1 mile.",
  };
}

// Known Houston-area grocery store locations for instant distance calc
const HOUSTON_GROCERIES = {
  heb: [
    { name: "H-E-B Spring Branch Market", lat: 29.7907, lng: -95.4957, address: "8106 Long Point Rd" },
    { name: "H-E-B Bunker Hill", lat: 29.7794, lng: -95.5310, address: "9710 Katy Fwy" },
    { name: "H-E-B Heights", lat: 29.7928, lng: -95.3983, address: "2300 N Shepherd Dr" },
    { name: "H-E-B Buffalo Heights", lat: 29.7611, lng: -95.3947, address: "3663 Washington Ave" },
  ],
  costco: [
    { name: "Costco Richmond Ave", lat: 29.7259, lng: -95.5536, address: "9920 Westpark Dr" },
    { name: "Costco Bunker Hill", lat: 29.7777, lng: -95.5553, address: "1150 Bunker Hill Rd" },
    { name: "Costco North Fwy", lat: 29.9037, lng: -95.4166, address: "4801 N Fwy" },
  ],
  wholefoods: [
    { name: "Whole Foods Post Oak", lat: 29.7490, lng: -95.4613, address: "1700 Post Oak Blvd" },
    { name: "Whole Foods Montrose", lat: 29.7507, lng: -95.3920, address: "701 Waugh Dr" },
    { name: "Whole Foods Champions", lat: 29.9822, lng: -95.5044, address: "10133 Louetta Rd" },
  ],
  traderjoes: [
    { name: "Trader Joe's Woodway", lat: 29.7595, lng: -95.4660, address: "1440 S Voss Rd" },
    { name: "Trader Joe's Alabama", lat: 29.7416, lng: -95.3915, address: "1440 W Alabama St" },
    { name: "Trader Joe's Katy", lat: 29.7738, lng: -95.6483, address: "23330 Grand Cir Blvd" },
  ],
};

function generateGroceries(lat, lng) {
  if (!lat || !lng) return null;
  const result = {};
  for (const [key, locations] of Object.entries(HOUSTON_GROCERIES)) {
    let best = null;
    for (const loc of locations) {
      const dist = haversine(lat, lng, loc.lat, loc.lng);
      if (!best || dist < best.distanceMi) {
        best = { name: loc.name, distanceMi: Math.round(dist * 100) / 100, lat: loc.lat, lng: loc.lng, address: loc.address };
      }
    }
    result[key] = best;
  }
  return result;
}

async function fetchNearbyGroceries(lat, lng) {
  if (!lat || !lng) return null;
  try {
    const radius = 16093; // 10 miles in meters
    const query = `[out:json][timeout:10];(nwr["shop"~"supermarket"]["name"~"H-E-B|HEB",i](around:${radius},${lat},${lng});nwr["shop"~"supermarket"]["name"~"Costco",i](around:${radius},${lat},${lng});nwr["shop"~"supermarket"]["name"~"Whole Foods",i](around:${radius},${lat},${lng});nwr["shop"~"supermarket"]["name"~"Trader Joe",i](around:${radius},${lat},${lng}););out center tags qt;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data.elements || !Array.isArray(data.elements)) return null;

    const chains = [
      { key: "heb", patterns: ["h-e-b", "heb"], label: "H-E-B", icon: "\U0001F6D2" },
      { key: "costco", patterns: ["costco"], label: "Costco", icon: "\U0001F3EA" },
      { key: "wholefoods", patterns: ["whole foods"], label: "Whole Foods", icon: "\U0001F96C" },
      { key: "traderjoes", patterns: ["trader joe"], label: "Trader Joe's", icon: "\U0001F34A" },
    ];

    const result = {};
    for (const chain of chains) {
      let best = null;
      for (const el of data.elements) {
        const name = (el.tags?.name || "").toLowerCase();
        if (!chain.patterns.some(p => name.includes(p))) continue;
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;
        if (!elLat || !elLng) continue;
        const dist = haversine(lat, lng, elLat, elLng);
        if (!best || dist < best.distanceMi) {
          best = { name: el.tags?.name || chain.label, distanceMi: Math.round(dist * 100) / 100, lat: elLat, lng: elLng, address: el.tags?.["addr:street"] ? `${el.tags["addr:housenumber"] || ""} ${el.tags["addr:street"]}`.trim() : null };
        }
      }
      result[chain.key] = best;
    }
    return result;
  } catch (e) { /* Overpass failed, use known store locations */ }
  return generateGroceries(lat, lng);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateCommute(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const crowMiles = haversine(lat1, lng1, lat2, lng2);
  const roadMiles = crowMiles * 1.35; // road winding factor
  // Houston avg speeds: <5 mi ~22mph (city), 5-15 mi ~28mph (mixed), >15 mi ~35mph (highway)
  const avgSpeed = roadMiles < 5 ? 22 : roadMiles < 15 ? 28 : 35;
  const minutes = Math.round((roadMiles / avgSpeed) * 60);
  return { miles: Math.round(roadMiles * 10) / 10, minutes };
}

/* Per-home insurance estimate for Houston/Harris County */
function estimateInsurance(home) {
  const sqft = home.sqft || 2500;
  const yearBuilt = home.yearBuilt || 1990;
  const age = new Date().getFullYear() - yearBuilt;
  // Dwelling coverage = rebuild cost, not market value
  const isNew = yearBuilt >= 2020;
  const rebuildPerSqft = isNew ? 240 : 200;
  const dwellingCoverage = sqft * rebuildPerSqft;
  // Base rate: TX avg ~$0.55-0.70 per $100, Houston higher due to wind/hail
  let ratePerHundred = 0.62;
  if (age <= 5) ratePerHundred -= 0.08;
  else if (age <= 15) ratePerHundred -= 0.03;
  else if (age >= 40) ratePerHundred += 0.10;
  else if (age >= 25) ratePerHundred += 0.05;
  if (sqft > 4500) ratePerHundred += 0.04;
  if (sqft > 6000) ratePerHundred += 0.03;
  const homeownersAnnual = Math.round((dwellingCoverage / 100) * ratePerHundred);
  // Flood insurance
  let floodAnnual = 0, floodNote = "Zone X — flood insurance optional (~$500/yr)";
  const floodRisk = home.flood?.risk;
  if (floodRisk === "high") {
    floodAnnual = Math.round(Math.max(2400, dwellingCoverage * 0.0045));
    floodNote = "Zone AE — flood insurance required";
  } else if (floodRisk === "moderate") {
    floodAnnual = Math.round(Math.max(800, dwellingCoverage * 0.0012));
    floodNote = "Zone X-shaded — flood insurance recommended";
  }
  return { homeownersAnnual, floodAnnual, totalAnnual: homeownersAnnual + floodAnnual, dwellingCoverage, rebuildPerSqft, ratePerHundred, floodNote };
}

function calcMortgage(price, downAmount, rate, termYears, propTaxRate, insuranceAnnual, hoaMonthly, closingPct) {
  const down = Math.min(downAmount, price), loan = price - down, r = rate / 100 / 12, n = termYears * 12;
  const monthlyPI = r > 0 ? (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : loan / n;
  const monthlyTax = (price * (propTaxRate / 100)) / 12, monthlyIns = insuranceAnnual / 12;
  const totalMonthly = monthlyPI + monthlyTax + monthlyIns + (hoaMonthly || 0);
  const totalInterest = monthlyPI * n - loan, closingCosts = price * (closingPct / 100);
  const schedule = []; let bal = loan;
  for (let y = 1; y <= termYears; y++) {
    let yi = 0, yp = 0;
    for (let m = 0; m < 12; m++) { const ip = bal * r; const pp = monthlyPI - ip; yi += ip; yp += pp; bal -= pp; }
    schedule.push({ year: y, principal: yp, interest: yi, balance: Math.max(0, bal) });
  }
  return { down, loan, monthlyPI, monthlyTax, monthlyIns, totalMonthly, totalInterest, closingCosts, schedule };
}

/* ─── Icons ──────────────────────────────────────────────────────── */
const Icon = ({ d, className = "w-5 h-5", stroke = true }) => (
  <svg className={className} viewBox="0 0 24 24" fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const HomeIcon = (p) => <Icon {...p} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" />;
const ChartIcon = (p) => <Icon {...p} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />;
const CompareIcon = (p) => (
  <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="8" height="16" rx="1.5"/><rect x="14" y="4" width="8" height="16" rx="1.5"/>
    <path d="M10 9l2 3-2 3" opacity="0.5"/><path d="M14 9l-2 3 2 3" opacity="0.5"/>
  </svg>
);
const LinkIcon = (p) => <Icon {...p} d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />;
const BackIcon = (p) => <Icon {...p} d="M15 19l-7-7 7-7" />;
const PlusIcon = (p) => <Icon {...p} d="M12 4v16m8-8H4" />;
const SearchIcon = (p) => <Icon {...p} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />;
const SettingsIcon = (p) => <Icon {...p} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />;
const MicIcon = (p) => <Icon {...p} d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />;
const MicOffIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
const FloodIcon = ({ risk, className }) => {
  const color = risk === "high" ? "text-orange-500" : risk === "moderate" ? "text-amber-500" : "text-sky-500";
  const drop = "M12 2C12 2 6 10.5 6 14.5C6 18.09 8.69 21 12 21C15.31 21 18 18.09 18 14.5C18 10.5 12 2 12 2Z";
  const count = risk === "high" ? 3 : risk === "moderate" ? 2 : 1;
  return (
    <span className={`inline-flex items-end gap-px ${color} ${className || ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <svg key={i} className={count === 1 ? "w-3.5 h-3.5" : "w-3 h-3"} viewBox="0 0 24 24" fill="currentColor"><path d={drop}/></svg>
      ))}
    </span>
  );
};
const CrimeIcon = ({ risk, className }) => {
  const color = risk === "high" ? "text-orange-500" : risk === "moderate" ? "text-amber-500" : "text-sky-500";
  const shield = "M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7L12 2z";
  const count = risk === "high" ? 3 : risk === "moderate" ? 2 : 1;
  return (
    <span className={`inline-flex items-end gap-px ${color} ${className || ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <svg key={i} className={count === 1 ? "w-3.5 h-3.5" : "w-3 h-3"} viewBox="0 0 24 24" fill="currentColor"><path d={shield}/></svg>
      ))}
    </span>
  );
};
const ParkIcon = ({ score, className }) => {
  const color = score === "excellent" ? "text-emerald-500" : score === "good" ? "text-teal-500" : score === "fair" ? "text-amber-500" : "text-stone-400";
  return (
    <div className={`flex items-center gap-0.5 ${color} ${className || ""}`}>
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17 12c-3.87 0-7 3.13-7 7h2c0-2.76 2.24-5 5-5s5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-5C10.93 7 6.18 10.17 4.25 15h2.1c1.73-3.71 5.5-6.29 9.65-6.29S22.17 11.29 23.9 15H26c-1.93-4.83-6.68-8-12.75-8zM12 22H2v2h10v-2zm1-3H3v2h10v-2z"/></svg>
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8 2 5 5 5 8.5c0 2 1 3.5 2 4.5V22h2v-5h6v5h2V13c1-1 2-2.5 2-4.5C19 5 16 2 12 2zm-1 15H9v-1.5h2V17zm0-3H9v-1.5h2V14zm4 3h-2v-1.5h2V17zm0-3h-2v-1.5h2V14z"/></svg>
    </div>
  );
};
const SchoolIcon = ({ tier, className }) => {
  const color = tier === "great" ? "text-sky-500" : tier === "good" ? "text-amber-500" : "text-orange-500";
  const book = "M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20";
  const count = tier === "great" ? 3 : tier === "good" ? 2 : 1;
  return (
    <span className={`inline-flex items-end gap-px ${color} ${className || ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <svg key={i} className={count === 1 ? "w-3.5 h-3.5" : "w-3 h-3"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={book}/></svg>
      ))}
    </span>
  );
};
const StarIcon = ({ filled, ...p }) => (
  <svg {...p} viewBox="0 0 20 20" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
  </svg>
);

/* ─── Shared Components ──────────────────────────────────────────── */
function StarRating({ value, onChange, size = "w-6 h-6" }) {
  const containerRef = useRef(null);
  const [dragValue, setDragValue] = useState(null);
  const [hoverValue, setHoverValue] = useState(null);
  const display = dragValue != null ? dragValue : hoverValue != null ? hoverValue : value;

  const getStarFromX = (clientX) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const starWidth = rect.width / 5;
    return Math.max(0, Math.min(5, Math.ceil(x / starWidth)));
  };

  const handleTouchStart = (e) => {
    e.preventDefault();
    const star = getStarFromX(e.touches[0].clientX);
    setDragValue(star);
  };
  const handleTouchMove = (e) => {
    e.preventDefault();
    const star = getStarFromX(e.touches[0].clientX);
    setDragValue(star);
  };
  const handleTouchEnd = (e) => {
    e.preventDefault();
    if (dragValue != null) {
      onChange(dragValue === value ? 0 : dragValue);
      setDragValue(null);
    }
  };

  return (
    <div ref={containerRef} className="flex gap-1 touch-none select-none"
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
      onMouseLeave={() => setHoverValue(null)}>
      {[1, 2, 3, 4, 5].map((s) => (
        <button key={s}
          onClick={() => onChange(value === s ? 0 : s)}
          onMouseEnter={() => setHoverValue(s)}
          className={`${size} transition-colors star-tap ${s <= display ? "text-amber-400" : "text-stone-300"}`}>
          <StarIcon filled={s <= display} className="w-full h-full" />
        </button>
      ))}
    </div>
  );
}

function InputField({ label, value, onChange, type = "text", prefix, suffix }) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1 tracking-wide uppercase font-medium">{label}</label>
      <div className="relative">
        {prefix && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 text-sm">{prefix}</span>}
        <input type={type} value={value} onChange={(e) => onChange(type === "number" ? parseFloat(e.target.value) || 0 : e.target.value)}
          className={`w-full bg-white border border-stone-200 rounded-lg text-sm text-stone-800 py-2.5 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all ${prefix ? "pl-7" : "pl-3"} ${suffix ? "pr-8" : "pr-3"}`} />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 text-sm">{suffix}</span>}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s.includes("new")) return <span className="text-[10px] font-bold text-sky-600 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide anim-pulse">New</span>;
  if (s.includes("drop") || s.includes("reduced")) return <span className="text-[10px] font-bold text-orange-600 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">Price Drop</span>;
  if (s.includes("pending") || s.includes("contingent")) return <span className="text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">Pending</span>;
  return null;
}

function DropZone({ onImport, compact }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const handleFile = async (file) => {
    const mod = await import("papaparse");
    const Papa = mod.default || mod;
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => {
      onImport(r.data.map(mapRow).filter((h) => h.address || h.price));
    }});
  };
  if (compact) return (
    <button onClick={() => fileRef.current?.click()}
      className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-sky-600 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 active:bg-sky-200 transition-colors flex-shrink-0">
      <PlusIcon className="w-4 h-4" /> Import
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
    </button>
  );
  return (
    <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
      onClick={() => fileRef.current?.click()}
      className={`border-2 border-dashed rounded-2xl p-10 md:p-12 text-center cursor-pointer transition-all duration-300 ${dragging ? "border-sky-400 bg-sky-50 scale-[1.01]" : "border-stone-300 hover:border-sky-300 hover:bg-sky-50/30 bg-white"}`}>
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
      <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-sky-50 border border-sky-200 flex items-center justify-center"><PlusIcon className="w-6 h-6 text-sky-500" /></div>
      <p className="text-stone-700 font-semibold">Import Redfin CSV</p>
      <p className="text-stone-400 text-sm mt-1">Drop file here or tap to browse</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN: Home List
   ═══════════════════════════════════════════════════════════════════ */
function HomeListScreen({ homes, setHomes, onOpenHome, compareList, toggleCompare, onImport, fin, rateInfo, schoolFilter, setSchoolFilter, maxBudget, enrichDone }) {
  const [filter, setFilter] = useState("");
  const [viewedFilter, setViewedFilter] = useState("all");
  const [sortKey, setSortKey] = useState("price");
  const [sortAsc, setSortAsc] = useState(false);
  const [userLoc, setUserLoc] = useState(null);
  const [locLoading, setLocLoading] = useState(false);

  const requestLocation = () => {
    if (userLoc) return;
    setLocLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocLoading(false); },
      () => { setLocLoading(false); },
      { enableHighAccuracy: false, timeout: 8000 }
    );
  };

  const distanceFor = (h) => {
    if (!userLoc || !h.lat || !h.lng) return 9999;
    return haversine(userLoc.lat, userLoc.lng, h.lat, h.lng);
  };

  const valueScores = useMemo(() => {
    const scores = {};
    homes.forEach(h => { scores[h.id] = calcValueScore(h, homes); });
    return scores;
  }, [homes]);

  const filtered = useMemo(() => {
    let list = [...homes];
    if (filter) { const q = filter.toLowerCase(); list = list.filter((h) => [h.address, h.city, h.zip].some((v) => v?.toLowerCase?.().includes(q))); }
    if (schoolFilter) list = list.filter((h) => h.school?.schoolName === schoolFilter);
    if (viewedFilter === "favorites") list = list.filter((h) => h.favorite);
    if (viewedFilter === "viewed") list = list.filter((h) => h.viewed);
    if (viewedFilter === "not_viewed") list = list.filter((h) => !h.viewed);
    if (sortKey === "distance") {
      list.sort((a, b) => distanceFor(a) - distanceFor(b));
    } else {
      const getVal = (h) => {
        if (sortKey === "schoolRating") return h.school?.rating ?? null;
        if (sortKey === "floodRisk") { const m = { low: 1, moderate: 2, high: 3 }; return m[h.flood?.risk] ?? null; }
        if (sortKey === "nearestPark") return h.parks?.nearestDistanceMi ?? null;
        if (sortKey === "appraisalPct") return h.appraisal && h.price ? ((h.price - h.appraisal.value) / h.appraisal.value * 100) : null;
        if (sortKey === "value") return valueScores[h.id] ?? null;
        return h[sortKey];
      };
      list.sort((a, b) => {
        const av = getVal(a), bv = getVal(b);
        if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
        return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      });
    }
    return list;
  }, [homes, filter, schoolFilter, viewedFilter, sortKey, sortAsc, userLoc, valueScores]);

  const stats = useMemo(() => {
    const prices = filtered.map((h) => h.price).filter(Boolean);
    const enriched = filtered.filter((h) => h.flood && h.crime && h.school).length;
    const inBudget = maxBudget ? filtered.filter((h) => h.price && h.price <= maxBudget.maxPrice).length : null;
    return {
      count: filtered.length, viewed: filtered.filter((h) => h.viewed).length,
      avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
      enriched, total: homes.length, inBudget,
    };
  }, [filtered, homes, maxBudget]);

  const toggleSort = (key) => { if (sortKey === key) setSortAsc(!sortAsc); else { setSortKey(key); setSortAsc(key === "address" || key === "floodRisk" || key === "appraisalPct"); } };
  const SortHeader = ({ field, children }) => (
    <th onClick={() => toggleSort(field)} className="py-3 px-3 text-left text-xs font-semibold tracking-wider uppercase text-stone-400 cursor-pointer hover:text-sky-600 transition-colors select-none whitespace-nowrap">
      {children} {sortKey === field ? (sortAsc ? "↑" : "↓") : ""}
    </th>
  );

  const sortOptions = [
    { key: "value", label: "Value" },
    { key: "price", label: "Price" },
    { key: "ppsf", label: "$/Sqft" },
    { key: "sqft", label: "Size" },
    { key: "schoolRating", icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.62 48.62 0 0112 20.904a48.62 48.62 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15v-3.75m0 0h-.008v.008H6.75V11.25z" /></svg> },
    { key: "floodRisk", icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c0 0-5.5 7.5-5.5 11.5C6.5 16.54 8.96 19 12 19s5.5-2.46 5.5-5.5C17.5 9.5 12 2 12 2z"/></svg> },
    { key: "nearestPark", icon: <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 2 6 5 6 8c0 2 1.5 3.5 3 4.5V22h6V12.5c1.5-1 3-2.5 3-4.5 0-3-2.5-6-6-6z"/></svg> },
    { key: "distance", label: "Nearest" },
  ];

  if (homes.length === 0) return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto">
      <div className="text-center mb-8 mt-8">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 flex items-center justify-center shadow-lg shadow-fuchsia-200 anim-pop">
          <svg className="w-9 h-9" viewBox="0 0 24 24" fill="white"><path d="M12 3L2 12h3v8h5v-5h4v5h5v-8h3L12 3z"/></svg>
        </div>
        <h2 className="text-2xl font-bold text-stone-800 mb-2 anim-fade-up" style={{ animationDelay: '150ms' }}>CRIBS</h2>
        <p className="text-stone-500 max-w-sm mx-auto anim-fade-up" style={{ animationDelay: '250ms' }}>Import your Redfin search results to track viewings, rate rooms, compare homes, and model financials.</p>
      </div>
      <DropZone onImport={onImport} />
    </div>
  );

  return (
    <div className="p-4 md:p-6 overflow-hidden">
      {/* Stats */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-0.5 -mx-1 px-1">
        {[
          { label: "Listings", value: viewedFilter !== "all" || filter || schoolFilter ? `${stats.count} / ${stats.total}` : stats.count, color: "text-sky-600" },
          { label: "Viewed", value: `${stats.viewed}/${stats.count}`, color: "text-teal-600" },
          ...(stats.inBudget != null ? [{ label: "In Budget", value: `${stats.inBudget}/${stats.count}`, color: stats.inBudget > 0 ? "text-emerald-600" : "text-orange-600" }] : []),
          { label: "Avg Price", value: fmt(stats.avg), color: "text-stone-800" },
          { label: "30yr Rate", value: rateInfo.loading ? "..." : `${fin.rate}%`, color: rateInfo.loading ? "text-stone-400" : "text-sky-600", sub: rateInfo.loading ? "Fetching" : rateInfo.source === "default" ? "Default" : "Live" },
          ...(stats.enriched < stats.count && !enrichDone ? [{ label: "Data", value: `${stats.enriched}/${stats.count}`, color: "text-violet-600", sub: "Enriching" }] : []),
        ].map((s, i) => (
          <div key={s.label} style={{ animationDelay: `${i * 60}ms` }} className="anim-fade-up bg-white border border-stone-200 rounded-xl px-3.5 py-2.5 shadow-sm flex-shrink-0">
            <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">{s.label}</div>
            <div className={`text-sm font-bold ${s.color} tabular-nums`}>{s.value}</div>
            {s.sub && <div className={`text-[9px] font-semibold uppercase tracking-wider ${s.sub === "Live" ? "text-teal-500" : s.sub === "Enriching" ? "text-violet-400 animate-pulse" : s.sub === "Fetching" ? "text-stone-400 animate-pulse" : "text-stone-400"}`}>{s.sub === "Live" && "● "}{s.sub === "Enriching" && "● "}{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Filters + Import */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <div className="flex-1 min-w-0 relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <input type="text" placeholder="Search address, city, zip..." value={filter} onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-white border border-stone-200 rounded-lg pl-8 pr-3 py-2.5 text-sm text-stone-700 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
        </div>
        <div className="flex gap-0.5 bg-stone-100 rounded-lg p-0.5 border border-stone-200 flex-shrink-0">
          {[["all", "All"], ["favorites", "★"], ["viewed", "✓"], ["not_viewed", "New"]].map(([v, l]) => (
            <button key={v} onClick={() => setViewedFilter(v)}
              className={`px-3 py-2 text-xs font-medium rounded-md transition-colors ${viewedFilter === v ? "bg-white text-sky-600 shadow-sm" : "text-stone-500"}`}>{l}</button>
          ))}
        </div>
        <DropZone onImport={onImport} compact />
      </div>

      {/* Active school filter */}
      {schoolFilter && (
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 border border-violet-200 rounded-lg text-xs">
            <svg className="w-3.5 h-3.5 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.62 48.62 0 0112 20.904a48.62 48.62 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15v-3.75m0 0h-.008v.008H6.75V11.25z" /></svg>
            <span className="font-semibold text-violet-700">{schoolFilter}</span>
            <button onClick={() => setSchoolFilter(null)} className="ml-1 text-violet-400 hover:text-violet-600 transition-colors">✕</button>
          </div>
        </div>
      )}

      {/* Mobile sort pills */}
      <div className="md:hidden flex gap-1.5 mb-3 overflow-x-auto pb-0.5">
        {sortOptions.map((opt) => (
          <button key={opt.key} onClick={() => {
            if (opt.key === "distance") { requestLocation(); setSortKey("distance"); setSortAsc(true); }
            else toggleSort(opt.key);
          }}
            className={`${opt.icon ? "min-w-[44px] px-2.5" : "px-2.5"} py-1.5 text-xs font-medium rounded-lg border transition-colors flex-shrink-0 flex items-center justify-center gap-1 ${sortKey === opt.key ? "bg-sky-50 border-sky-200 text-sky-600" : "bg-white border-stone-200 text-stone-500"}`}>
            {opt.icon || opt.label} {sortKey === opt.key ? (opt.key === "distance" ? (locLoading ? "..." : "📍") : (sortAsc ? "↑" : "↓")) : ""}
          </button>
        ))}
      </div>

      {/* ─── Mobile: Cards ─────────────────────────────────────────── */}
      <div className="md:hidden space-y-2.5">
        {filtered.map((h) => {
          const hTax = h.taxRate || fin.propTax;
          const monthly = h.price ? quickMonthly(h.price, fin.cash, h.hoa || 0, fin.rate, fin.closing, hTax, h) : 0;
          const monthlyTax = h.price ? Math.round((h.price * hTax / 100) / 12) : 0;
          return (
            <div key={h.id} onClick={() => onOpenHome(h, filtered)}
              style={{ animationDelay: `${filtered.indexOf(h) * 40}ms` }}
              className={`anim-fade-up rounded-xl border shadow-sm active:scale-[0.99] transition-transform cursor-pointer card-hover ${!h.viewed ? "bg-white border-l-[3px] border-l-sky-400 border-t border-r border-b border-t-stone-200 border-r-stone-200 border-b-stone-200" : "bg-white border-stone-200"}`}>
              <div className="p-3.5">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-semibold text-stone-800 truncate text-[15px]">{h.address || "—"}</p>
                      <StatusBadge status={h.status} />
                    </div>
                    <p className="text-xs text-stone-400 mt-0.5">{[h.city, h.state, h.zip].filter(Boolean).join(", ")}</p>
                  </div>
                  <div className="flex items-start gap-1.5 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-lg font-bold text-stone-800 tabular-nums">{fmt(h.price)}</p>
                      {monthly > 0 && <p className="text-xs text-stone-500 font-medium tabular-nums">~{fmt(monthly)}/mo</p>}
                      {maxBudget && h.price > maxBudget.maxPrice && <p className="text-[10px] font-bold text-orange-500">Over budget</p>}
                      {maxBudget && h.price <= maxBudget.maxPrice && <p className="text-[10px] font-bold text-teal-500">In budget</p>}
                      {sortKey === "distance" && userLoc && h.lat && <p className="text-[11px] text-sky-500 font-medium tabular-nums">{distanceFor(h).toFixed(1)} mi</p>}
                      {sortKey === "value" && <p className={`text-[11px] font-bold tabular-nums ${valueScores[h.id] >= 70 ? "text-teal-600" : valueScores[h.id] >= 50 ? "text-amber-600" : "text-orange-500"}`}>{valueScores[h.id]} value</p>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setHomes((p) => p.map((x) => x.id === h.id ? { ...x, favorite: !x.favorite } : x)); }}
                      className={`mt-0.5 star-tap ${h.favorite ? "text-amber-400" : "text-stone-300"}`}>
                      <StarIcon filled={h.favorite} className="w-5 h-5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 mt-2">
                  <span className="font-medium">{h.beds ?? "—"} <span className="text-stone-400">bd</span></span>
                  <span className="font-medium">{h.baths ?? "—"} <span className="text-stone-400">ba</span></span>
                  <span className="font-medium">{fmtNum(h.sqft)} <span className="text-stone-400">sqft</span></span>
                  <span className="text-stone-400 tabular-nums">{fmt(h.ppsf)}/sf</span>
                  {monthlyTax > 0 && <span className="text-amber-600 font-semibold tabular-nums">{fmt(monthlyTax)}<span className="text-amber-500 font-normal">/mo tax</span></span>}
                  {h.pool === true && <span className="text-sky-500 font-semibold">Pool</span>}
                  <span className="flex-1" />
                  {avgRating(h.ratings) > 0 && <span className="text-amber-500 font-semibold tabular-nums">{avgRating(h.ratings).toFixed(1)} ★</span>}
                  {h.notes && <span className="w-2 h-2 rounded-full bg-amber-400" title="Has notes" />}
                  {h.viewed && <span className="text-teal-600 font-semibold bg-teal-50 px-1.5 py-0.5 rounded text-[10px]">Viewed</span>}
                </div>
                {(h.flood || h.crime || h.school) && (
                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-stone-100 flex-wrap">
                    {h.flood && (
                      <span className="flex items-center gap-1.5">
                        <FloodIcon risk={h.flood.risk} />
                        <span className={`text-[11px] font-medium ${h.flood.risk === "high" ? "text-orange-500" : h.flood.risk === "moderate" ? "text-amber-500" : "text-sky-500"}`}>
                          {h.flood.risk === "high" ? "High Flood Risk" : h.flood.risk === "moderate" ? "Mod. Flood Risk" : "Low Flood Risk"}
                        </span>
                      </span>
                    )}
                    {h.crime && (
                      <span className="flex items-center gap-1.5">
                        <CrimeIcon risk={h.crime.risk} />
                        <span className={`text-[11px] font-medium ${h.crime.risk === "high" ? "text-orange-500" : h.crime.risk === "moderate" ? "text-amber-500" : "text-sky-500"}`}>
                          {h.crime.risk === "high" ? "High Crime" : h.crime.risk === "moderate" ? "Mod. Crime" : "Low Crime"}
                        </span>
                      </span>
                    )}
                    {h.school && (
                      <span className="flex items-center gap-1.5">
                        <SchoolIcon tier={h.school.tier} />
                        <span className={`text-[11px] font-medium ${h.school.tier === "great" ? "text-sky-500" : h.school.tier === "good" ? "text-amber-500" : "text-orange-500"}`}>
                          {h.school.rating}/10
                        </span>
                      </span>
                    )}
                    {h.parks && h.parks.nearestDistanceMi != null && (
                      <span className="flex items-center gap-1">
                        <svg className={`w-3.5 h-3.5 ${h.parks.greenSpaceScore === "excellent" ? "text-emerald-500" : h.parks.greenSpaceScore === "good" ? "text-teal-500" : "text-amber-500"}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 2 6 5 6 8c0 2 1.5 3.5 3 4.5V22h6V12.5c1.5-1 3-2.5 3-4.5 0-3-2.5-6-6-6z"/></svg>
                        <span className={`text-[11px] font-medium ${h.parks.greenSpaceScore === "excellent" ? "text-emerald-500" : h.parks.greenSpaceScore === "good" ? "text-teal-500" : "text-amber-500"}`}>
                          {h.parks.nearestDistanceMi.toFixed(1)}mi
                        </span>
                      </span>
                    )}
                    {(() => {
                      const vs = valueScores[h.id];
                      return vs != null ? <span className={`text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded ${vs >= 70 ? "text-teal-700 bg-teal-50" : vs >= 50 ? "text-amber-700 bg-amber-50" : "text-orange-600 bg-orange-50"}`}>{vs} value</span> : null;
                    })()}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-center text-stone-400 py-16 text-sm">No listings match your filters</div>}
      </div>

      {/* ─── Desktop: Table ────────────────────────────────────────── */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-stone-200 shadow-sm bg-white">
        <table className="w-full text-sm min-w-[1400px]">
          <thead className="bg-stone-50/80 border-b border-stone-200">
            <tr>
              <th className="py-3 px-3 w-8"></th>
              <th className="py-3 px-3 w-8"></th>
              <SortHeader field="address">Address</SortHeader>
              <SortHeader field="city">City</SortHeader>
              <SortHeader field="price">Price</SortHeader>
              <SortHeader field="appraisalPct">Appr%</SortHeader>
              <th className="py-3 px-3 text-left text-xs font-semibold tracking-wider uppercase text-stone-400 whitespace-nowrap">Est. Mo.</th>
              <th className="py-3 px-3 text-left text-xs font-semibold tracking-wider uppercase text-stone-400 whitespace-nowrap">Tax/Mo</th>
              <SortHeader field="beds">Bd</SortHeader>
              <SortHeader field="baths">Ba</SortHeader>
              <SortHeader field="sqft">Sqft</SortHeader>
              <SortHeader field="ppsf">$/SF</SortHeader>
              <SortHeader field="yearBuilt">Year</SortHeader>
              <SortHeader field="dom">DOM</SortHeader>
              <th className="py-3 px-3 text-xs font-semibold tracking-wider uppercase text-stone-400">Flood</th>
              <th className="py-3 px-3 text-xs font-semibold tracking-wider uppercase text-stone-400">Crime</th>
              <th className="py-3 px-3 text-xs font-semibold tracking-wider uppercase text-stone-400">School</th>
              <SortHeader field="nearestPark">Parks</SortHeader>
              <SortHeader field="value"><span title="Composite score (0-100) based on price vs appraisal, $/sqft vs area median, school rating, flood risk, crime, and days on market. Higher = better value.">Value</span></SortHeader>
              <th className="py-3 px-3 text-xs font-semibold tracking-wider uppercase text-stone-400">Avg ★</th>
              <th className="py-3 px-3 w-8"></th>
              <th className="py-3 px-3 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {filtered.map((h) => {
              const isComp = compareList.includes(h.id);
              const hTax2 = h.taxRate || fin.propTax;
              const monthly = h.price ? quickMonthly(h.price, fin.cash, h.hoa || 0, fin.rate, fin.closing, hTax2, h) : 0;
              const monthlyTax = h.price ? Math.round((h.price * hTax2 / 100) / 12) : 0;
              return (
                <tr key={h.id} onClick={() => onOpenHome(h, filtered)} className="hover:bg-sky-50/30 cursor-pointer transition-colors duration-200 hover:shadow-sm">
                  <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setHomes((p) => p.map((x) => x.id === h.id ? { ...x, viewed: !x.viewed } : x))}
                      className={`w-5 h-5 rounded border flex items-center justify-center text-xs transition-colors check-pop ${h.viewed ? "bg-teal-500 border-teal-500 text-white" : "border-stone-300 text-transparent hover:border-stone-400"}`}>✓</button>
                  </td>
                  <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setHomes((p) => p.map((x) => x.id === h.id ? { ...x, favorite: !x.favorite } : x))}
                      className={`star-tap ${h.favorite ? "text-amber-400" : "text-stone-300 hover:text-amber-200"}`}>
                      <StarIcon filled={h.favorite} className="w-4 h-4" />
                    </button>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <span className="text-stone-800 font-medium truncate max-w-[220px]">{h.address || "—"}</span>
                      <StatusBadge status={h.status} />
                      {h.notes && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Has notes" />}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-stone-500">{h.city || "—"}</td>
                  <td className="py-2.5 px-3 text-stone-900 font-semibold tabular-nums">{fmt(h.price)} {maxBudget && <span className={`text-[9px] font-bold ml-1 px-1 py-0.5 rounded ${h.price > maxBudget.maxPrice ? "text-orange-600 bg-orange-50" : "text-teal-600 bg-teal-50"}`}>{h.price > maxBudget.maxPrice ? "OVER" : "OK"}</span>}</td>
                  <td className="py-2.5 px-3 tabular-nums text-xs font-semibold">
                    {h.appraisal && h.price ? (() => {
                      const pct = ((h.price - h.appraisal.value) / h.appraisal.value * 100);
                      return <span className={pct > 0 ? "text-orange-500" : pct < 0 ? "text-sky-600" : "text-stone-400"}>{pct > 0 ? "+" : ""}{pct.toFixed(0)}%</span>;
                    })() : <span className="text-stone-300">—</span>}
                  </td>
                  <td className="py-2.5 px-3 text-stone-600 tabular-nums font-medium">{monthly > 0 ? fmt(monthly) : "—"}</td>
                  <td className="py-2.5 px-3 text-amber-600 tabular-nums text-xs font-medium">{monthlyTax > 0 ? fmt(monthlyTax) : "—"}</td>
                  <td className="py-2.5 px-3 text-stone-600 text-center tabular-nums">{h.beds ?? "—"}</td>
                  <td className="py-2.5 px-3 text-stone-600 text-center tabular-nums">{h.baths ?? "—"}</td>
                  <td className="py-2.5 px-3 text-stone-600 tabular-nums">{fmtNum(h.sqft)}</td>
                  <td className="py-2.5 px-3 text-stone-500 tabular-nums text-xs">{fmt(h.ppsf)}</td>
                  <td className="py-2.5 px-3 text-stone-500 tabular-nums text-xs">{h.yearBuilt || "—"}</td>
                  <td className="py-2.5 px-3 text-stone-500 tabular-nums text-xs">{h.dom ?? "—"}</td>
                  <td className="py-2.5 px-3">
                    {h.flood ? (
                      <span title={`${h.flood.zone} — ${h.flood.zoneDesc || ""}`}>
                        <FloodIcon risk={h.flood.risk} />
                      </span>
                    ) : <span className="text-stone-300 text-xs">—</span>}
                  </td>
                  <td className="py-2.5 px-3">
                    {h.crime ? (
                      <span title={`Grade: ${h.crime.grade || "N/A"}`}>
                        <CrimeIcon risk={h.crime.risk} />
                      </span>
                    ) : <span className="text-stone-300 text-xs">—</span>}
                  </td>
                  <td className="py-2.5 px-3">
                    {h.school ? (
                      <span title={h.school.schoolName || ""}>
                        <SchoolIcon tier={h.school.tier} />
                      </span>
                    ) : <span className="text-stone-300 text-xs">—</span>}
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {h.parks ? (
                      <span title={`${h.parks.parkCount1Mi || 0} parks within 1 mi${h.parks.nearestParkName ? " · Nearest: " + h.parks.nearestParkName : ""}`} className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded ${h.parks.greenSpaceScore === "excellent" ? "text-emerald-600 bg-emerald-50" : h.parks.greenSpaceScore === "good" ? "text-teal-600 bg-teal-50" : "text-amber-600 bg-amber-50"}`}>
                        {h.parks.parkCount1Mi || 0}
                      </span>
                    ) : <span className="text-stone-300 text-xs">—</span>}
                  </td>
                  <td className="py-2.5 px-3">
                    {(() => {
                      const vs = valueScores[h.id];
                      const color = vs >= 70 ? "text-teal-600 bg-teal-50" : vs >= 50 ? "text-amber-600 bg-amber-50" : "text-orange-500 bg-orange-50";
                      return <span className={`text-xs font-bold tabular-nums px-1.5 py-0.5 rounded ${color}`}>{vs}</span>;
                    })()}
                  </td>
                  <td className="py-2.5 px-3">
                    {avgRating(h.ratings) > 0 ? (
                      <span className="text-amber-500 text-xs font-semibold tabular-nums">{avgRating(h.ratings).toFixed(1)} ★</span>
                    ) : <span className="text-stone-300 text-xs">—</span>}
                  </td>
                  <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => toggleCompare(h.id)} title="Compare"
                      className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${isComp ? "bg-violet-100 text-violet-600 ring-1 ring-violet-300" : "text-stone-300 hover:text-stone-500"}`}><CompareIcon className="w-3.5 h-3.5" /></button>
                  </td>
                  <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                    {h.url && <a href={h.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-600 transition-colors"><LinkIcon className="w-4 h-4" /></a>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center text-stone-400 py-16 text-sm">No listings match your filters</div>}
      </div>

      {homes.length > 0 && (
        <div className="flex justify-end mt-3">
          <button onClick={() => { if (window.confirm("Clear all listings and data?")) { setHomes([]); } }}
            className="text-xs text-stone-400 hover:text-orange-500 transition-colors">Clear all data</button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN: Home Detail
   ═══════════════════════════════════════════════════════════════════ */
function analyzeOffer(home, allHomes, soldComps = []) {
  if (!home.price) return null;

  // ── Score comparability ────────────────────────────────────────
  const isNew = home.yearBuilt >= 2020;
  const scoreComp = (h) => {
    let score = 0;
    if (h.zip === home.zip) score += 3;
    else if (home.lat && h.lat) {
      const d = haversine(home.lat, home.lng, h.lat, h.lng);
      if (d < 1) score += 2; else if (d < 3) score += 1;
    }
    if (h.sqft && home.sqft) {
      const ratio = h.sqft / home.sqft;
      if (ratio > 0.65 && ratio < 1.35) score += 2;
      else if (ratio > 0.5 && ratio < 1.5) score += 1;
    }
    if (h.beds && home.beds && Math.abs(h.beds - home.beds) <= 1) score += 1;
    const hNew = h.yearBuilt >= 2020;
    if (hNew === isNew) score += 2;
    else if (h.yearBuilt && home.yearBuilt && Math.abs(h.yearBuilt - home.yearBuilt) <= 10) score += 1;
    return score;
  };

  // ── Score sold comps (preferred) ───────────────────────────────
  const soldScored = soldComps
    .filter(h => h.price && h.sqft && h.ppsf)
    .map(h => ({ ...h, compScore: scoreComp(h), isSold: true }))
    .filter(h => h.compScore >= 3)
    .sort((a, b) => b.compScore - a.compScore)
    .slice(0, 10);

  // ── Score active listings (fallback) ───────────────────────────
  const activeScored = allHomes
    .filter(h => h.id !== home.id && h.price && h.sqft && h.ppsf)
    .map(h => ({ ...h, compScore: scoreComp(h), isSold: false }))
    .filter(h => h.compScore >= 3)
    .sort((a, b) => b.compScore - a.compScore)
    .slice(0, 10);

  // Prefer sold comps; fill with active if needed
  const comps = [...soldScored];
  const soldCount = soldScored.length;
  if (comps.length < 6) {
    for (const c of activeScored) {
      if (comps.length >= 10) break;
      if (!comps.find(x => x.address === c.address)) comps.push(c);
    }
  }
  if (comps.length < 2) return null;

  // ── Comp-implied value ─────────────────────────────────────────
  // Weight sold comps 2x when computing median $/sqft
  const weightedPpsf = [];
  comps.forEach(c => { weightedPpsf.push(c.ppsf); if (c.isSold) weightedPpsf.push(c.ppsf); });
  weightedPpsf.sort((a, b) => a - b);
  const medianPpsf = weightedPpsf[Math.floor(weightedPpsf.length / 2)];
  const compValue = Math.round(medianPpsf * home.sqft);

  // ── Appraisal anchor ───────────────────────────────────────────
  const apprValue = home.appraisal?.value || null;

  // ── DOM leverage (days on market) ──────────────────────────────
  const dom = home.dom || 0;
  let domFactor, domLabel;
  if (dom <= 7) { domFactor = 0.99; domLabel = "Just listed — minimal leverage"; }
  else if (dom <= 14) { domFactor = 0.98; domLabel = "Fresh — limited leverage"; }
  else if (dom <= 30) { domFactor = 0.965; domLabel = "Normal DOM — moderate leverage"; }
  else if (dom <= 60) { domFactor = 0.945; domLabel = "Extended DOM — good leverage"; }
  else if (dom <= 90) { domFactor = 0.92; domLabel = "Stale listing — strong leverage"; }
  else { domFactor = 0.89; domLabel = "Very stale — significant leverage"; }

  // ── Risk adjustments ───────────────────────────────────────────
  let riskDiscount = 0;
  const riskNotes = [];
  if (home.flood?.risk === "high") { riskDiscount += 0.03; riskNotes.push("High flood risk (AE zone) −3%"); }
  else if (home.flood?.risk === "moderate") { riskDiscount += 0.01; riskNotes.push("Moderate flood risk −1%"); }
  if (home.school?.tier === "below") { riskDiscount += 0.02; riskNotes.push("Below-avg school −2%"); }
  if (home.crime?.risk === "high") { riskDiscount += 0.02; riskNotes.push("High crime area −2%"); }

  // ── List vs appraisal gap ──────────────────────────────────────
  const apprGap = apprValue ? ((home.price - apprValue) / apprValue) : 0;
  let apprNote = "";
  if (apprGap > 0.2) apprNote = "Listed 20%+ above appraisal — strong negotiation basis";
  else if (apprGap > 0.1) apprNote = "Listed 10-20% above appraisal — room to negotiate";
  else if (apprGap > 0) apprNote = "Slight premium over appraisal — typical for market";
  else apprNote = "At or below appraisal — fairly priced";

  // ── Comp vs list gap ───────────────────────────────────────────
  const compGap = (home.price - compValue) / compValue;
  let compNote = "";
  if (compGap > 0.1) compNote = "Priced above comparable homes";
  else if (compGap > 0) compNote = "Slightly above comp median";
  else if (compGap > -0.05) compNote = "In line with comps";
  else compNote = "Below comp median — good value";

  // ── Blend signals into offer range ─────────────────────────────
  // Sold-comp-based value gets extra weight when available
  const anchors = [home.price];
  if (compValue) { anchors.push(compValue); if (soldCount >= 3) anchors.push(compValue); }
  if (apprValue) anchors.push(apprValue);
  const blendedValue = anchors.reduce((a, b) => a + b, 0) / anchors.length;

  const aggressive = Math.round(Math.min(...anchors) * (domFactor - 0.02) * (1 - riskDiscount));
  const competitive = Math.round(blendedValue * domFactor * (1 - riskDiscount * 0.5));
  const strong = Math.round(home.price * Math.max(domFactor, 0.96) * (1 - riskDiscount * 0.3));

  return {
    comps,
    compCount: comps.length,
    soldCount,
    medianPpsf,
    compValue,
    apprValue,
    dom,
    domFactor,
    domLabel,
    riskDiscount,
    riskNotes,
    apprGap,
    apprNote,
    compGap,
    compNote,
    aggressive: Math.min(aggressive, home.price),
    competitive: Math.min(competitive, home.price),
    strong: Math.min(strong, home.price),
  };
}

function HomeDetailScreen({ home, onBack, onUpdate, compareList, toggleCompare, fin, navList = [], onNavigate, allHomes = [], soldComps = [], onFilterBySchool, maxBudget }) {
  const swipeRef = useRef(null);
  const touchStart = useRef(null);
  const touchDelta = useRef(0);
  const isHorizontal = useRef(null);
  const [dragX, setDragX] = useState(0);
  const [slideClass, setSlideClass] = useState("slide-enter-fade");
  const [animating, setAnimating] = useState(false);

  const navIdx = navList.indexOf(home.id);
  const hasPrev = navIdx > 0;
  const hasNext = navIdx >= 0 && navIdx < navList.length - 1;
  const navLabel = navList.length > 1 ? `${navIdx + 1} / ${navList.length}` : null;

  const doNavigate = (dir) => {
    if (animating) return;
    setAnimating(true);
    setDragX(0);
    // Phase 1: exit current card
    setSlideClass(dir > 0 ? "slide-exit-left" : "slide-exit-right");
    setTimeout(() => {
      // Phase 2: load new home with entrance class
      setSlideClass(dir > 0 ? "slide-enter-right" : "slide-enter-left");
      onNavigate(dir);
      setTimeout(() => { setSlideClass(""); setAnimating(false); }, 300);
    }, 200);
  };

  useEffect(() => {
    const el = swipeRef.current;
    if (!el) return;
    const onTouchStart = (e) => {
      if (animating) return;
      touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      touchDelta.current = 0;
      isHorizontal.current = null;
    };
    const onTouchMove = (e) => {
      if (!touchStart.current) return;
      const dx = e.touches[0].clientX - touchStart.current.x;
      const dy = e.touches[0].clientY - touchStart.current.y;
      if (isHorizontal.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        isHorizontal.current = Math.abs(dx) > Math.abs(dy);
      }
      if (isHorizontal.current === false) { touchStart.current = null; setDragX(0); return; }
      if (isHorizontal.current) {
        const clamped = (dx < 0 && !hasNext) || (dx > 0 && !hasPrev) ? dx * 0.2 : dx;
        touchDelta.current = dx;
        setDragX(clamped);
      }
    };
    const onTouchEnd = () => {
      if (!touchStart.current) { setDragX(0); return; }
      const dx = touchDelta.current;
      const elapsed = Date.now() - touchStart.current.t;
      touchStart.current = null;
      if ((Math.abs(dx) > 60 || (Math.abs(dx) > 40 && elapsed < 250))) {
        if (dx < 0 && hasNext) { doNavigate(1); return; }
        if (dx > 0 && hasPrev) { doNavigate(-1); return; }
      }
      setDragX(0);
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [home.id, hasPrev, hasNext, animating]);
  const [notes, setNotes] = useState(home.notes || "");
  const [editingNotes, setEditingNotes] = useState(false);
  const [showFinancial, setShowFinancial] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const [voiceError, setVoiceError] = useState(null);
  const recognitionRef = useRef(null);
  const baseNotesRef = useRef("");

  const stopVoice = () => {
    try { recognitionRef.current?.stop(); } catch (e) {}
    recognitionRef.current = null;
    setIsListening(false);
  };

  const startVoice = async () => {
    setVoiceError(null);
    // Check browser support
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setVoiceError("Speech recognition not supported in this browser. Try Chrome or Safari."); return; }
    // Request mic permission explicitly
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setVoiceError("Microphone access denied. Please allow microphone permissions and try again.");
      return;
    }
    // Capture current notes as the base to append to
    baseNotesRef.current = notes;
    if (!editingNotes) setEditingNotes(true);

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (e) => {
      let final = "", interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      const base = baseNotesRef.current;
      const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
      setNotes(base + separator + final + interim);
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed") setVoiceError("Microphone access denied.");
      else if (e.error !== "aborted") setVoiceError("Voice error: " + e.error);
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch (err) { setVoiceError("Could not start voice recognition."); }
  };

  const toggleVoice = () => { isListening ? stopVoice() : startVoice(); };

  useEffect(() => { return () => stopVoice(); }, []);

  useEffect(() => { stopVoice(); setNotes(home.notes || ""); setEditingNotes(false); setShowFinancial(false); setVoiceError(null); setSchool(home.school || null); setFlood(home.flood || null); setCrime(home.crime || null); setAppraisal(home.appraisal || null); window.scrollTo(0, 0); }, [home.id]);

  // Appraisal value — fetch once per home, cache on the home object
  const [appraisal, setAppraisal] = useState(home.appraisal || null);
  const [appraisalLoading, setAppraisalLoading] = useState(false);

  useEffect(() => {
    if (home.appraisal) { setAppraisal(home.appraisal); return; }
    let cancelled = false;
    setAppraisalLoading(true);
    setAppraisal(null);
    fetchAppraisal(home.address, home.city, home.state).then((result) => {
      if (cancelled) return;
      setAppraisalLoading(false);
      if (result && result.appraisalValue) {
        const appraisalData = { value: result.appraisalValue, year: result.appraisalYear, source: result.source };
        setAppraisal(appraisalData);
        onUpdate(home.id, { appraisal: appraisalData });
      }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  // External data — sync from props (batch fetch) or fetch individually as fallback
  const [flood, setFlood] = useState(home.flood || null);
  const [floodLoading, setFloodLoading] = useState(false);
  const [crime, setCrime] = useState(home.crime || null);
  const [crimeLoading, setCrimeLoading] = useState(false);
  const [school, setSchool] = useState(home.school || null);
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [parks, setParks] = useState(home.parks || null);
  const [parksLoading, setParksLoading] = useState(false);
  const [groceries, setGroceries] = useState(home.groceries || null);
  const [groceriesLoading, setGroceriesLoading] = useState(false);

  // Sync from props when batch fetch updates the home object
  useEffect(() => { if (home.flood && !flood) setFlood(home.flood); }, [home.flood]);
  useEffect(() => { if (home.crime && !crime) setCrime(home.crime); }, [home.crime]);
  useEffect(() => { if (home.school && !school) setSchool(home.school); }, [home.school]);
  useEffect(() => { if (home.parks && !parks) setParks(home.parks); }, [home.parks]);
  useEffect(() => { if (home.groceries && !groceries) setGroceries(home.groceries); }, [home.groceries]);

  // Individual fetch fallback — only if prop and local state both null
  useEffect(() => {
    if (flood || home.flood) { if (home.flood) setFlood(home.flood); return; }
    let cancelled = false;
    setFloodLoading(true);
    fetchFloodZone(home.address, home.city, home.state, home.zip).then((result) => {
      if (cancelled) return;
      setFloodLoading(false);
      if (result?.zone) { setFlood(result); onUpdate(home.id, { flood: result }); }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  useEffect(() => {
    if (crime || home.crime) { if (home.crime) setCrime(home.crime); return; }
    let cancelled = false;
    setCrimeLoading(true);
    fetchCrime(home.address, home.city, home.state, home.zip).then((result) => {
      if (cancelled) return;
      setCrimeLoading(false);
      if (result?.risk) { setCrime(result); onUpdate(home.id, { crime: result }); }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  useEffect(() => {
    if (school || home.school) { if (home.school) setSchool(home.school); return; }
    let cancelled = false;
    setSchoolLoading(true);
    fetchSchool(home.address, home.city, home.state, home.zip).then((result) => {
      if (cancelled) return;
      setSchoolLoading(false);
      if (result?.schoolName) { setSchool(result); onUpdate(home.id, { school: result }); }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  useEffect(() => {
    if (parks || home.parks) { if (home.parks) setParks(home.parks); return; }
    let cancelled = false;
    setParksLoading(true);
    fetchNearbyParks(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((result) => {
      if (cancelled) return;
      setParksLoading(false);
      if (result?.parks) { setParks(result); onUpdate(home.id, { parks: result }); }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  useEffect(() => {
    if (groceries || home.groceries) { if (home.groceries) setGroceries(home.groceries); return; }
    if (!home.lat || !home.lng) return;
    let cancelled = false;
    setGroceriesLoading(true);
    fetchNearbyGroceries(home.lat, home.lng).then((result) => {
      if (cancelled) return;
      setGroceriesLoading(false);
      if (result) { setGroceries(result); onUpdate(home.id, { groceries: result }); }
    });
    return () => { cancelled = true; };
  }, [home.id]);

  const saveNotes = () => { onUpdate(home.id, { notes }); setEditingNotes(false); };
  const isComp = compareList.includes(home.id);
  const closingCosts = (home.price || 0) * (fin.closing / 100);
  const effectiveDown = Math.max(0, Math.min(fin.cash - closingCosts, home.price || 0));
  const homeTaxRate = home.taxRate || fin.propTax;
  const homeIns = estimateInsurance(home);
  const result = calcMortgage(home.price || 0, effectiveDown, fin.rate, fin.term, homeTaxRate, homeIns.totalAnnual, home.hoa || 0, fin.closing);
  const offer = useMemo(() => analyzeOffer(home, allHomes, soldComps), [home.id, allHomes, soldComps]);

  const projection = [];
  for (let y = 0; y <= fin.projYears; y++) {
    const val = (home.price || 0) * Math.pow(1 + fin.appreciation / 100, y);
    const bal = y === 0 ? result.loan : (result.schedule[y - 1]?.balance ?? 0);
    projection.push({ year: y, value: val, equity: val - bal });
  }
  const maxVal = Math.max(...projection.map((p) => p.value));

  return (
    <div ref={swipeRef} className={`min-h-screen pb-24 md:pb-6 overflow-x-hidden ${slideClass}`}
      style={dragX !== 0 ? {
        transform: `translateX(${dragX}px)`,
        opacity: Math.max(0.5, 1 - Math.abs(dragX) / 500),
        transition: 'none',
      } : !slideClass ? {
        transform: 'translateX(0)',
        opacity: 1,
        transition: 'transform 0.25s ease-out, opacity 0.25s ease-out',
      } : undefined}>
      {/* Header */}
      <div className="sticky top-0 md:top-16 z-30 bg-white/95 backdrop-blur-sm border-b border-stone-200 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3 max-w-5xl mx-auto">
          <button onClick={onBack} className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-stone-100 active:bg-stone-200 text-stone-500 -ml-2 transition-colors"><BackIcon className="w-5 h-5" /></button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-stone-800 truncate text-base md:text-lg">{home.address}</h1>
              {navLabel && <span className="text-[10px] text-stone-400 font-semibold bg-stone-100 px-1.5 py-0.5 rounded tabular-nums flex-shrink-0">{navLabel}</span>}
            </div>
            <p className="text-xs text-stone-400 truncate">{[home.city, home.state, home.zip].filter(Boolean).join(", ")}</p>
          </div>
          {navList.length > 1 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => doNavigate(-1)} disabled={!hasPrev}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${hasPrev ? "text-stone-500 hover:bg-stone-100 active:bg-stone-200" : "text-stone-200"}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button onClick={() => doNavigate(1)} disabled={!hasNext}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${hasNext ? "text-stone-500 hover:bg-stone-100 active:bg-stone-200" : "text-stone-200"}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => onUpdate(home.id, { favorite: !home.favorite })}
              className={`w-10 h-10 flex items-center justify-center rounded-xl border transition-colors star-tap ${home.favorite ? "bg-amber-50 border-amber-200 text-amber-400" : "bg-stone-50 border-stone-200 text-stone-300 hover:text-amber-300"}`}>
              <StarIcon filled={home.favorite} className="w-5 h-5" />
            </button>
            <StatusBadge status={home.status} />
            {home.url && (
              <a href={home.url} target="_blank" rel="noreferrer"
                className="w-10 h-10 flex items-center justify-center rounded-xl bg-sky-50 border border-sky-200 text-sky-600 hover:bg-sky-100 active:bg-sky-200 transition-colors">
                <LinkIcon className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-5 space-y-4">
        {/* ── Price Hero ─────────────────────────────────────────── */}
        <div className="anim-scale-in bg-gradient-to-br from-sky-50 via-blue-50 to-indigo-50 border border-sky-200/80 rounded-2xl p-5">
          <div className="flex items-baseline gap-3 flex-wrap min-w-0">
            <div className="text-3xl md:text-4xl font-bold text-stone-800 tracking-tight tabular-nums">{fmt(home.price)}</div>
            {appraisal && home.price && appraisal.value && (() => {
              const diff = home.price - appraisal.value;
              const pct = ((diff / appraisal.value) * 100).toFixed(0);
              return diff > 0
                ? <span className="text-xs font-bold text-orange-500 bg-orange-50 px-1.5 py-0.5 rounded tabular-nums">+{pct}% appr.</span>
                : diff < 0
                ? <span className="text-xs font-bold text-sky-600 bg-sky-50 px-1.5 py-0.5 rounded tabular-nums">{pct}% appr.</span>
                : <span className="text-xs text-stone-400 bg-stone-50 px-1.5 py-0.5 rounded">= appr.</span>;
            })()}
            {appraisalLoading && <span className="text-xs text-stone-400 animate-pulse">...</span>}
            {(() => { const vs = calcValueScore(home, allHomes); const color = vs >= 70 ? "text-teal-600 bg-teal-50" : vs >= 50 ? "text-amber-600 bg-amber-50" : "text-orange-500 bg-orange-50"; return <span className={`text-xs font-bold px-1.5 py-0.5 rounded tabular-nums ${color}`} title="Composite value score (0-100) based on price vs appraisal, $/sqft, school, flood, crime, and DOM">{vs} value</span>; })()}
            {maxBudget && <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${home.price > maxBudget.maxPrice ? "text-orange-600 bg-orange-50" : "text-teal-600 bg-teal-50"}`}>{home.price > maxBudget.maxPrice ? "Over budget" : "In budget"}</span>}
            {home.ppsf && <div className="text-base font-semibold text-sky-600 tabular-nums">{fmt(home.ppsf)}<span className="text-sm font-normal text-sky-500">/sqft</span></div>}
          </div>
          {offer && (
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-sm font-bold text-violet-600 tabular-nums">{fmtC(offer.competitive)}</span>
              <span className="text-[10px] font-semibold text-violet-500 tabular-nums">{((offer.competitive / home.price - 1) * 100).toFixed(1)}%</span>
              <span className="text-[10px] text-violet-400">suggested offer</span>
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-sm text-stone-600">
            {home.beds != null && <span><strong className="text-stone-800">{home.beds}</strong> beds</span>}
            {home.baths != null && <span><strong className="text-stone-800">{home.baths}</strong> baths</span>}
            {home.sqft && <span><strong className="text-stone-800">{fmtNum(home.sqft)}</strong> sqft</span>}
            {home.lotSize && <span><strong className="text-stone-800">{fmtNum(home.lotSize)}</strong> lot</span>}
            {home.pool === true && <span className="text-sky-600 font-semibold">Pool ✓</span>}
            {home.pool === false && <span className="text-stone-400">No Pool</span>}
          </div>
          {(flood || crime || school || floodLoading || crimeLoading || schoolLoading) && (
            <div className="flex items-center gap-4 mt-2.5 pt-2.5 border-t border-sky-200/50">
              {flood && (
                <span className="flex items-center gap-1.5">
                  <FloodIcon risk={flood.risk} />
                  <span className={`text-sm font-medium ${flood.risk === "high" ? "text-orange-500" : flood.risk === "moderate" ? "text-amber-500" : "text-sky-600"}`}>
                    {flood.risk === "high" ? "High Flood Risk" : flood.risk === "moderate" ? "Mod. Flood Risk" : "Low Flood Risk"}
                  </span>
                </span>
              )}
              {floodLoading && <span className="text-stone-400 animate-pulse text-xs">Flood...</span>}
              {crime && (
                <span className="flex items-center gap-1.5">
                  <CrimeIcon risk={crime.risk} />
                  <span className={`text-sm font-medium ${crime.risk === "high" ? "text-orange-500" : crime.risk === "moderate" ? "text-amber-500" : "text-sky-600"}`}>
                    {crime.risk === "high" ? "High Crime" : crime.risk === "moderate" ? "Mod. Crime" : "Low Crime"}
                  </span>
                </span>
              )}
              {crimeLoading && <span className="text-stone-400 animate-pulse text-xs">Crime...</span>}
              {school && (
                <span className="flex items-center gap-1.5">
                  <SchoolIcon tier={school.tier} />
                  <span className={`text-sm font-medium ${school.tier === "great" ? "text-sky-600" : school.tier === "good" ? "text-amber-500" : "text-orange-500"}`}>
                    {school.rating}/10
                  </span>
                </span>
              )}
              {schoolLoading && <span className="text-stone-400 animate-pulse text-xs">School...</span>}
            </div>
          )}
          {/* Monthly cost breakdown */}
          <div className="mt-3 pt-3 border-t border-sky-200/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-stone-500 uppercase tracking-wider font-semibold">Mortgage P&I</span>
              <span className="text-base font-bold text-stone-700 tabular-nums">{fmt(result.monthlyPI)}<span className="text-xs text-stone-500 font-normal ml-1">@ {fin.rate}%</span></span>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-amber-600 uppercase tracking-wider font-semibold">Property Tax</span>
                <span className="text-base font-bold text-amber-600 tabular-nums">{fmt(result.monthlyTax)}<span className="text-xs text-amber-500 font-normal ml-1">@ {homeTaxRate}%</span></span>
              </div>
              {home.taxJurisdictions && (
                <details className="mt-1.5">
                  <summary className="text-[10px] text-amber-500 cursor-pointer hover:text-amber-600 font-medium">View tax breakdown</summary>
                  <div className="mt-1.5 bg-amber-50/50 rounded-lg p-2.5 space-y-1">
                    {home.taxJurisdictions.map((j, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-[10px] text-stone-500">{j.entity}</span>
                        <span className="text-[10px] text-stone-600 font-semibold tabular-nums">{j.rate.toFixed(4)}%</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between pt-1 border-t border-amber-200/60">
                      <span className="text-[10px] text-amber-700 font-bold">Total Rate</span>
                      <span className="text-[10px] text-amber-700 font-bold tabular-nums">{homeTaxRate}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-amber-600 font-semibold">Annual Tax</span>
                      <span className="text-[10px] text-amber-600 font-bold tabular-nums">{fmt(Math.round(result.monthlyTax * 12))}/yr</span>
                    </div>
                  </div>
                </details>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-400 uppercase tracking-wider font-semibold">Insurance</span>
                <span className="text-sm font-semibold text-stone-500 tabular-nums">{fmt(result.monthlyIns)}</span>
              </div>
              <details className="mt-1">
                <summary className="text-[10px] text-teal-500 cursor-pointer hover:text-teal-600 font-medium">View insurance breakdown</summary>
                <div className="mt-1.5 bg-teal-50/50 rounded-lg p-2.5 space-y-1">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-stone-500">Homeowners</span>
                    <span className="text-stone-600 font-semibold tabular-nums">{fmt(Math.round(homeIns.homeownersAnnual / 12))}/mo ({fmt(homeIns.homeownersAnnual)}/yr)</span>
                  </div>
                  {homeIns.floodAnnual > 0 && (
                    <div className="flex justify-between text-[10px]">
                      <span className="text-stone-500">Flood</span>
                      <span className="text-orange-600 font-semibold tabular-nums">{fmt(Math.round(homeIns.floodAnnual / 12))}/mo ({fmt(homeIns.floodAnnual)}/yr)</span>
                    </div>
                  )}
                  <div className="border-t border-teal-200/50 pt-1 mt-1">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-teal-600 font-semibold">Total Annual</span>
                      <span className="text-teal-600 font-bold tabular-nums">{fmt(homeIns.totalAnnual)}/yr</span>
                    </div>
                  </div>
                  <div className="text-[9px] text-stone-400 mt-1 space-y-0.5">
                    <p>Rebuild: {fmtNum(home.sqft)} sf × ${homeIns.rebuildPerSqft}/sf = {fmt(homeIns.dwellingCoverage)} dwelling coverage</p>
                    <p>Rate: ${homeIns.ratePerHundred.toFixed(2)} per $100 ({home.yearBuilt >= 2020 ? "new build discount" : home.yearBuilt <= 1985 ? "age surcharge" : "standard"})</p>
                    <p>{homeIns.floodNote}</p>
                  </div>
                </div>
              </details>
            </div>
            {home.hoa > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-stone-400 uppercase tracking-wider font-semibold">HOA</span>
                <span className="text-sm font-semibold text-stone-500 tabular-nums">{fmt(home.hoa)}</span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t border-sky-200/50">
              <span className="text-xs text-sky-700 uppercase tracking-wider font-bold">Total Monthly</span>
              <span className="text-xl font-bold text-sky-700 tabular-nums">{fmt(result.totalMonthly)}<span className="text-xs text-sky-500 font-normal ml-1">/mo</span></span>
            </div>
          </div>
        </div>

        {/* ── Actions ─────────────────────────────────────────────── */}
        <div className="flex gap-2.5 anim-fade-up" style={{ animationDelay: '80ms' }}>
          <button onClick={() => onUpdate(home.id, { viewed: !home.viewed })}
            className={`flex-1 py-3.5 rounded-xl font-medium text-sm border transition-[transform,background-color,border-color] active:scale-[0.96] ${home.viewed ? "bg-teal-500 border-teal-500 text-white shadow-sm shadow-teal-200" : "bg-white border-stone-200 text-stone-600 hover:border-stone-300"}`}>
            {home.viewed ? "✓ Viewed" : "Mark as Viewed"}
          </button>
          <button onClick={() => toggleCompare(home.id)}
            className={`flex-1 py-3.5 rounded-xl font-medium text-sm border transition-[transform,background-color,border-color] active:scale-[0.96] flex items-center justify-center gap-1.5 ${isComp ? "bg-violet-500 border-violet-500 text-white shadow-sm shadow-violet-200" : "bg-white border-stone-200 text-stone-600 hover:border-stone-300"}`}>
            <CompareIcon className="w-4 h-4" /> {isComp ? "Comparing" : "Compare"}
          </button>
        </div>

        {/* ── Notes (first — primary field action) ────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '120ms' }}>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-stone-700">Viewing Notes</h3>
            <div className="flex items-center gap-1 -mr-1">
              <button onClick={toggleVoice}
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${isListening ? "bg-red-100 text-red-500" : "text-stone-400 hover:bg-stone-100 hover:text-stone-600"}`}
                title={isListening ? "Stop recording" : "Voice input"}>
                <MicOffIcon className={`w-4 h-4 ${isListening ? "animate-pulse" : ""}`} />
              </button>
              {!editingNotes && <button onClick={() => setEditingNotes(true)} className="text-sm text-sky-600 font-medium px-2 py-1 rounded-lg hover:bg-sky-50">{home.notes ? "Edit" : "+ Add"}</button>}
            </div>
          </div>
          {voiceError && (
            <div className="flex items-center gap-2 mb-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <span className="text-xs text-amber-700">{voiceError}</span>
              <button onClick={() => setVoiceError(null)} className="text-amber-400 hover:text-amber-600 ml-auto text-xs">✕</button>
            </div>
          )}
          {isListening && (
            <div className="flex items-center gap-2 mb-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs text-red-600 font-medium">Listening... speak your notes</span>
              <span className="flex-1" />
              <button onClick={stopVoice} className="text-xs text-red-500 font-semibold hover:text-red-700">Stop</button>
            </div>
          )}
          {editingNotes ? (
            <div>
              <textarea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} rows={5}
                placeholder="Kitchen feel? Natural light? Yard? Neighborhood noise? Anything you'll want to remember..."
                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-sm text-stone-700 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 resize-none leading-relaxed" />
              <div className="flex gap-2 justify-end mt-2.5">
                <button onClick={() => { stopVoice(); setNotes(home.notes || ""); setEditingNotes(false); }} className="px-4 py-2 text-sm text-stone-500 rounded-lg hover:bg-stone-100 transition-colors">Cancel</button>
                <button onClick={() => { stopVoice(); saveNotes(); }} className="px-5 py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 active:bg-sky-700 rounded-lg shadow-sm transition-colors">Save</button>
              </div>
            </div>
          ) : (
            <div onClick={() => setEditingNotes(true)}
              className={`rounded-xl px-4 py-3 min-h-[72px] cursor-text transition-colors ${home.notes ? "bg-white hover:bg-stone-50" : "bg-stone-50 border border-dashed border-stone-200 hover:border-stone-300 flex items-center justify-center"}`}>
              {home.notes ? <p className="text-sm text-stone-600 whitespace-pre-wrap leading-relaxed">{home.notes}</p> : <p className="text-sm text-stone-400">Tap to add viewing notes...</p>}
            </div>
          )}
        </div>

        {/* ── Ratings + Pool ──────────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '160ms' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-stone-700">Room Ratings</h3>
            {avgRating(home.ratings) > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-amber-500 tabular-nums">{avgRating(home.ratings).toFixed(1)}</span>
                <StarIcon filled className="w-4 h-4 text-amber-400" />
              </div>
            )}
          </div>
          <div className="space-y-2.5">
            {RATING_CATS.map((cat) => {
              const key = ratingKey(cat);
              const val = home.ratings?.[key] || 0;
              return (
                <div key={cat} className="flex items-center justify-between">
                  <span className="text-sm text-stone-500 w-28">{cat}</span>
                  <StarRating value={val} onChange={(r) => onUpdate(home.id, { ratings: { ...home.ratings, [key]: r } })} size="w-8 h-8" />
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between pt-3 mt-3 border-t border-stone-100">
            <span className="text-sm font-medium text-stone-600">Pool</span>
            <div className="flex gap-1 bg-stone-100 rounded-lg p-0.5">
              {[
                { val: null, label: "Unknown" },
                { val: true, label: "Yes" },
                { val: false, label: "No" },
              ].map((opt) => (
                <button key={String(opt.val)} onClick={() => onUpdate(home.id, { pool: opt.val })}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${home.pool === opt.val ? (opt.val === true ? "bg-sky-500 text-white shadow-sm" : opt.val === false ? "bg-stone-500 text-white shadow-sm" : "bg-white text-stone-600 shadow-sm") : "text-stone-400 hover:text-stone-600"}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Property Details ────────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '200ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Property Details</h3>
          <div className="grid grid-cols-2 gap-x-4 md:gap-x-6 gap-y-0.5">
            {[
              ["Year Built", home.yearBuilt || "—"],
              ["Type", home.propertyType || "—"],
              ["Status", home.status || "—"],
              ["Days on Market", home.dom ?? "—"],
              ["HOA/Month", home.hoa ? fmt(home.hoa) : "None"],
              ["Lot Size", home.lotSize ? fmtNum(home.lotSize) + " sf" : "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between py-2 border-b border-stone-100">
                <span className="text-sm text-stone-400">{label}</span>
                <span className="text-sm font-medium text-stone-700">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Elementary School ────────────────────────────────────── */}
        <div className={`border rounded-2xl overflow-hidden anim-fade-up ${school?.tier === "great" ? "bg-sky-50/50 border-sky-200" : school?.tier === "below" ? "bg-orange-50/50 border-orange-200" : school?.tier === "good" ? "bg-amber-50/50 border-amber-200" : "bg-white border-stone-200"}`} style={{ animationDelay: '235ms' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <SchoolIcon tier={school?.tier || "good"} />
                <h3 className="text-sm font-semibold text-stone-700">Elementary School</h3>
              </div>
              {school && school.rating && (
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold ${school.tier === "great" ? "text-sky-600" : school.tier === "good" ? "text-amber-600" : "text-orange-600"}`}>{school.rating}/10</span>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${school.tier === "great" ? "bg-sky-100 text-sky-600" : school.tier === "good" ? "bg-amber-100 text-amber-600" : "bg-orange-100 text-orange-600"}`}>
                    {school.tier === "great" ? "Great" : school.tier === "good" ? "Good" : "Below Avg"}
                  </span>
                </div>
              )}
            </div>

            {schoolLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Looking up school zoning...</div>}

            {school && (
              <div className="space-y-3">
                {/* School name + district */}
                <div className={`rounded-xl p-3.5 ${school.tier === "great" ? "bg-sky-100/70 border border-sky-200/50" : school.tier === "good" ? "bg-amber-100/50 border border-amber-200/50" : "bg-orange-100/60 border border-orange-200/50"}`}>
                  <button onClick={() => onFilterBySchool && onFilterBySchool(school.schoolName)}
                    className={`text-lg font-bold text-left hover:underline decoration-2 underline-offset-2 transition-colors ${school.tier === "great" ? "text-sky-700 decoration-sky-400" : school.tier === "good" ? "text-amber-700 decoration-amber-400" : "text-orange-700 decoration-orange-400"}`}>
                    {school.schoolName}
                    <svg className="w-3.5 h-3.5 inline ml-1.5 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
                  </button>
                  <div className="text-sm text-stone-500 mt-0.5">{school.district}{school.grades ? ` · ${school.grades}` : ""}</div>
                </div>

                {/* Stats grid */}
                {(() => {
                  const tint = school.tier === "great" ? "bg-sky-100/40" : school.tier === "good" ? "bg-amber-100/30" : "bg-orange-100/40";
                  const accent = school.tier === "great" ? "text-sky-600" : school.tier === "good" ? "text-amber-600" : "text-orange-600";
                  const Tip = ({ label, tip, children }) => (
                    <div className={`${tint} rounded-xl p-2.5 text-center flex-1 min-w-[70px] group relative`}>
                      <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold flex items-center justify-center gap-0.5 cursor-help" title={tip}>
                        {label}
                        <svg className="w-2.5 h-2.5 text-stone-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
                      </div>
                      {children}
                    </div>
                  );
                  return (
                    <div className="flex flex-wrap gap-2">
                      {school.rating != null && (
                        <Tip label="Rating" tip="GreatSchools overall rating from 1-10 based on test scores, student progress, and equity. 8+ is great, 5-7 is average, below 5 is below average.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.rating}<span className="text-xs text-stone-400 font-normal">/10</span></div>
                          <div className="text-[10px] text-stone-400">{school.ratingSource || "GreatSchools"}</div>
                        </Tip>
                      )}
                      {school.nicheGrade && (
                        <Tip label="Niche" tip="Niche.com composite grade (A+ to F) based on academics, teachers, diversity, resources, and parent/student reviews. A well-rounded school report card.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.nicheGrade}</div>
                          <div className="text-[10px] text-stone-400">Grade</div>
                        </Tip>
                      )}
                      {school.testScores != null && (
                        <Tip label="Test Scores" tip="Percentage of students scoring at or above grade-level proficiency on Texas STAAR standardized tests in math and reading combined.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.testScores}<span className="text-xs text-stone-400 font-normal">%</span></div>
                          <div className="text-[10px] text-stone-400">Proficient</div>
                        </Tip>
                      )}
                      {school.studentTeacherRatio != null && (
                        <Tip label="Class Size" tip="Student-to-teacher ratio. Lower is generally better — more individual attention per student. Texas average is about 15:1.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.studentTeacherRatio}<span className="text-xs text-stone-400 font-normal">:1</span></div>
                          <div className="text-[10px] text-stone-400">Stu/Teacher</div>
                        </Tip>
                      )}
                      {school.enrollment && (
                        <Tip label="Students" tip="Total student enrollment. Smaller schools (under 500) often offer more community feel; larger schools may have more programs and resources.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{fmtNum(school.enrollment)}</div>
                          <div className="text-[10px] text-stone-400">Enrolled</div>
                        </Tip>
                      )}
                      {school.distance && (
                        <Tip label="Distance" tip="Approximate distance from the home to the zoned elementary school.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.distance.replace(" mi", "")}<span className="text-xs text-stone-400 font-normal"> mi</span></div>
                          <div className="text-[10px] text-stone-400">To School</div>
                        </Tip>
                      )}
                    </div>
                  );
                })()}

                {/* Explanation */}
                <div className="text-sm text-stone-600 leading-relaxed space-y-2">
                  {school.tier === "great" && (
                    <p>This home is zoned to a <strong className="text-sky-600">top-rated elementary school</strong> (8+/10). Homes in highly-rated school zones typically command a premium and hold value well. Strong school zoning is one of the most reliable long-term value drivers.</p>
                  )}
                  {school.tier === "good" && (
                    <p>This home is zoned to a <strong className="text-amber-600">solid elementary school</strong> rated 5-7/10. Average to above-average academics. Check for magnet programs, recent improvements, and parent reviews for a fuller picture.</p>
                  )}
                  {school.tier === "below" && (
                    <p>This home is zoned to an elementary school <strong className="text-orange-600">rated below average</strong> (under 5/10). Consider investigating charter school options, magnet transfers, or private school costs ($10K-$25K+/year) when budgeting for this home.</p>
                  )}
                </div>

                {/* Notes */}
                {school.notes && (
                  <div className={`rounded-xl px-3.5 py-2.5 text-sm ${school.tier === "great" ? "bg-sky-100/50 text-sky-700" : school.tier === "good" ? "bg-amber-100/40 text-amber-700" : "bg-orange-100/50 text-orange-700"}`}>
                    <strong className="text-xs uppercase tracking-wider">Note:</strong> {school.notes}
                  </div>
                )}

                {/* Source */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-stone-400">{school.ratingSource || "School Data"} · {school.district}</span>
                  <button onClick={() => {
                    setSchoolLoading(true);
                    setSchool(null);
                    fetchSchool(home.address, home.city, home.state, home.zip).then((r) => {
                      setSchoolLoading(false);
                      if (r && r.schoolName) { setSchool(r); onUpdate(home.id, { school: r }); }
                    });
                  }} className="text-xs text-sky-600 font-medium hover:text-sky-700">Refresh</button>
                </div>
              </div>
            )}

            {!schoolLoading && !school && (
              <div className="bg-stone-50 border border-dashed border-stone-200 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-stone-400">No school data available</span>
                <button onClick={() => {
                  setSchoolLoading(true);
                  fetchSchool(home.address, home.city, home.state, home.zip).then((r) => {
                    setSchoolLoading(false);
                    if (r && r.schoolName) { setSchool(r); onUpdate(home.id, { school: r }); }
                  });
                }} className="text-sm text-sky-600 font-medium hover:text-sky-700">Fetch school data →</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Parks & Green Space ──────────────────────────────── */}
        <div className={`border rounded-2xl overflow-hidden anim-fade-up ${parks?.greenSpaceScore === "excellent" ? "bg-emerald-50/50 border-emerald-200" : parks?.greenSpaceScore === "good" ? "bg-teal-50/50 border-teal-200" : "bg-white border-stone-200"}`} style={{ animationDelay: '260ms' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className={`w-5 h-5 ${parks?.greenSpaceScore === "excellent" ? "text-emerald-500" : parks?.greenSpaceScore === "good" ? "text-teal-500" : parks?.greenSpaceScore === "fair" ? "text-amber-500" : "text-stone-400"}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 2 6 5 6 8c0 2 1.5 3.5 3 4.5V22h6V12.5c1.5-1 3-2.5 3-4.5 0-3-2.5-6-6-6zm-2 14H8v-1h2v1zm0-2.5H8v-1h2v1zm4 2.5h-2v-1h2v1zm0-2.5h-2v-1h2v1z"/></svg>
                <h3 className="text-sm font-semibold text-stone-700">Parks & Green Space</h3>
              </div>
              {parks && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${parks.greenSpaceScore === "excellent" ? "bg-emerald-100 text-emerald-600" : parks.greenSpaceScore === "good" ? "bg-teal-100 text-teal-600" : parks.greenSpaceScore === "fair" ? "bg-amber-100 text-amber-600" : "bg-stone-100 text-stone-500"}`}>
                  {parks.greenSpaceScore === "excellent" ? "Excellent" : parks.greenSpaceScore === "good" ? "Good" : parks.greenSpaceScore === "fair" ? "Fair" : "Limited"}
                </span>
              )}
            </div>

            {parksLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Finding nearby parks...</div>}

            {parks && (() => {
              const parkList = parks.parks?.slice(0, 4) || [];
              const emptySlots = Math.max(0, 4 - parkList.length);
              const getEmoji = (p) => p.type === "Trail" || p.type === "Linear Park" ? "🥾" : p.type === "Nature Preserve" ? "🌿" : p.amenities?.includes("Playground") ? "🛝" : "🌳";
              const getBg = (i) => ["bg-emerald-50", "bg-teal-50", "bg-sky-50", "bg-amber-50"][i] || "bg-teal-50";
              const getColor = (i) => ["text-emerald-600", "text-teal-600", "text-sky-600", "text-amber-600"][i] || "text-teal-600";
              return (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    {parkList.map((park, i) => (
                      <div key={i} className={`rounded-xl p-3 border border-stone-100 ${getBg(i)}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-base">{getEmoji(park)}</span>
                          <span className={`text-xs font-bold truncate ${getColor(i)}`}>{park.name}</span>
                        </div>
                        <div className={`text-lg font-bold tabular-nums ${getColor(i)}`}>{park.distanceMi != null ? park.distanceMi.toFixed(1) : (park.distance || "—").replace(" mi", "")}<span className="text-xs text-stone-400 font-normal"> mi</span></div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-stone-500">{park.type}{park.acres ? ` · ${park.acres} ac` : ""}</span>
                        </div>
                        {park.amenities?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {park.amenities.slice(0, 3).map((a, j) => (
                              <span key={j} className="text-[10px] bg-white/60 text-stone-500 px-1.5 py-0.5 rounded-full">{a}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {Array.from({ length: emptySlots }, (_, i) => (
                      <div key={`empty-${i}`} className="rounded-xl p-3 border border-stone-100 bg-stone-50/50">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-base opacity-30">🌳</span>
                          <span className="text-xs font-bold text-stone-400">—</span>
                        </div>
                        <div className="text-xs text-stone-400 mt-1">No park found</div>
                      </div>
                    ))}
                  </div>
                  {/* Summary line */}
                  <div className="flex items-center justify-between text-xs text-stone-500">
                    <span>{parks.parkCount1Mi || 0} green space{(parks.parkCount1Mi || 0) !== 1 ? "s" : ""} within 1 mi{parks.hasTrail ? " · Trail access" : ""}{parks.hasPlayground ? " · Playground" : ""}</span>
                  </div>
                </div>
              );
            })()}

            {!parks && !parksLoading && (
              <div className="flex items-center gap-3 py-4">
                <span className="text-sm text-stone-400">No parks data available</span>
                <button onClick={() => {
                  setParksLoading(true);
                  fetchNearbyParks(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
                    setParksLoading(false);
                    if (r && r.parks) { setParks(r); onUpdate(home.id, { parks: r }); }
                  });
                }} className="text-sm text-teal-600 font-medium hover:text-teal-700">Find parks nearby →</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Groceries ───────────────────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '275ms' }}>
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
              <h3 className="text-sm font-semibold text-stone-700">Nearest Groceries</h3>
            </div>

            {groceriesLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Finding grocery stores...</div>}

            {groceries && (() => {
              const stores = [
                { key: "heb", label: "H-E-B", emoji: "🛒", color: "text-red-600", bg: "bg-red-50" },
                { key: "costco", label: "Costco", emoji: "🏪", color: "text-blue-600", bg: "bg-blue-50" },
                { key: "wholefoods", label: "Whole Foods", emoji: "🥬", color: "text-green-700", bg: "bg-green-50" },
                { key: "traderjoes", label: "Trader Joe's", emoji: "🍊", color: "text-orange-600", bg: "bg-orange-50" },
              ];
              return (
                <div className="grid grid-cols-2 gap-2">
                  {stores.map((s) => {
                    const store = groceries[s.key];
                    return (
                      <div key={s.key} className={`rounded-xl p-3 border ${store ? s.bg + " border-stone-100" : "bg-stone-50/50 border-stone-100"}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-base">{s.emoji}</span>
                          <span className={`text-xs font-bold ${store ? s.color : "text-stone-400"}`}>{s.label}</span>
                        </div>
                        {store ? (
                          <div>
                            <div className={`text-lg font-bold tabular-nums ${s.color}`}>{store.distanceMi}<span className="text-xs text-stone-400 font-normal"> mi</span></div>
                            {store.address && <div className="text-[10px] text-stone-400 truncate mt-0.5">{store.address}</div>}
                          </div>
                        ) : (
                          <div className="text-xs text-stone-400 mt-1">None within 10 mi</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {!groceries && !groceriesLoading && (
              <div className="flex items-center gap-3 py-4">
                <span className="text-sm text-stone-400">No grocery data</span>
                <button onClick={() => {
                  if (!home.lat || !home.lng) return;
                  setGroceriesLoading(true);
                  fetchNearbyGroceries(home.lat, home.lng).then((r) => {
                    setGroceriesLoading(false);
                    if (r) { setGroceries(r); onUpdate(home.id, { groceries: r }); }
                  });
                }} className="text-sm text-orange-600 font-medium hover:text-orange-700">Find groceries →</button>
              </div>
            )}
          </div>
        </div>

                {/* ── Commute ────────────────────────────────────────────── */}
        {fin.places?.length > 0 && home.lat && home.lng && (
          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '225ms' }}>
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-sky-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg>
                <h3 className="text-sm font-semibold text-stone-700">Commute</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {fin.places.map((place, i) => {
                  const c = estimateCommute(home.lat, home.lng, place.lat, place.lng);
                  if (!c) return null;
                  const color = c.minutes <= 20 ? "sky" : c.minutes <= 35 ? "amber" : "orange";
                  return (
                    <div key={i} className={`rounded-xl border p-3.5 ${color === "sky" ? "bg-sky-50/50 border-sky-200" : color === "amber" ? "bg-amber-50/50 border-amber-200" : "bg-orange-50/50 border-orange-200"}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {place.icon === "briefcase" ? (
                          <svg className={`w-4 h-4 ${color === "sky" ? "text-sky-500" : color === "amber" ? "text-amber-500" : "text-orange-500"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7H4a1 1 0 00-1 1v10a1 1 0 001 1h16a1 1 0 001-1V8a1 1 0 00-1-1zM16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" /></svg>
                        ) : (
                          <svg className={`w-4 h-4 ${color === "sky" ? "text-sky-500" : color === "amber" ? "text-amber-500" : "text-orange-500"}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        )}
                        <span className="text-xs font-semibold text-stone-600">{place.label}</span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className={`text-2xl font-bold tabular-nums ${color === "sky" ? "text-sky-600" : color === "amber" ? "text-amber-600" : "text-orange-600"}`}>{c.minutes}</span>
                        <span className={`text-sm font-medium ${color === "sky" ? "text-sky-500" : color === "amber" ? "text-amber-500" : "text-orange-500"}`}>min</span>
                        <span className="text-xs text-stone-400 ml-auto tabular-nums">{c.miles} mi</span>
                      </div>
                      <p className="text-[10px] text-stone-400 mt-1 truncate">{place.address}</p>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-stone-400 mt-2.5">Estimated drive times based on typical Houston traffic. Actual times vary by route and time of day.</p>
            </div>
          </div>
        )}

        {/* ── Flood Risk ───────────────────────────────────────────── */}
        <div className={`border rounded-2xl overflow-hidden anim-fade-up ${flood?.risk === "high" ? "bg-orange-50/50 border-orange-200" : flood?.risk === "moderate" ? "bg-amber-50/50 border-amber-200" : "bg-white border-stone-200"}`} style={{ animationDelay: '220ms' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FloodIcon risk={flood?.risk || "low"} />
                <h3 className="text-sm font-semibold text-stone-700">Flood Risk</h3>
              </div>
              {flood && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${flood.risk === "high" ? "bg-orange-100 text-orange-600" : flood.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                  {flood.risk === "high" ? "High Risk" : flood.risk === "moderate" ? "Moderate Risk" : "Low Risk"}
                </span>
              )}
            </div>

            {floodLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Looking up FEMA flood zone...</div>}

            {flood && (
              <div className="space-y-3">
                {/* Zone + Description */}
                <div className={`rounded-xl p-3.5 ${flood.risk === "high" ? "bg-orange-100/60" : flood.risk === "moderate" ? "bg-amber-100/60" : "bg-sky-50"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xl font-bold ${flood.risk === "high" ? "text-orange-700" : flood.risk === "moderate" ? "text-amber-700" : "text-sky-700"}`}>
                      Zone {flood.zone}
                    </span>
                  </div>
                  <p className={`text-sm font-medium ${flood.risk === "high" ? "text-orange-600" : flood.risk === "moderate" ? "text-amber-600" : "text-sky-600"}`}>
                    {flood.zoneDesc || "FEMA Designated Flood Zone"}
                  </p>
                </div>

                {/* Explanation */}
                <div className="text-sm text-stone-600 leading-relaxed space-y-2">
                  {flood.risk === "high" && (
                    <>
                      <p>This property is in a <strong className="text-orange-600">Special Flood Hazard Area (SFHA)</strong> — an area with at least a 1% annual chance of flooding, commonly known as the 100-year floodplain.</p>
                      <p><strong>Flood insurance is required</strong> for federally backed mortgages (conventional, FHA, VA) in this zone. Annual premiums typically range from $2,000–$8,000+ depending on elevation, coverage, and flood history.</p>
                      <p>Homes in this zone have a <strong>26% chance of flooding over a 30-year mortgage</strong>. Consider checking Harvey/Imelda flood claims history for this address.</p>
                    </>
                  )}
                  {flood.risk === "moderate" && (
                    <>
                      <p>This property is in a <strong className="text-amber-600">moderate flood hazard area</strong> — between the 100-year and 500-year floodplain (0.2% annual chance).</p>
                      <p>Flood insurance is <strong>not required</strong> but strongly recommended. Properties in this zone can still flood, especially in major storm events. Over 25% of NFIP flood claims come from moderate and low-risk zones.</p>
                      <p>Preferred Risk Policies are available at lower premiums, typically $400–$1,500/year.</p>
                    </>
                  )}
                  {flood.risk === "low" && (
                    <>
                      <p>This property is in a <strong className="text-sky-600">minimal flood hazard area</strong> outside of identified floodplains.</p>
                      <p>Flood insurance is <strong>not required</strong> but still available. In Houston, even Zone X properties can experience localized flooding from heavy rainfall or drainage issues.</p>
                    </>
                  )}
                </div>

                {/* Additional notes */}
                {flood.notes && (
                  <div className={`rounded-xl px-3.5 py-2.5 text-sm ${flood.risk === "high" ? "bg-orange-100/40 text-orange-700" : flood.risk === "moderate" ? "bg-amber-100/40 text-amber-700" : "bg-stone-50 text-stone-600"}`}>
                    <strong className="text-xs uppercase tracking-wider">Note:</strong> {flood.notes}
                  </div>
                )}

                {/* Panel + Source */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-stone-400">{flood.panel ? `FEMA NFHL · Panel ${flood.panel}` : "FEMA NFHL"}</span>
                  <button onClick={() => {
                    setFloodLoading(true);
                    setFlood(null);
                    fetchFloodZone(home.address, home.city, home.state, home.zip).then((r) => {
                      setFloodLoading(false);
                      if (r && r.zone) { setFlood(r); onUpdate(home.id, { flood: r }); }
                    });
                  }} className="text-xs text-sky-600 font-medium hover:text-sky-700">Refresh</button>
                </div>
              </div>
            )}

            {!floodLoading && !flood && (
              <div className="bg-stone-50 border border-dashed border-stone-200 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-stone-400">No flood zone data available</span>
                <button onClick={() => {
                  setFloodLoading(true);
                  fetchFloodZone(home.address, home.city, home.state, home.zip).then((r) => {
                    setFloodLoading(false);
                    if (r && r.zone) { setFlood(r); onUpdate(home.id, { flood: r }); }
                  });
                }} className="text-sm text-sky-600 font-medium hover:text-sky-700">Fetch flood zone →</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Crime & Safety ─────────────────────────────────────── */}
        <div className={`border rounded-2xl overflow-hidden anim-fade-up ${crime?.risk === "high" ? "bg-orange-50/50 border-orange-200" : crime?.risk === "moderate" ? "bg-amber-50/50 border-amber-200" : "bg-white border-stone-200"}`} style={{ animationDelay: '230ms' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CrimeIcon risk={crime?.risk || "low"} />
                <h3 className="text-sm font-semibold text-stone-700">Crime & Safety</h3>
              </div>
              {crime && (
                <div className="flex items-center gap-2">
                  {crime.grade && <span className={`text-sm font-bold ${crime.risk === "high" ? "text-orange-600" : crime.risk === "moderate" ? "text-amber-600" : "text-sky-600"}`}>{crime.grade}</span>}
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${crime.risk === "high" ? "bg-orange-100 text-orange-600" : crime.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                    {crime.risk === "high" ? "High Risk" : crime.risk === "moderate" ? "Moderate" : "Low Risk"}
                  </span>
                </div>
              )}
            </div>

            {crimeLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Looking up crime data...</div>}

            {crime && (
              <div className="space-y-3">
                {/* Stats bars */}
                {(crime.violentPerK != null || crime.propertyPerK != null) && (
                  <div className="space-y-2.5">
                    {crime.violentPerK != null && (() => {
                      const pct = Math.min((crime.violentPerK / (crime.nationalAvgViolent * 3)) * 100, 100);
                      const natPct = Math.min((crime.nationalAvgViolent / (crime.nationalAvgViolent * 3)) * 100, 100);
                      const isAbove = crime.violentPerK > crime.nationalAvgViolent;
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-stone-500">Violent Crime</span>
                            <span className={`text-xs font-bold tabular-nums ${isAbove ? "text-orange-500" : "text-sky-600"}`}>{crime.violentPerK.toFixed(1)} <span className="font-normal text-stone-400">per 1K</span></span>
                          </div>
                          <div className="h-3 bg-stone-100 rounded-full overflow-hidden relative">
                            <div className="absolute top-0 bottom-0 w-px bg-stone-400 z-10" style={{ left: `${natPct}%` }} title={`National avg: ${crime.nationalAvgViolent}`} />
                            <div className={`h-full rounded-full ${isAbove ? "bg-orange-400" : "bg-sky-400"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="text-[10px] text-stone-400 mt-0.5 tabular-nums">National avg: {crime.nationalAvgViolent}/1K</div>
                        </div>
                      );
                    })()}
                    {crime.propertyPerK != null && (() => {
                      const pct = Math.min((crime.propertyPerK / (crime.nationalAvgProperty * 2)) * 100, 100);
                      const natPct = Math.min((crime.nationalAvgProperty / (crime.nationalAvgProperty * 2)) * 100, 100);
                      const isAbove = crime.propertyPerK > crime.nationalAvgProperty;
                      return (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-stone-500">Property Crime</span>
                            <span className={`text-xs font-bold tabular-nums ${isAbove ? "text-orange-500" : "text-sky-600"}`}>{crime.propertyPerK.toFixed(1)} <span className="font-normal text-stone-400">per 1K</span></span>
                          </div>
                          <div className="h-3 bg-stone-100 rounded-full overflow-hidden relative">
                            <div className="absolute top-0 bottom-0 w-px bg-stone-400 z-10" style={{ left: `${natPct}%` }} title={`National avg: ${crime.nationalAvgProperty}`} />
                            <div className={`h-full rounded-full ${isAbove ? "bg-orange-400" : "bg-sky-400"}`} style={{ width: `${pct}%` }} />
                          </div>
                          <div className="text-[10px] text-stone-400 mt-0.5 tabular-nums">National avg: {crime.nationalAvgProperty}/1K</div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Top concerns */}
                {crime.topConcerns && crime.topConcerns.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-stone-500 mb-1.5">Top Concerns</div>
                    <div className="flex flex-wrap gap-1.5">
                      {crime.topConcerns.map((c, i) => (
                        <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${crime.risk === "high" ? "bg-orange-100 text-orange-600" : crime.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-stone-100 text-stone-600"}`}>{c}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Explanation */}
                <div className="text-sm text-stone-600 leading-relaxed space-y-2">
                  {crime.risk === "high" && (
                    <p>This neighborhood has <strong className="text-orange-600">crime rates significantly above</strong> the national average. Review specific crime types and consider visiting the area at different times of day. Check with neighbors and local police beat info for context.</p>
                  )}
                  {crime.risk === "moderate" && (
                    <p>This neighborhood has <strong className="text-amber-600">crime rates near or somewhat above</strong> the national average. Common for urban areas in Houston — property crime tends to be the primary concern. Standard home security measures recommended.</p>
                  )}
                  {crime.risk === "low" && (
                    <p>This neighborhood has <strong className="text-sky-600">crime rates below</strong> the national average. Generally considered a safe area with low incidence of both violent and property crime.</p>
                  )}
                </div>

                {/* Notes */}
                {crime.notes && (
                  <div className={`rounded-xl px-3.5 py-2.5 text-sm ${crime.risk === "high" ? "bg-orange-100/40 text-orange-700" : crime.risk === "moderate" ? "bg-amber-100/40 text-amber-700" : "bg-stone-50 text-stone-600"}`}>
                    <strong className="text-xs uppercase tracking-wider">Note:</strong> {crime.notes}
                  </div>
                )}

                {/* Source */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-stone-400">{crime.source || "Crime Data"}</span>
                  <button onClick={() => {
                    setCrimeLoading(true);
                    setCrime(null);
                    fetchCrime(home.address, home.city, home.state, home.zip).then((r) => {
                      setCrimeLoading(false);
                      if (r && r.risk) { setCrime(r); onUpdate(home.id, { crime: r }); }
                    });
                  }} className="text-xs text-sky-600 font-medium hover:text-sky-700">Refresh</button>
                </div>
              </div>
            )}

            {!crimeLoading && !crime && (
              <div className="bg-stone-50 border border-dashed border-stone-200 rounded-xl p-4 flex items-center justify-between">
                <span className="text-sm text-stone-400">No crime data available</span>
                <button onClick={() => {
                  setCrimeLoading(true);
                  fetchCrime(home.address, home.city, home.state, home.zip).then((r) => {
                    setCrimeLoading(false);
                    if (r && r.risk) { setCrime(r); onUpdate(home.id, { crime: r }); }
                  });
                }} className="text-sm text-sky-600 font-medium hover:text-sky-700">Fetch crime data →</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Offer Analysis ─────────────────────────────────────── */}
        {offer && (
          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '245ms' }}>
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <svg className="w-4 h-4 text-violet-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                <h3 className="text-sm font-semibold text-stone-700">Offer Analysis</h3>
                <span className="text-[10px] text-stone-400 ml-auto">{offer.soldCount > 0 ? `${offer.soldCount} sold · ` : ""}{offer.compCount} comps</span>
              </div>

              {/* Offer range visual */}
              <div className="bg-gradient-to-r from-violet-50 to-fuchsia-50/50 rounded-xl p-4 mb-4">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Aggressive</div>
                    <div className="text-lg font-bold text-violet-700 tabular-nums">{fmtC(offer.aggressive)}</div>
                    <div className="text-[10px] text-violet-500 tabular-nums">{((offer.aggressive / home.price - 1) * 100).toFixed(1)}%</div>
                  </div>
                  <div className="border-x border-violet-200/50">
                    <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Competitive</div>
                    <div className="text-xl font-bold text-violet-800 tabular-nums">{fmtC(offer.competitive)}</div>
                    <div className="text-[10px] text-violet-500 tabular-nums">{((offer.competitive / home.price - 1) * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Strong</div>
                    <div className="text-lg font-bold text-violet-700 tabular-nums">{fmtC(offer.strong)}</div>
                    <div className="text-[10px] text-violet-500 tabular-nums">{((offer.strong / home.price - 1) * 100).toFixed(1)}%</div>
                  </div>
                </div>
                {/* Range bar */}
                <div className="mt-3 relative h-2 bg-violet-100 rounded-full overflow-hidden">
                  <div className="absolute inset-y-0 bg-gradient-to-r from-violet-400 to-fuchsia-400 rounded-full"
                    style={{ left: `${Math.max(0, (1 - offer.aggressive / home.price) * 100 / 0.15 * 100) / 100}%`, right: `${100 - Math.min(100, (1 - (offer.strong / home.price - 1)) * 100)}%` }} />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[9px] text-violet-400">Lower</span>
                  <span className="text-[9px] text-violet-400">List: {fmtC(home.price)}</span>
                </div>
              </div>

              {/* Signal cards */}
              <div className="space-y-2.5">
                {/* Comp analysis */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-stone-50">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${offer.compGap > 0.05 ? "bg-orange-100 text-orange-600" : offer.compGap < -0.02 ? "bg-sky-100 text-sky-600" : "bg-stone-200 text-stone-500"}`}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 6l3 1m0 0l-3 9a5 5 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5 5 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-stone-600">Comp Value</span>
                      <span className="text-xs font-bold text-stone-700 tabular-nums">{fmtC(offer.compValue)} <span className="text-stone-400 font-normal">({fmt(offer.medianPpsf)}/sf)</span></span>
                    </div>
                    <p className="text-[10px] text-stone-400 mt-0.5">{offer.compNote} · Based on {offer.soldCount > 0 ? `${offer.soldCount} sold + ${offer.compCount - offer.soldCount} active` : `${offer.compCount} active listings`}</p>
                  </div>
                </div>

                {/* Appraisal gap */}
                {offer.apprValue && (
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-stone-50">
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${offer.apprGap > 0.1 ? "bg-orange-100 text-orange-600" : offer.apprGap < 0 ? "bg-sky-100 text-sky-600" : "bg-amber-100 text-amber-600"}`}>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-stone-600">HCAD Appraisal</span>
                        <span className="text-xs font-bold text-stone-700 tabular-nums">{fmtC(offer.apprValue)} <span className={`font-semibold ${offer.apprGap > 0 ? "text-orange-500" : "text-sky-600"}`}>({offer.apprGap > 0 ? "+" : ""}{(offer.apprGap * 100).toFixed(0)}%)</span></span>
                      </div>
                      <p className="text-[10px] text-stone-400 mt-0.5">{offer.apprNote}</p>
                    </div>
                  </div>
                )}

                {/* DOM leverage */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-stone-50">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${offer.dom > 60 ? "bg-sky-100 text-sky-600" : offer.dom > 30 ? "bg-amber-100 text-amber-600" : "bg-stone-200 text-stone-500"}`}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-stone-600">Days on Market</span>
                      <span className="text-xs font-bold text-stone-700 tabular-nums">{offer.dom} days</span>
                    </div>
                    <p className="text-[10px] text-stone-400 mt-0.5">{offer.domLabel}</p>
                  </div>
                </div>

                {/* Risk factors */}
                {offer.riskNotes.length > 0 && (
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-orange-50/50">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-orange-100 text-orange-600">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold text-stone-600">Risk Adjustments</span>
                      <div className="mt-1 space-y-0.5">
                        {offer.riskNotes.map((n, i) => (
                          <p key={i} className="text-[10px] text-orange-600">{n}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Top comps used */}
                <details className="mt-1">
                  <summary className="text-[10px] text-violet-500 cursor-pointer hover:text-violet-600 font-medium">View comparable homes used</summary>
                  <div className="mt-2 space-y-1.5">
                    {offer.comps.slice(0, 8).map((c) => (
                      <div key={c.id} className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-stone-50 text-[10px] gap-2">
                        {c.url
                          ? <a href={c.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-violet-600 hover:text-violet-700 underline decoration-violet-300 truncate flex-shrink min-w-0">{c.address}</a>
                          : <span className="text-stone-600 truncate flex-shrink min-w-0">{c.address}</span>}
                        <span className="flex items-center gap-1.5 flex-shrink-0">
                          {c.isSold
                            ? <span className="text-[9px] font-bold text-teal-600 bg-teal-50 px-1 py-0.5 rounded">SOLD</span>
                            : <span className="text-[9px] font-bold text-stone-400 bg-stone-100 px-1 py-0.5 rounded">LIST</span>}
                          <span className="text-stone-500 tabular-nums">{fmtC(c.price)} · {fmt(c.ppsf)}/sf</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>

              <p className="text-[10px] text-stone-400 mt-3 leading-relaxed">
                This analysis is a starting point for negotiations, not a formal appraisal. Factors like condition, upgrades, lot premium, and seller motivation should also be considered. Always consult your agent.
              </p>
              {offer.soldCount === 0 && (
                <p className="text-[10px] text-violet-500 mt-2 font-medium">
                  Tip: Import sold comps in Settings to improve accuracy. Closed sale prices are far more reliable than active listing prices.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Financial Model ─────────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '240ms' }}>
          <button onClick={() => setShowFinancial(!showFinancial)}
            className="w-full flex items-center justify-between p-4 text-left md:hidden active:bg-stone-50 transition-colors">
            <div>
              <h3 className="text-sm font-semibold text-stone-700">Financial Model</h3>
              <p className="text-xs text-stone-400 mt-0.5">{fmt(result.totalMonthly)}/mo · {fmt(fin.cash)} total cash</p>
            </div>
            <span className={`text-stone-400 text-lg transition-transform duration-200 ${showFinancial ? "rotate-45" : ""}`}>+</span>
          </button>
          <h3 className="hidden md:block text-sm font-semibold text-stone-700 p-4 pb-0">Financial Model</h3>

          <div className={`${showFinancial ? "block" : "hidden"} md:block p-4 pt-2`}>
            <div className="bg-gradient-to-r from-stone-50 to-stone-100/50 rounded-xl p-4 mb-4">
              <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Estimated Monthly Payment</div>
              <div className="text-3xl font-bold text-stone-800 tabular-nums">{fmt(result.totalMonthly)}<span className="text-sm text-stone-400 font-normal ml-1">/mo</span></div>
              <div className="mt-3 space-y-1.5">
                {[
                  { label: "Principal & Interest", value: result.monthlyPI, color: "bg-sky-500" },
                  { label: "Property Tax", value: result.monthlyTax, color: "bg-amber-500" },
                  { label: "Homeowners Ins.", value: Math.round(homeIns.homeownersAnnual / 12), color: "bg-teal-500" },
                  ...(homeIns.floodAnnual > 0 ? [{ label: "Flood Ins.", value: Math.round(homeIns.floodAnnual / 12), color: "bg-teal-400" }] : []),
                  ...(home.hoa ? [{ label: "HOA", value: home.hoa, color: "bg-orange-400" }] : []),
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-2 text-sm">
                    <div className={`w-2 h-2 rounded-full ${item.color}`} />
                    <span className="text-stone-500 flex-1">{item.label}</span>
                    <span className="text-stone-700 font-medium tabular-nums">{fmt(item.value)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 mb-4">
              {[
                { label: "Total Cash", value: fmt(fin.cash), sub: "Your budget" },
                { label: "Closing Costs", value: fmt(closingCosts), sub: `${fin.closing}% of price` },
                { label: "Down Payment", value: fmt(effectiveDown), sub: home.price ? `${((effectiveDown / home.price) * 100).toFixed(1)}% of price` : null },
                { label: "Loan Amount", value: fmt(result.loan) },
                { label: "Total Interest", value: fmt(result.totalInterest) },
                { label: "Remaining Cash", value: fmt(Math.max(0, fin.cash - effectiveDown - closingCosts)), sub: fin.cash - effectiveDown - closingCosts > 0 ? "After close" : null },
              ].map((m) => (
                <div key={m.label} className="bg-stone-50 rounded-xl p-3">
                  <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">{m.label}</div>
                  <div className="text-base font-bold text-stone-800 mt-0.5 tabular-nums">{m.value}</div>
                  {m.sub && <div className="text-xs text-stone-400 mt-0.5">{m.sub}</div>}
                </div>
              ))}
            </div>

            {/* Appraisal Detail */}
            {(appraisal || appraisalLoading) && (
              <div className="bg-gradient-to-r from-stone-50 to-stone-100/50 rounded-xl p-4 mb-4">
                <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-2">County Appraisal</div>
                {appraisalLoading && <div className="text-sm text-stone-400 animate-pulse">Looking up appraisal value...</div>}
                {appraisal && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-stone-500">Appraised Value</span>
                      <span className="text-lg font-bold text-stone-800 tabular-nums">{fmt(appraisal.value)}</span>
                    </div>
                    {home.price && appraisal.value && (() => {
                      const diff = home.price - appraisal.value;
                      const pct = ((diff / appraisal.value) * 100).toFixed(1);
                      return (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-stone-500">List vs. Appraisal</span>
                          <span className={`text-sm font-semibold tabular-nums ${diff > 0 ? "text-orange-500" : diff < 0 ? "text-sky-600" : "text-stone-500"}`}>
                            {diff > 0 ? "+" : ""}{fmt(diff)} ({diff > 0 ? "+" : ""}{pct}%)
                          </span>
                        </div>
                      );
                    })()}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-stone-400">{appraisal.source} · {appraisal.year}</span>
                      <button onClick={() => {
                        setAppraisalLoading(true);
                        setAppraisal(null);
                        fetchAppraisal(home.address, home.city, home.state).then((r) => {
                          setAppraisalLoading(false);
                          if (r && r.appraisalValue) {
                            const d = { value: r.appraisalValue, year: r.appraisalYear, source: r.source };
                            setAppraisal(d);
                            onUpdate(home.id, { appraisal: d });
                          }
                        });
                      }} className="text-xs text-sky-600 font-medium hover:text-sky-700">Refresh</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {!appraisalLoading && !appraisal && (
              <div className="bg-stone-50 border border-dashed border-stone-200 rounded-xl p-3 mb-4 flex items-center justify-between">
                <span className="text-xs text-stone-400">No appraisal data</span>
                <button onClick={() => {
                  setAppraisalLoading(true);
                  fetchAppraisal(home.address, home.city, home.state).then((r) => {
                    setAppraisalLoading(false);
                    if (r && r.appraisalValue) {
                      const d = { value: r.appraisalValue, year: r.appraisalYear, source: r.source };
                      setAppraisal(d);
                      onUpdate(home.id, { appraisal: d });
                    }
                  });
                }} className="text-xs text-sky-600 font-medium hover:text-sky-700">Fetch appraisal →</button>
              </div>
            )}

            <div>
              <h4 className="text-[10px] font-semibold text-stone-400 uppercase tracking-wider mb-2">Equity Projection</h4>
              <div className="space-y-1">
                {projection.filter((_, i) => i % (fin.projYears > 15 ? 3 : fin.projYears > 8 ? 2 : 1) === 0 || i === projection.length - 1).map((p) => (
                  <div key={p.year} className="flex items-center gap-2 text-xs">
                    <span className="text-stone-400 w-8 text-right tabular-nums font-medium">Yr {p.year}</span>
                    <div className="flex-1 h-4 bg-stone-100 rounded-full overflow-hidden relative">
                      <div className="absolute inset-y-0 left-0 bg-sky-200/70 rounded-full anim-grow-bar" style={{ width: `${(p.value / maxVal) * 100}%`, animationDelay: `${p.year * 60}ms` }} />
                      <div className="absolute inset-y-0 left-0 bg-teal-400 rounded-full anim-grow-bar" style={{ width: `${(p.equity / maxVal) * 100}%`, animationDelay: `${p.year * 60 + 100}ms` }} />
                    </div>
                    <span className="text-teal-600 w-20 text-right tabular-nums font-semibold">{fmt(p.equity)}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-4 mt-2 text-xs text-stone-400">
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-teal-400 rounded-sm" /> Equity</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-2 bg-sky-200/70 rounded-sm" /> Home Value</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN: Compare
   ═══════════════════════════════════════════════════════════════════ */
function CompareScreen({ homes, compareList, toggleCompare, clearCompare, onOpenHome, fin }) {
  const [compareFilter, setCompareFilter] = useState("all");
  const selected = compareList.map((id) => homes.find((h) => h.id === id)).filter(Boolean).slice(0, 2);

  /* Empty / partial state — show selectable list instead of dead end */
  if (selected.length < 2) {
    let available = homes.filter((h) => !compareList.includes(h.id));
    if (compareFilter === "favorites") available = available.filter((h) => h.favorite);
    const favCount = homes.filter((h) => !compareList.includes(h.id) && h.favorite).length;
    return (
      <div className="p-4 md:p-6">
        <div className="text-center py-8">
          <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-violet-50 border border-violet-200 flex items-center justify-center anim-pop"><CompareIcon className="w-7 h-7 text-violet-400" /></div>
          <h2 className="text-lg font-bold text-stone-800 mb-1 anim-fade-up" style={{ animationDelay: '100ms' }}>Compare Homes</h2>
          <p className="text-stone-400 text-sm anim-fade-up" style={{ animationDelay: '180ms' }}>Select {2 - selected.length} more home{selected.length === 0 ? "s" : ""} to compare side-by-side</p>
        </div>
        {selected.length === 1 && (
          <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 mb-4 text-sm text-violet-700 flex items-center gap-2">
            <span className="font-semibold flex-shrink-0">Selected:</span> <span className="truncate flex-1">{selected[0].address}</span>
            <button onClick={() => toggleCompare(selected[0].id)} className="text-violet-400 hover:text-violet-600 active:text-violet-800 transition-colors flex-shrink-0 p-1 -mr-1">✕</button>
          </div>
        )}
        {/* Filter pills */}
        <div className="flex gap-1 mb-3">
          <button onClick={() => setCompareFilter("all")}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${compareFilter === "all" ? "bg-violet-50 border-violet-200 text-violet-600" : "bg-white border-stone-200 text-stone-500 hover:border-stone-300"}`}>
            All
          </button>
          <button onClick={() => setCompareFilter("favorites")}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1 ${compareFilter === "favorites" ? "bg-amber-50 border-amber-200 text-amber-600" : "bg-white border-stone-200 text-stone-500 hover:border-stone-300"}`}>
            <StarIcon filled={compareFilter === "favorites"} className="w-3.5 h-3.5" /> Favorites {favCount > 0 && <span className="text-[10px] opacity-70">({favCount})</span>}
          </button>
        </div>
        <div className="space-y-2">
          {available.map((h, i) => (
            <button key={h.id} onClick={() => toggleCompare(h.id)}
              style={{ animationDelay: `${250 + i * 40}ms` }}
              className="anim-fade-up w-full flex items-center justify-between bg-white border border-stone-200 rounded-xl p-3.5 hover:border-violet-300 hover:bg-violet-50/50 active:bg-violet-50 transition-colors text-left">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {h.favorite && <StarIcon filled className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />}
                  <p className="font-medium text-stone-800 truncate text-sm">{h.address}</p>
                </div>
                <p className="text-xs text-stone-400">{h.city} · {h.beds}bd / {h.baths}ba · {fmtNum(h.sqft)} sqft</p>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                <p className="font-bold text-stone-800 text-sm tabular-nums">{fmt(h.price)}</p>
              </div>
            </button>
          ))}
          {available.length === 0 && <div className="text-center text-stone-400 py-8 text-sm">{compareFilter === "favorites" ? "No favorites yet — star homes from the list" : "No homes available"}</div>}
        </div>
      </div>
    );
  }

  const [a, b] = selected;
  const aClosing = (a.price || 0) * (fin.closing / 100), bClosing = (b.price || 0) * (fin.closing / 100);
  const aDown = Math.max(0, Math.min(fin.cash - aClosing, a.price || 0));
  const bDown = Math.max(0, Math.min(fin.cash - bClosing, b.price || 0));
  const aIns = estimateInsurance(a), bIns = estimateInsurance(b);
  const ac = calcMortgage(a.price || 0, aDown, fin.rate, fin.term, a.taxRate || fin.propTax, aIns.totalAnnual, a.hoa || 0, fin.closing);
  const bc = calcMortgage(b.price || 0, bDown, fin.rate, fin.term, b.taxRate || fin.propTax, bIns.totalAnnual, b.hoa || 0, fin.closing);

  const rows = [
    { label: "Price", a: fmt(a.price), b: fmt(b.price), better: a.price < b.price ? "a" : a.price > b.price ? "b" : null, section: "Property" },
    { label: "Beds", a: a.beds ?? "—", b: b.beds ?? "—", better: (a.beds || 0) > (b.beds || 0) ? "a" : (a.beds || 0) < (b.beds || 0) ? "b" : null },
    { label: "Baths", a: a.baths ?? "—", b: b.baths ?? "—", better: (a.baths || 0) > (b.baths || 0) ? "a" : (a.baths || 0) < (b.baths || 0) ? "b" : null },
    { label: "Sqft", a: fmtNum(a.sqft), b: fmtNum(b.sqft), better: (a.sqft || 0) > (b.sqft || 0) ? "a" : (a.sqft || 0) < (b.sqft || 0) ? "b" : null },
    { label: "$/Sqft", a: fmt(a.ppsf), b: fmt(b.ppsf), better: (a.ppsf || 999) < (b.ppsf || 999) ? "a" : (a.ppsf || 999) > (b.ppsf || 999) ? "b" : null },
    { label: "Year Built", a: a.yearBuilt || "—", b: b.yearBuilt || "—", better: (a.yearBuilt || 0) > (b.yearBuilt || 0) ? "a" : (a.yearBuilt || 0) < (b.yearBuilt || 0) ? "b" : null },
    { label: "Lot Size", a: fmtNum(a.lotSize), b: fmtNum(b.lotSize), better: (a.lotSize || 0) > (b.lotSize || 0) ? "a" : (a.lotSize || 0) < (b.lotSize || 0) ? "b" : null },
    { label: "DOM", a: a.dom ?? "—", b: b.dom ?? "—", better: null },
    { label: "Pool", a: a.pool === true ? "Yes" : a.pool === false ? "No" : "—", b: b.pool === true ? "Yes" : b.pool === false ? "No" : "—", better: a.pool === true && b.pool !== true ? "a" : b.pool === true && a.pool !== true ? "b" : null },
    { label: "Value Score", a: calcValueScore(a, homes), b: calcValueScore(b, homes), better: calcValueScore(a, homes) > calcValueScore(b, homes) ? "a" : calcValueScore(b, homes) > calcValueScore(a, homes) ? "b" : null },
    { label: "Avg Rating", a: avgRating(a.ratings) > 0 ? avgRating(a.ratings).toFixed(1) + " ★" : "—", b: avgRating(b.ratings) > 0 ? avgRating(b.ratings).toFixed(1) + " ★" : "—", better: avgRating(a.ratings) > avgRating(b.ratings) ? "a" : avgRating(b.ratings) > avgRating(a.ratings) ? "b" : null, section: "Your Ratings" },
    ...RATING_CATS.map((cat) => {
      const key = ratingKey(cat);
      const av = a.ratings?.[key] || 0, bv = b.ratings?.[key] || 0;
      return { label: cat, a: av > 0 ? "★".repeat(av) : "—", b: bv > 0 ? "★".repeat(bv) : "—", better: av > bv ? "a" : bv > av ? "b" : null };
    }),
  ];

  const ratingLabels = new Set(RATING_CATS);
  const sA = rows.filter((r) => r.better === "a" && ratingLabels.has(r.label)).length;
  const sB = rows.filter((r) => r.better === "b" && ratingLabels.has(r.label)).length;

  const HomeCard = ({ h, label, winning }) => (
    <div className={`flex-1 min-w-0 rounded-2xl p-3.5 md:p-5 border shadow-sm transition-colors ${winning ? "bg-sky-50 border-sky-200 ring-1 ring-sky-100" : "bg-white border-stone-200"}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">{label}</span>
        <button onClick={() => toggleCompare(h.id)} className="text-stone-400 hover:text-orange-500 text-xs transition-colors p-1">✕</button>
      </div>
      <button onClick={() => onOpenHome(h)} className="text-left w-full">
        <div className="font-bold text-stone-800 truncate text-sm">{h.address}</div>
        <div className="text-xs text-stone-400">{h.city}</div>
        <div className="text-xl font-bold text-stone-800 mt-1 tabular-nums">{fmt(h.price)}</div>
      </button>
      <div className="flex gap-1.5 mt-2 flex-wrap items-center">
        {(() => { const vs = calcValueScore(h, homes); const color = vs >= 70 ? "text-teal-700 bg-teal-50" : vs >= 50 ? "text-amber-700 bg-amber-50" : "text-orange-600 bg-orange-50"; return <span className={`text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded ${color}`}>{vs} value</span>; })()}
        {h.viewed && <span className="text-[10px] text-teal-600 font-bold bg-teal-50 px-1.5 py-0.5 rounded">Viewed</span>}
        {avgRating(h.ratings) > 0 && <span className="text-xs text-amber-500 font-semibold">{avgRating(h.ratings).toFixed(1)} ★</span>}
        <StatusBadge status={h.status} />
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-6 overflow-hidden">
      <div className="flex items-center justify-between mb-4 anim-fade-up">
        <div className="flex items-center gap-2">
          <CompareIcon className="w-5 h-5 text-violet-400" />
          <h2 className="text-sm font-semibold text-stone-700">Comparing</h2>
        </div>
        <button onClick={clearCompare}
          className="text-xs font-medium text-stone-400 hover:text-orange-500 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-orange-50 active:bg-orange-100">
          Reset
        </button>
      </div>
      <div className="flex items-stretch gap-2.5 mb-5">
        <div className="flex-1 min-w-0 anim-slide-left"><HomeCard h={a} label="Home A" winning={sA > sB} /></div>
        <div className="flex flex-col items-center justify-center flex-shrink-0 px-1 anim-pop" style={{ animationDelay: '150ms' }}>
          <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Rating</div>
          <div className="flex items-center gap-1">
            <span className={`text-xl font-bold tabular-nums ${sA > sB ? "text-sky-600" : "text-stone-500"}`}>{sA}</span>
            <span className="text-stone-300 text-sm">–</span>
            <span className={`text-xl font-bold tabular-nums ${sB > sA ? "text-sky-600" : "text-stone-500"}`}>{sB}</span>
          </div>
        </div>
        <div className="flex-1 min-w-0 anim-slide-right"><HomeCard h={b} label="Home B" winning={sB > sA} /></div>
      </div>

      {/* ── Financial Summary Hero ──────────────────────────────────── */}
      <div className="anim-scale-in bg-gradient-to-br from-sky-50 via-blue-50 to-indigo-50 border border-sky-200/80 rounded-2xl p-4 md:p-5 mb-5">
        {/* Side-by-side monthly totals */}
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1 text-center">
            <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-0.5">Home A</div>
            <div className={`text-2xl md:text-3xl font-bold tabular-nums ${ac.totalMonthly <= bc.totalMonthly ? "text-sky-700" : "text-stone-700"}`}>{fmt(ac.totalMonthly)}</div>
            <div className="text-xs text-stone-500">/mo</div>
          </div>
          <div className="flex flex-col items-center flex-shrink-0">
            <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Δ</div>
            <div className="text-base font-bold text-stone-600 tabular-nums">{fmt(Math.abs(ac.totalMonthly - bc.totalMonthly))}</div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-0.5">Home B</div>
            <div className={`text-2xl md:text-3xl font-bold tabular-nums ${bc.totalMonthly <= ac.totalMonthly ? "text-sky-700" : "text-stone-700"}`}>{fmt(bc.totalMonthly)}</div>
            <div className="text-xs text-stone-500">/mo</div>
          </div>
        </div>

        {/* Line-item breakdown */}
        <div className="border-t border-sky-200/50 pt-3 space-y-1.5">
          {[
            { label: "Mortgage P&I", aVal: ac.monthlyPI, bVal: bc.monthlyPI, color: "text-stone-600" },
            { label: "Property Tax", aVal: ac.monthlyTax, bVal: bc.monthlyTax, color: "text-amber-600" },
            { label: "Homeowners Ins.", aVal: Math.round(aIns.homeownersAnnual / 12), bVal: Math.round(bIns.homeownersAnnual / 12), color: "text-stone-500" },
            ...(aIns.floodAnnual > 0 || bIns.floodAnnual > 0 ? [{ label: "Flood Ins.", aVal: Math.round(aIns.floodAnnual / 12), bVal: Math.round(bIns.floodAnnual / 12), color: "text-orange-500" }] : []),
            ...((a.hoa || 0) > 0 || (b.hoa || 0) > 0 ? [{ label: "HOA", aVal: a.hoa || 0, bVal: b.hoa || 0, color: "text-stone-500" }] : []),
          ].map((row) => (
            <div key={row.label} className="flex items-center text-sm">
              <span className={`flex-1 text-right tabular-nums font-medium ${row.aVal < row.bVal ? "text-sky-600" : row.color}`}>{fmt(row.aVal)}</span>
              <span className="w-28 md:w-36 text-center text-[10px] text-stone-400 uppercase tracking-wider font-semibold px-2">{row.label}</span>
              <span className={`flex-1 tabular-nums font-medium ${row.bVal < row.aVal ? "text-sky-600" : row.color}`}>{fmt(row.bVal)}</span>
            </div>
          ))}
          <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
            <span className="flex-1 text-right tabular-nums font-bold text-stone-700">{fmt(ac.down)}</span>
            <span className="w-28 md:w-36 text-center text-[10px] text-stone-400 uppercase tracking-wider font-semibold px-2">Down Pmt</span>
            <span className="flex-1 tabular-nums font-bold text-stone-700">{fmt(bc.down)}</span>
          </div>
          <div className="flex items-center text-sm">
            <span className="flex-1 text-right tabular-nums font-medium text-stone-500">{fmt(ac.loan)}</span>
            <span className="w-28 md:w-36 text-center text-[10px] text-stone-400 uppercase tracking-wider font-semibold px-2">Loan</span>
            <span className="flex-1 tabular-nums font-medium text-stone-500">{fmt(bc.loan)}</span>
          </div>
          {(a.appraisal || b.appraisal) && (
            <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
              <span className="flex-1 text-right tabular-nums font-medium">
                {a.appraisal ? (
                  <span>
                    <span className="text-stone-600">{fmt(a.appraisal.value)}</span>
                    {a.price && a.appraisal.value && (() => {
                      const diff = a.price - a.appraisal.value;
                      return diff > 0
                        ? <span className="text-orange-500 text-[10px] ml-1">+{((diff / a.appraisal.value) * 100).toFixed(0)}%</span>
                        : diff < 0
                        ? <span className="text-sky-600 text-[10px] ml-1">{((diff / a.appraisal.value) * 100).toFixed(0)}%</span>
                        : null;
                    })()}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
              <span className="w-28 md:w-36 text-center text-[10px] text-stone-400 uppercase tracking-wider font-semibold px-2">Appraisal</span>
              <span className="flex-1 tabular-nums font-medium">
                {b.appraisal ? (
                  <span>
                    <span className="text-stone-600">{fmt(b.appraisal.value)}</span>
                    {b.price && b.appraisal.value && (() => {
                      const diff = b.price - b.appraisal.value;
                      return diff > 0
                        ? <span className="text-orange-500 text-[10px] ml-1">+{((diff / b.appraisal.value) * 100).toFixed(0)}%</span>
                        : diff < 0
                        ? <span className="text-sky-600 text-[10px] ml-1">{((diff / b.appraisal.value) * 100).toFixed(0)}%</span>
                        : null;
                    })()}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
            </div>
          )}
          {(a.flood || b.flood) && (
            <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
              <span className="flex-1 text-right font-medium">
                {a.flood ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${a.flood.risk === "high" ? "bg-orange-100 text-orange-600" : a.flood.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                    <FloodIcon risk={a.flood.risk} /> {a.flood.zone}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
              <span className="w-28 md:w-36 text-center flex items-center justify-center gap-1">
                <FloodIcon risk="moderate" />
                <span className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Flood</span>
              </span>
              <span className="flex-1 font-medium">
                {b.flood ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${b.flood.risk === "high" ? "bg-orange-100 text-orange-600" : b.flood.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                    <FloodIcon risk={b.flood.risk} /> {b.flood.zone}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
            </div>
          )}
          {(a.crime || b.crime) && (
            <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
              <span className="flex-1 text-right font-medium">
                {a.crime ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${a.crime.risk === "high" ? "bg-orange-100 text-orange-600" : a.crime.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                    <CrimeIcon risk={a.crime.risk} /> {a.crime.grade || a.crime.risk}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
              <span className="w-28 md:w-36 text-center flex items-center justify-center gap-1">
                <CrimeIcon risk="moderate" />
                <span className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Crime</span>
              </span>
              <span className="flex-1 font-medium">
                {b.crime ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${b.crime.risk === "high" ? "bg-orange-100 text-orange-600" : b.crime.risk === "moderate" ? "bg-amber-100 text-amber-600" : "bg-sky-100 text-sky-600"}`}>
                    <CrimeIcon risk={b.crime.risk} /> {b.crime.grade || b.crime.risk}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
            </div>
          )}
          {(a.school || b.school) && (
            <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
              <span className="flex-1 text-right font-medium">
                {a.school ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${a.school.tier === "great" ? "bg-sky-100 text-sky-600" : a.school.tier === "good" ? "bg-amber-100 text-amber-600" : "bg-orange-100 text-orange-600"}`}>
                    <SchoolIcon tier={a.school.tier} /> {a.school.rating}/10
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
              <span className="w-28 md:w-36 text-center flex items-center justify-center gap-1">
                <SchoolIcon tier="good" />
                <span className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">School</span>
              </span>
              <span className="flex-1 font-medium">
                {b.school ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${b.school.tier === "great" ? "bg-sky-100 text-sky-600" : b.school.tier === "good" ? "bg-amber-100 text-amber-600" : "bg-orange-100 text-orange-600"}`}>
                    <SchoolIcon tier={b.school.tier} /> {b.school.rating}/10
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </span>
            </div>
          )}
          {(a.parks || b.parks) && (
            <div className="flex items-center text-sm pt-2 border-t border-sky-200/50">
              <span className="flex-1 text-right font-medium">
                {a.parks ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${a.parks.greenSpaceScore === "excellent" ? "bg-emerald-100 text-emerald-600" : a.parks.greenSpaceScore === "good" ? "bg-teal-100 text-teal-600" : "bg-amber-100 text-amber-600"}`}>
                    {String.fromCodePoint(0x1F333)} {a.parks.parkCount1Mi || 0} parks {a.parks.nearestDistanceMi != null ? "\u00B7 " + a.parks.nearestDistanceMi.toFixed(1) + "mi" : ""}
                  </span>
                ) : <span className="text-stone-300">\u2014</span>}
              </span>
              <span className="w-28 md:w-36 text-center flex items-center justify-center gap-1">
                <svg className="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 2 6 5 6 8c0 2 1.5 3.5 3 4.5V22h6V12.5c1.5-1 3-2.5 3-4.5 0-3-2.5-6-6-6z"/></svg>
                <span className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Parks</span>
              </span>
              <span className="flex-1 font-medium">
                {b.parks ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${b.parks.greenSpaceScore === "excellent" ? "bg-emerald-100 text-emerald-600" : b.parks.greenSpaceScore === "good" ? "bg-teal-100 text-teal-600" : "bg-amber-100 text-amber-600"}`}>
                    {String.fromCodePoint(0x1F333)} {b.parks.parkCount1Mi || 0} parks {b.parks.nearestDistanceMi != null ? "\u00B7 " + b.parks.nearestDistanceMi.toFixed(1) + "mi" : ""}
                  </span>
                ) : <span className="text-stone-300">\u2014</span>}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3 pt-2 border-t border-sky-200/50 text-center text-xs text-stone-400">
          {fmt(fin.cash)} cash budget · {fin.rate}% rate · {fin.term}yr term
        </div>
      </div>

      {/* Mobile: stacked rows */}
      <div className="md:hidden space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} style={{ animationDelay: `${200 + i * 30}ms` }} className="anim-fade-up">
            {r.section && <div className="text-[10px] font-semibold text-stone-400 uppercase tracking-wider pt-3 pb-1">{r.section}</div>}
            <div className={`flex items-center rounded-xl px-3 py-2.5 ${r.highlight ? "bg-sky-50 border border-sky-200" : "bg-white border border-stone-200"}`}>
              <span className={`flex-1 text-sm tabular-nums font-medium text-right min-w-0 ${r.better === "a" ? "text-sky-600" : "text-stone-600"}`}>{r.a}</span>
              <span className={`mx-2 text-xs w-24 text-center font-medium flex-shrink-0 ${r.highlight ? "text-sky-600" : "text-stone-400"}`}>{r.label}</span>
              <span className={`flex-1 text-sm tabular-nums font-medium text-left min-w-0 ${r.better === "b" ? "text-sky-600" : "text-stone-600"}`}>{r.b}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-stone-200 shadow-sm bg-white">
        <table className="w-full text-sm min-w-[1400px]">
          <thead className="bg-stone-50/80 border-b border-stone-200">
            <tr>
              <th className="py-3 px-4 text-left text-xs font-semibold tracking-wider uppercase text-stone-400 w-44">Metric</th>
              <th className="py-3 px-4 text-right text-xs font-semibold tracking-wider uppercase text-sky-600">Home A</th>
              <th className="py-3 px-4 text-right text-xs font-semibold tracking-wider uppercase text-sky-600">Home B</th>
              <th className="py-3 px-4 text-center text-xs font-semibold tracking-wider uppercase text-stone-400 w-16">Edge</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r, i) => (
              <React.Fragment key={i}>
                {r.section && <tr className="bg-stone-50/60"><td colSpan={4} className="py-2 px-4 text-xs font-semibold text-stone-400 uppercase tracking-wider">{r.section}</td></tr>}
                <tr className={r.highlight ? "bg-sky-50/40" : "hover:bg-stone-50/50"}>
                  <td className={`py-2.5 px-4 font-medium ${r.highlight ? "text-sky-700" : "text-stone-500"}`}>{r.label}</td>
                  <td className={`py-2.5 px-4 text-right tabular-nums font-medium ${r.better === "a" ? "text-teal-600" : r.highlight ? "text-sky-700" : "text-stone-700"}`}>{r.a}</td>
                  <td className={`py-2.5 px-4 text-right tabular-nums font-medium ${r.better === "b" ? "text-teal-600" : r.highlight ? "text-sky-700" : "text-stone-700"}`}>{r.b}</td>
                  <td className="py-2.5 px-4 text-center">{r.better === "a" ? <span className="text-teal-600 text-xs font-semibold">◀ A</span> : r.better === "b" ? <span className="text-teal-600 text-xs font-semibold">B ▶</span> : <span className="text-stone-300">—</span>}</td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN: Settings
   ═══════════════════════════════════════════════════════════════════ */
function SettingsScreen({ fin, updateFin, liveRate, rateInfo, homes = [], setHomes, soldComps = [], setSoldComps, darkMode, setDarkMode }) {
  const fileRef = useRef();
  const handleSoldFile = async (file) => {
    const mod = await import("papaparse");
    const Papa = mod.default || mod;
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => {
      const parsed = r.data.map(mapSoldRow).filter((h) => h.address && h.price && h.sqft);
      // Deduplicate by address
      const existing = new Set(soldComps.map(c => c.address?.toLowerCase()));
      const fresh = parsed.filter(h => !existing.has(h.address?.toLowerCase()));
      setSoldComps(prev => [...prev, ...fresh]);
    }});
  };

  // Derive ZIP guidance from active listings
  const zipCounts = useMemo(() => {
    const counts = {};
    homes.forEach(h => { if (h.zip) counts[h.zip] = (counts[h.zip] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [homes]);

  const soldZipCounts = useMemo(() => {
    const counts = {};
    soldComps.forEach(h => { if (h.zip) counts[h.zip] = (counts[h.zip] || 0) + 1; });
    return counts;
  }, [soldComps]);
  return (
    <div className="p-4 md:p-6 max-w-xl mx-auto">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-stone-800 anim-fade-up">Settings</h2>
        <p className="text-sm text-stone-400 mt-1 anim-fade-up" style={{ animationDelay: '60ms' }}>These assumptions apply to all estimates across the app.</p>
      </div>

      <div className="space-y-4">
        {/* Appearance */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '70ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Appearance</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-stone-700">Dark Mode</p>
              <p className="text-xs text-stone-400 mt-0.5">Auto-detects your system preference</p>
            </div>
            <button onClick={() => { setDarkMode(!darkMode); try { localStorage.setItem("cribs_dark", String(!darkMode)); } catch {} }}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${darkMode ? "bg-violet-500" : "bg-stone-300"}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 flex items-center justify-center ${darkMode ? "translate-x-5" : ""}`}>
                {darkMode
                  ? <svg className="w-3 h-3 text-violet-500" viewBox="0 0 24 24" fill="currentColor"><path d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" /></svg>
                  : <svg className="w-3 h-3 text-amber-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" /><path fillRule="evenodd" d="M12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM3 12a.75.75 0 01.75-.75H6a.75.75 0 010 1.5H3.75A.75.75 0 013 12zm15 0a.75.75 0 01.75-.75H21a.75.75 0 010 1.5h-2.25A.75.75 0 0118 12z" clipRule="evenodd" /></svg>
                }
              </span>
            </button>
          </div>
        </div>

        {/* Cash Budget */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '80ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Cash Budget</h3>
          <InputField label="Total Cash (Down + Closing)" value={fin.cash} onChange={(v) => updateFin({ cash: v })} type="number" prefix="$" />
          <p className="text-xs text-stone-400 mt-2">Your total available cash. Closing costs are subtracted first, the remainder goes toward your down payment.</p>
        </div>

        {/* Affordability */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '100ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Mortgage Affordability</h3>
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Gross Annual Income" value={fin.grossIncome || ""} onChange={(v) => updateFin({ grossIncome: Number(v) || 0 })} type="number" prefix="$" />
            <InputField label="Monthly Debts" value={fin.monthlyDebts || ""} onChange={(v) => updateFin({ monthlyDebts: Number(v) || 0 })} type="number" prefix="$" />
          </div>
          <div className="mt-3">
            <InputField label="Back-End DTI Limit" value={fin.dtiLimit || 36} onChange={(v) => updateFin({ dtiLimit: Number(v) || 36 })} type="number" suffix="%" />
          </div>
          <p className="text-xs text-stone-400 mt-2">Most lenders cap back-end DTI at 36–43%. This includes your total housing payment plus all monthly debts divided by gross monthly income.</p>
          {(() => {
            const budget = calcMaxBudget(fin);
            if (!budget) return <p className="text-xs text-stone-400 mt-3 italic">Enter your income to see your estimated max budget.</p>;
            return (
              <div className="mt-3 bg-sky-50 border border-sky-200/50 rounded-xl p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <svg className="w-3.5 h-3.5 text-sky-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>
                  <span className="text-xs font-semibold text-sky-700">Estimated Approval</span>
                </div>
                <div className="flex items-baseline gap-3">
                  <div>
                    <div className="text-2xl font-bold text-sky-700 tabular-nums">{fmt(budget.maxPrice)}</div>
                    <div className="text-[10px] text-sky-500">max home price</div>
                  </div>
                  <div className="text-stone-300">|</div>
                  <div>
                    <div className="text-lg font-bold text-sky-700 tabular-nums">{fmt(budget.maxMonthly)}</div>
                    <div className="text-[10px] text-sky-500">max monthly PITI</div>
                  </div>
                </div>
                <p className="text-[10px] text-sky-500 mt-2">Based on {(fin.dtiLimit || 36)}% DTI with {fmt(fin.cash)} cash, {fin.rate}% rate, {fin.term}yr term. Homes above this will be flagged.</p>
              </div>
            );
          })()}
        </div>

        {/* Loan Terms */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '120ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Loan Terms</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <InputField label="Interest Rate" value={fin.rate} onChange={(v) => updateFin({ rate: v })} type="number" suffix="%" />
              {rateInfo.source && rateInfo.source !== "default" && (
                <button onClick={() => updateFin({ rate: liveRate })} className="text-[10px] text-sky-600 font-semibold mt-1.5 hover:text-sky-700 transition-colors">
                  ● Reset to live rate ({liveRate}%)
                </button>
              )}
            </div>
            <InputField label="Term (years)" value={fin.term} onChange={(v) => updateFin({ term: v })} type="number" />
          </div>
        </div>

        {/* Escrow & Costs */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '160ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Escrow & Costs</h3>
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Default Tax Rate" value={fin.propTax} onChange={(v) => updateFin({ propTax: v })} type="number" suffix="%" />
            <InputField label="Closing Cost %" value={fin.closing} onChange={(v) => updateFin({ closing: v })} type="number" suffix="%" />
          </div>
          <div className="mt-3 bg-teal-50 border border-teal-200/50 rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-3.5 h-3.5 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              <span className="text-xs font-semibold text-teal-700">Insurance auto-calculated per home</span>
            </div>
            <p className="text-[11px] text-teal-600 leading-relaxed">Based on rebuild cost (sqft × $/sf), home age, size, and flood zone. Flood insurance added automatically for moderate/high risk zones. See breakdown in each home's financial model.</p>
          </div>
          <p className="text-xs text-stone-400 mt-2">Default tax rate is used when a home doesn't have location-specific tax data.</p>
        </div>

        {/* Projection */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '200ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-3">Equity Projection</h3>
          <div className="grid grid-cols-2 gap-3">
            <InputField label="Appreciation Rate" value={fin.appreciation} onChange={(v) => updateFin({ appreciation: v })} type="number" suffix="%" />
            <InputField label="Projection Years" value={fin.projYears} onChange={(v) => updateFin({ projYears: v })} type="number" />
          </div>
        </div>

        {/* Live rate info */}
        <div className="bg-stone-50 border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '240ms' }}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2 h-2 rounded-full ${rateInfo.loading ? "bg-stone-400 anim-pulse" : rateInfo.source === "default" ? "bg-stone-400" : "bg-teal-500"}`} />
            <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
              {rateInfo.loading ? "Fetching live rate..." : rateInfo.source === "default" ? "Using default rate" : "Live rate available"}
            </span>
          </div>
          {rateInfo.asOf && <p className="text-xs text-stone-400">Source: {rateInfo.source} · As of {rateInfo.asOf}</p>}
          <p className="text-xs text-stone-400 mt-1">The 30yr fixed rate is fetched from Freddie Mac on app load and used as the default interest rate.</p>
        </div>

        {/* Key Locations */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '280ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-1">Key Locations</h3>
          <p className="text-xs text-stone-400 mb-3">Commute times to these locations are shown on each property detail page.</p>
          <div className="space-y-3">
            {(fin.places || []).map((place, i) => (
              <div key={i} className="border border-stone-200 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={place.icon}
                      onChange={(e) => {
                        const updated = [...fin.places];
                        updated[i] = { ...updated[i], icon: e.target.value };
                        updateFin({ places: updated });
                      }}
                      className="text-xs bg-stone-50 border border-stone-200 rounded-md px-1.5 py-1 text-stone-600"
                    >
                      <option value="briefcase">Briefcase</option>
                      <option value="heart">Heart</option>
                      <option value="star">Star</option>
                      <option value="pin">Pin</option>
                    </select>
                    <input
                      type="text"
                      value={place.label}
                      onChange={(e) => {
                        const updated = [...fin.places];
                        updated[i] = { ...updated[i], label: e.target.value };
                        updateFin({ places: updated });
                      }}
                      className="text-sm font-semibold text-stone-700 bg-transparent border-none outline-none w-28"
                      placeholder="Label"
                    />
                  </div>
                  <button
                    onClick={() => {
                      const updated = fin.places.filter((_, j) => j !== i);
                      updateFin({ places: updated });
                    }}
                    className="text-stone-300 hover:text-orange-500 transition-colors text-xs p-1"
                  >✕</button>
                </div>
                <input
                  type="text"
                  value={place.address}
                  onChange={(e) => {
                    const updated = [...fin.places];
                    updated[i] = { ...updated[i], address: e.target.value };
                    updateFin({ places: updated });
                  }}
                  className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  placeholder="Address"
                />
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <div>
                    <label className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Latitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={place.lat || ""}
                      onChange={(e) => {
                        const updated = [...fin.places];
                        updated[i] = { ...updated[i], lat: parseFloat(e.target.value) || null };
                        updateFin({ places: updated });
                      }}
                      className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Longitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={place.lng || ""}
                      onChange={(e) => {
                        const updated = [...fin.places];
                        updated[i] = { ...updated[i], lng: parseFloat(e.target.value) || null };
                        updateFin({ places: updated });
                      }}
                      className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 tabular-nums"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {(fin.places || []).length < 5 && (
            <button
              onClick={() => updateFin({ places: [...(fin.places || []), { label: "", address: "", lat: null, lng: null, icon: "pin" }] })}
              className="mt-3 w-full py-2.5 text-xs font-semibold text-sky-600 bg-sky-50 border border-sky-200 rounded-xl hover:bg-sky-100 transition-colors"
            >+ Add Location</button>
          )}
        </div>

        {/* Sold Comps */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '320ms' }}>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-stone-700">Sold Comps</h3>
            {soldComps.length > 0 && <span className="text-[10px] font-bold text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">{soldComps.length} loaded</span>}
          </div>
          <p className="text-xs text-stone-400 mb-3">Import Redfin CSVs of recently sold homes to improve offer analysis accuracy. Sold prices are weighted more heavily than active listing prices.</p>

          {/* Import button */}
          <button onClick={() => fileRef.current?.click()}
            className="w-full py-2.5 text-xs font-semibold text-violet-600 bg-violet-50 border border-violet-200 rounded-xl hover:bg-violet-100 transition-colors flex items-center justify-center gap-2">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Import Sold Comps CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { if (e.target.files[0]) handleSoldFile(e.target.files[0]); e.target.value = ""; }} />

          {/* ZIP guidance */}
          {zipCounts.length > 0 && (
            <div className="mt-4">
              <h4 className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-2">Redfin Search Guide</h4>
              <p className="text-xs text-stone-500 mb-2">Based on your listings, pull <strong>sold in the last 12 months</strong> from Redfin for these ZIP codes:</p>
              <div className="space-y-1.5">
                {zipCounts.map(([zip, count]) => (
                  <div key={zip} className="flex items-center justify-between px-3 py-2 rounded-lg bg-stone-50">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-stone-700 tabular-nums">{zip}</span>
                      <span className="text-[10px] text-stone-400">{count} active listing{count !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {soldZipCounts[zip]
                        ? <span className="text-[10px] font-semibold text-teal-600">{soldZipCounts[zip]} sold loaded</span>
                        : <span className="text-[10px] font-semibold text-orange-500">Needs data</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 bg-violet-50/50 border border-violet-200/50 rounded-lg p-3">
                <h5 className="text-[10px] text-violet-600 uppercase tracking-wider font-bold mb-1.5">How to export from Redfin</h5>
                <ol className="text-[10px] text-stone-500 space-y-1 list-decimal list-inside">
                  <li>Go to redfin.com and search the ZIP code (e.g., "{zipCounts[0]?.[0]}")</li>
                  <li>Click <strong>Sold</strong> in the filter bar (top left)</li>
                  <li>Set <strong>Time Period</strong> to 12 months</li>
                  <li>Filter to <strong>Single Family</strong> and set a similar price range</li>
                  <li>Scroll down, click <strong>"Download All"</strong> to get the CSV</li>
                  <li>Import the CSV above — you can import multiple files</li>
                </ol>
              </div>
            </div>
          )}

          {/* Sold comps summary */}
          {soldComps.length > 0 && (
            <div className="mt-3">
              <details>
                <summary className="text-[10px] text-violet-500 cursor-pointer hover:text-violet-600 font-medium">{soldComps.length} sold comp{soldComps.length !== 1 ? "s" : ""} loaded</summary>
                <div className="mt-2 max-h-48 overflow-y-auto space-y-1">
                  {soldComps.slice(0, 50).map((c, i) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded bg-stone-50 text-[10px]">
                      <span className="text-stone-600 truncate max-w-[45%]">{c.address}</span>
                      <span className="text-stone-500 tabular-nums">{fmt(c.price)} · {c.sqft ? fmtNum(c.sqft) + "sf" : ""} · {c.zip}</span>
                    </div>
                  ))}
                  {soldComps.length > 50 && <p className="text-[10px] text-stone-400 text-center py-1">+ {soldComps.length - 50} more</p>}
                </div>
              </details>
              <button onClick={() => { if (window.confirm("Clear all sold comp data?")) setSoldComps([]); }}
                className="mt-2 text-[10px] text-stone-400 hover:text-orange-500 transition-colors">Clear sold comps</button>
            </div>
          )}
        </div>

        {/* Clear Enrichment Data */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '310ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-2">Clear Enrichment Data</h3>
          <p className="text-xs text-stone-400 mb-3">Strip flood, crime, school, parks, and grocery data from all homes. Data will re-fetch automatically on next load.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { if (window.confirm("Clear ALL enrichment data (flood, crime, school, parks, groceries) from every home?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.flood; delete c.crime; delete c.school; delete c.parks; delete c.groceries; return c; }); setHomes(cleaned); window.location.reload(); } }}
              className="text-xs font-medium text-stone-600 hover:text-stone-800 bg-stone-50 hover:bg-stone-100 px-3 py-1.5 rounded-lg border border-stone-200 transition-colors">Clear All Enrichment</button>
            <button onClick={() => { if (window.confirm("Clear parks data from all homes?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.parks; return c; }); setHomes(cleaned); window.location.reload(); } }}
              className="text-xs font-medium text-teal-600 hover:text-teal-700 bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg border border-teal-200 transition-colors">Clear Parks</button>
            <button onClick={() => { if (window.confirm("Clear grocery data from all homes?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.groceries; return c; }); setHomes(cleaned); window.location.reload(); } }}
              className="text-xs font-medium text-orange-600 hover:text-orange-700 bg-orange-50 hover:bg-orange-100 px-3 py-1.5 rounded-lg border border-orange-200 transition-colors">Clear Groceries</button>
          </div>
        </div>

        {/* Reset Data */}
        <div className="bg-white border border-orange-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '320ms' }}>
          <h3 className="text-sm font-semibold text-orange-700 mb-2">Reset Data</h3>
          <p className="text-xs text-stone-400 mb-3">Clear browser cache and reload the default 52 homes with all enrichment data. Your settings will be preserved.</p>
          <button onClick={() => { if (window.confirm("Reset all home data to defaults? Your financial settings will be preserved, but any custom notes, ratings, and viewed flags will be lost.")) { localStorage.removeItem("cribs_homes"); localStorage.removeItem("cribs_live_rate"); window.location.reload(); } }}
            className="text-xs font-medium text-orange-600 hover:text-orange-700 bg-orange-50 hover:bg-orange-100 px-3 py-1.5 rounded-lg border border-orange-200 transition-colors">Reset Home Data</button>
        </div>
      </div>
    </div>
  );
}
/* ═══════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════ */
export default function CribsApp() {
  const [homes, setHomes] = useState(() => {
    try {
      const s = localStorage.getItem("cribs_homes");
      if (s) {
        const p = JSON.parse(s);
        if (Array.isArray(p) && p.length > 0) {
          // Check if data has enrichment (v1.1+ format). If localStorage homes
          // are from a pre-enrichment version, reset to baked-in defaults.
          const hasEnrichment = p.some(h => h.flood && h.crime && h.school);
          if (hasEnrichment) return p;
          // Old data without enrichment - fall through to defaults
          localStorage.removeItem("cribs_homes");
        }
      }
    } catch {}
    return [
    { id: "r001", address: "6510 Sivley St", city: "Houston", state: "TX", zip: "77055", lat: 29.7971612, lng: -95.4650439, price: 1695000, beds: 4, baths: 5.0, sqft: 5288, lotSize: 8125, yearBuilt: 2025, dom: 1, ppsf: 321, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6510-Sivley-St-77055/home/30017890", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1417000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.4 mi" } },
    { id: "r002", address: "1410 Aldrich St", city: "Houston", state: "TX", zip: "77055", lat: 29.7954556, lng: -95.4641365, price: 1836880, beds: 5, baths: 5.5, sqft: 5032, lotSize: 7553, yearBuilt: 2026, dom: 1, ppsf: 365, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1410-Aldrich-St-77055/home/30018417", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1649000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.5 mi" } },
    { id: "r003", address: "9908 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8011501, lng: -95.5380544, price: 1499000, beds: 5, baths: 4.5, sqft: 4860, lotSize: 14257, yearBuilt: 2025, dom: 1, ppsf: 308, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9908-Warwana-Rd-77080/home/30044914", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1338000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.2 mi" } },
    { id: "r004", address: "1502 Adkins Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.7971551, lng: -95.5198305, price: 1100000, beds: 4, baths: 4.0, sqft: 3300, lotSize: 10166, yearBuilt: 1954, dom: 3, ppsf: 333, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1502-Adkins-Rd-77055/home/30074953", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1020000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Sherwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 560, nicheGrade: "B", testScores: 51, studentTeacherRatio: 14, notes: "Spring Branch ISD. Improving test scores year-over-year. Feeds into Spring Branch Middle.", distance: "0.6 mi" } },
    { id: "r005", address: "9756 Westview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7929313, lng: -95.5324124, price: 1670000, beds: 4, baths: 3.5, sqft: 4200, lotSize: 8764, yearBuilt: 2026, dom: 4, ppsf: 398, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9756-Westview-Dr-77055/home/30066168", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1380000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Sherwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 560, nicheGrade: "B", testScores: 51, studentTeacherRatio: 14, notes: "Spring Branch ISD. Improving test scores year-over-year. Feeds into Spring Branch Middle.", distance: "0.8 mi" } },
    { id: "r006", address: "1240 Mosaico Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7900874, lng: -95.4621978, price: 1388000, beds: 4, baths: 3.5, sqft: 3833, lotSize: 4896, yearBuilt: 2018, dom: 4, ppsf: 362, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1240-Mosaico-Ln-77055/home/52562067", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1183000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.3 mi" } },
    { id: "r007", address: "6534 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7963058, lng: -95.4662584, price: 1655000, beds: 4, baths: 5.0, sqft: 4832, lotSize: 8123, yearBuilt: 2025, dom: 5, ppsf: 343, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6534-Corbin-St-77055/home/30017833", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1342000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.4 mi" } },
    { id: "r008", address: "8006 Longridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8093655, lng: -95.4897827, price: 1050000, beds: 5, baths: 4.0, sqft: 5112, lotSize: 7957, yearBuilt: 2023, dom: 8, ppsf: 205, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8006-Longridge-Dr-77055/home/30072819", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 988000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.5 mi" } },
    { id: "r009", address: "7210 Jalna St", city: "Houston", state: "TX", zip: "77055", lat: 29.8022204, lng: -95.4735621, price: 1399000, beds: 5, baths: 4.0, sqft: 4337, lotSize: 7200, yearBuilt: 2026, dom: 9, ppsf: 323, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7210-Jalna-St-77055/home/30036785", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1228000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r010", address: "1458 Oak Tree Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7963361, lng: -95.5261206, price: 1350000, beds: 5, baths: 5.5, sqft: 4568, lotSize: 9100, yearBuilt: 2025, dom: 9, ppsf: 296, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1458-Oak-Tree-Dr-77055/home/30056132", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1238000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Sherwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 560, nicheGrade: "B", testScores: 51, studentTeacherRatio: 14, notes: "Spring Branch ISD. Improving test scores year-over-year. Feeds into Spring Branch Middle.", distance: "0.7 mi" } },
    { id: "r011", address: "1730 Bayram", city: "Houston", state: "TX", zip: "77055", lat: 29.8012931, lng: -95.4978617, price: 2250000, beds: 4, baths: 4.5, sqft: 4125, lotSize: 8400, yearBuilt: 2025, dom: 11, ppsf: 545, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1730-Bayram-Dr-77055/home/30058158", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1863000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Spring Oaks Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 530, nicheGrade: "B-", testScores: 35, studentTeacherRatio: 16, notes: "Spring Branch ISD. Dual language program. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r012", address: "1201 Confederate Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.7902432, lng: -95.5283515, price: 1420000, beds: 4, baths: 4.5, sqft: 4482, lotSize: 8320, yearBuilt: 2025, dom: 11, ppsf: 317, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1201-Confederate-Rd-77055/home/30066150", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1235000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Sherwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 560, nicheGrade: "B", testScores: 51, studentTeacherRatio: 14, notes: "Spring Branch ISD. Improving test scores year-over-year. Feeds into Spring Branch Middle.", distance: "0.9 mi" } },
    { id: "r013", address: "1216 Mosaico Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7896774, lng: -95.461992, price: 1173000, beds: 4, baths: 4.5, sqft: 3961, lotSize: 1685, yearBuilt: 2014, dom: 11, ppsf: 296, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1216-Mosaico-Ln-77055/home/52562063", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1076000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.3 mi" } },
    { id: "r014", address: "9115 Hammerly Blvd", city: "Houston", state: "TX", zip: "77080", lat: 29.8103782, lng: -95.5153388, price: 1499000, beds: 4, baths: 3.5, sqft: 4066, lotSize: 19584, yearBuilt: 2016, dom: 12, ppsf: 369, hoa: 67, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9115-Hammerly-Blvd-77080/home/29964997", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1349000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.0 mi" } },
    { id: "r015", address: "6502 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7962792, lng: -95.4646412, price: 1699900, beds: 5, baths: 6.0, sqft: 4855, lotSize: 8751, yearBuilt: 2025, dom: 17, ppsf: 350, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6502-Corbin-St-77055/home/30017856", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1419000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.4 mi" } },
    { id: "r016", address: "6711 Housman St", city: "Houston", state: "TX", zip: "77055", lat: 29.7992881, lng: -95.4687778, price: 1260000, beds: 5, baths: 4.5, sqft: 3624, lotSize: 8041, yearBuilt: 2025, dom: 24, ppsf: 348, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6711-Housman-St-77055/home/30036994", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1091000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.3 mi" } },
    { id: "r017", address: "1514 Jacquelyn Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7977192, lng: -95.4804267, price: 1149750, beds: 6, baths: 4.0, sqft: 4247, lotSize: 7840, yearBuilt: 1949, dom: 28, ppsf: 271, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1514-Jacquelyn-Dr-77055/home/30033639", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1032000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r018", address: "7407 Janak Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7993846, lng: -95.4763834, price: 1459000, beds: 5, baths: 5.0, sqft: 3996, lotSize: 6899, yearBuilt: 2025, dom: 28, ppsf: 365, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7407-Janak-Dr-77055/home/30078711", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1256000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.3 mi" } },
    { id: "r019", address: "1713 Bayram Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8005988, lng: -95.498418, price: 2099000, beds: 4, baths: 6.0, sqft: 5127, lotSize: 10798, yearBuilt: 2026, dom: 32, ppsf: 409, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1713-Bayram-Dr-77055/home/30058087", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1614000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Spring Oaks Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 530, nicheGrade: "B-", testScores: 35, studentTeacherRatio: 16, notes: "Spring Branch ISD. Dual language program. Feeds into Spring Oaks Middle.", distance: "0.6 mi" } },
    { id: "r020", address: "1941 Coulcrest Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8070349, lng: -95.4990735, price: 1195000, beds: 5, baths: 4.5, sqft: 3914, lotSize: 7501, yearBuilt: 2026, dom: 32, ppsf: 305, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1941-Coulcrest-Dr-77055/home/30031745", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1099000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r021", address: "1518 Hillendahl Blvd", city: "Houston", state: "TX", zip: "77055", lat: 29.7981696, lng: -95.4929243, price: 2150000, beds: 5, baths: 5.5, sqft: 6444, lotSize: 13298, yearBuilt: 2015, dom: 32, ppsf: 334, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1518-Hillendahl-Blvd-77055/home/30131667", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1654000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r022", address: "7115 Raton St", city: "Houston", state: "TX", zip: "77055", lat: 29.8010162, lng: -95.4727984, price: 1492500, beds: 5, baths: 6.0, sqft: 4375, lotSize: 7200, yearBuilt: 2025, dom: 32, ppsf: 341, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7115-Raton-St-77055/home/30036845", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1269000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.6 mi" } },
    { id: "r023", address: "7908 Westwood Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7994469, lng: -95.4862212, price: 2700000, beds: 5, baths: 6.0, sqft: 5591, lotSize: 15999, yearBuilt: 2025, dom: 33, ppsf: 483, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7908-Westwood-Dr-77055/home/30030472", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2203000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0410M", notes: "Near Spring Branch creek tributary. BFE varies. Flood insurance required. Significant Harvey flooding in area." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.7 mi" } },
    { id: "r024", address: "1503 Johanna Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7974083, lng: -95.4830652, price: 1500000, beds: 4, baths: 4.5, sqft: 4993, lotSize: 12066, yearBuilt: 2004, dom: 33, ppsf: 300, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1503-Johanna-Dr-77055/home/30033575", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1357000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Thornwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 490, nicheGrade: "B", testScores: 48, studentTeacherRatio: 14, notes: "Spring Branch ISD. Small school feel with improving academics. Feeds into Spring Branch Middle.", distance: "0.4 mi" } },
    { id: "r025", address: "6533 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7958381, lng: -95.4662585, price: 1625000, beds: 4, baths: 4.5, sqft: 4622, lotSize: 6825, yearBuilt: 2022, dom: 36, ppsf: 352, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6533-Corbin-St-77055/home/30018066", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1307000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.4 mi" } },
    { id: "r026", address: "8102 Montridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8085216, lng: -95.4920293, price: 1195000, beds: 4, baths: 4.5, sqft: 4240, lotSize: 7200, yearBuilt: 2025, dom: 37, ppsf: 282, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8102-Montridge-Dr-77055/home/30055700", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1059000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.3 mi" } },
    { id: "r027", address: "10418 Brinwood Dr", city: "Houston", state: "TX", zip: "77043", lat: 29.7953696, lng: -95.5547775, price: 1229000, beds: 5, baths: 4.5, sqft: 4173, lotSize: 10018, yearBuilt: 2026, dom: 37, ppsf: 295, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/10418-Brinwood-Dr-77043/home/30122892", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1119000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." }, school: { schoolName: "Frostwood Elementary", district: "SBISD", rating: 8, ratingSource: "GreatSchools", tier: "great", grades: "PK-5", enrollment: 750, nicheGrade: "A-", testScores: 78, studentTeacherRatio: 13, notes: "Spring Branch ISD. Top-rated SBISD elementary. Strong STEM programs. Memorial area — premium school zone.", distance: "0.8 mi" } },
    { id: "r028", address: "1825 Huge Oaks St", city: "Houston", state: "TX", zip: "77055", lat: 29.8042346, lng: -95.491406, price: 1049000, beds: 4, baths: 4.5, sqft: 3213, lotSize: 6760, yearBuilt: null, dom: 38, ppsf: 326, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1825-Huge-Oaks-St-77055/home/30077113", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 986000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r029", address: "6430 Rolla St", city: "Houston", state: "TX", zip: "77055", lat: 29.7930779, lng: -95.4641805, price: 1499000, beds: 4, baths: 4.0, sqft: 4703, lotSize: 8123, yearBuilt: 2017, dom: 41, ppsf: 319, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6430-Rolla-St-77055/home/30018469", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1252000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.5 mi" } },
    { id: "r030", address: "9926 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8011714, lng: -95.5386369, price: 1799995, beds: 5, baths: 6.0, sqft: 5632, lotSize: 14257, yearBuilt: 2026, dom: 43, ppsf: 320, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9926-Warwana-Rd-77080/home/30044908", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1511000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.1 mi" } },
    { id: "r031", address: "8033 Ridgeview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8096623, lng: -95.4912979, price: 1100000, beds: 5, baths: 4.5, sqft: 4031, lotSize: 7522, yearBuilt: 2026, dom: 43, ppsf: 273, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8033-Ridgeview-Dr-77055/home/30072950", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 956000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.4 mi" } },
    { id: "r032", address: "8029 Longridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8088977, lng: -95.4911576, price: 1100000, beds: 5, baths: 4.5, sqft: 4031, lotSize: 7958, yearBuilt: 2026, dom: 43, ppsf: 273, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8029-Longridge-Dr-77055/home/30072793", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 965000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.5 mi" } },
    { id: "r033", address: "1731 Benbow Way", city: "Houston", state: "TX", zip: "77080", lat: 29.8017046, lng: -95.5226701, price: 1549995, beds: 4, baths: 3.5, sqft: 4252, lotSize: 14069, yearBuilt: 2026, dom: 44, ppsf: 365, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1731-Benbow-Way-77080/home/30048665", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1312000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "0.9 mi" } },
    { id: "r034", address: "9345 Leto Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8035666, lng: -95.5214137, price: 1799995, beds: 5, baths: 5.5, sqft: 5353, lotSize: 13412, yearBuilt: 2026, dom: 44, ppsf: 336, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9345-Leto-Rd-77080/home/30049012", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1445000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0410M", notes: "Near Spring Branch creek tributary. BFE varies. Flood insurance required. Significant Harvey flooding in area." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.0 mi" } },
    { id: "r035", address: "2021 Marnel Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.8089138, lng: -95.498504, price: 1120000, beds: 5, baths: 4.5, sqft: 3750, lotSize: 9273, yearBuilt: 2025, dom: 49, ppsf: 299, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/2021-Marnel-Rd-77055/home/30068543", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 988000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r036", address: "8021 Turquoise Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.8112489, lng: -95.4906674, price: 1299999, beds: 4, baths: 4.5, sqft: 3742, lotSize: 7631, yearBuilt: 2025, dom: 50, ppsf: 347, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8021-Turquoise-Ln-77055/home/30073918", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1124000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.3 mi" } },
    { id: "r037", address: "8553 Western Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.804563, lng: -95.4995973, price: 1274999, beds: 4, baths: 4.5, sqft: 3922, lotSize: 8999, yearBuilt: 2025, dom: 50, ppsf: 325, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8553-Western-Dr-77055/home/30032127", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1067000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Ridgecrest Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 710, nicheGrade: "C+", testScores: 31, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average ratings — consider magnet transfers within SBISD. Feeds into Northbrook Middle.", distance: "0.6 mi" } },
    { id: "r038", address: "6610 Housman St", city: "Houston", state: "TX", zip: "77055", lat: 29.7997135, lng: -95.4668495, price: 1595000, beds: 5, baths: 5.5, sqft: 4512, lotSize: 7501, yearBuilt: 2025, dom: 63, ppsf: 354, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6610-Housman-St-77055/home/30018141", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1337000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r039", address: "10303 Eddystone Dr", city: "Houston", state: "TX", zip: "77043", lat: 29.7987193, lng: -95.5516996, price: 1020000, beds: 4, baths: 3.5, sqft: 3260, lotSize: 9374, yearBuilt: 1960, dom: 66, ppsf: 313, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/10303-Eddystone-Dr-77043/home/30101445", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 881000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." }, school: { schoolName: "Frostwood Elementary", district: "SBISD", rating: 8, ratingSource: "GreatSchools", tier: "great", grades: "PK-5", enrollment: 750, nicheGrade: "A-", testScores: 78, studentTeacherRatio: 13, notes: "Spring Branch ISD. Top-rated SBISD elementary. Strong STEM programs. Memorial area — premium school zone.", distance: "0.7 mi" } },
    { id: "r040", address: "1611 Lynnview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7996967, lng: -95.492471, price: 1800000, beds: 5, baths: 4.5, sqft: 5046, lotSize: 13198, yearBuilt: 2010, dom: 72, ppsf: 357, hoa: 3, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1611-Lynnview-Dr-77055/home/30131640", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1516000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Thornwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 490, nicheGrade: "B", testScores: 48, studentTeacherRatio: 14, notes: "Spring Branch ISD. Small school feel with improving academics. Feeds into Spring Branch Middle.", distance: "0.5 mi" } },
    { id: "r041", address: "9603 Carousel Ln", city: "Houston", state: "TX", zip: "77080", lat: 29.8136785, lng: -95.5292293, price: 1080000, beds: 5, baths: 4.5, sqft: 4089, lotSize: 7701, yearBuilt: 2026, dom: 89, ppsf: 264, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9603-Carousel-Ln-77080/home/30106041", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 950000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "0.8 mi" } },
    { id: "r042", address: "7214 Blandford Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7899237, lng: -95.4747114, price: 2399995, beds: 5, baths: 4.5, sqft: 5188, lotSize: 9029, yearBuilt: 2026, dom: 93, ppsf: 463, hoa: 8, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7214-Blandford-Ln-77055/home/30104141", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2029000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r043", address: "1749 Parana Dr", city: "Houston", state: "TX", zip: "77080", lat: 29.8040211, lng: -95.5322821, price: 1349000, beds: 5, baths: 4.5, sqft: 4220, lotSize: 12392, yearBuilt: 2025, dom: 107, ppsf: 320, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1749-Parana-Dr-77080/home/30067821", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1210000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.1 mi" } },
    { id: "r044", address: "1523 Cunningham Parc Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7984458, lng: -95.4874978, price: 1189000, beds: 5, baths: 4.5, sqft: 4078, lotSize: 2914, yearBuilt: 2016, dom: 107, ppsf: 292, hoa: 292, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1523-Cunningham-Parc-Ln-77055/home/112825548", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1059000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.3 mi" } },
    { id: "r045", address: "1918 Ridgecrest Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.805923, lng: -95.4927818, price: 1225000, beds: 5, baths: 4.5, sqft: 4080, lotSize: 9165, yearBuilt: 2026, dom: 107, ppsf: 300, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1918-Ridgecrest-Dr-77055/home/30031614", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1117000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r046", address: "1306 Zora St", city: "Houston", state: "TX", zip: "77055", lat: 29.7934132, lng: -95.4632266, price: 1695000, beds: 5, baths: 4.5, sqft: 4143, lotSize: 7622, yearBuilt: 2026, dom: 108, ppsf: 409, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1306-Zora-St-77055/home/30018492", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1486000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Thornwood Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 490, nicheGrade: "B", testScores: 48, studentTeacherRatio: 14, notes: "Spring Branch ISD. Small school feel with improving academics. Feeds into Spring Branch Middle.", distance: "0.6 mi" } },
    { id: "r047", address: "7203 Tickner St", city: "Houston", state: "TX", zip: "77055", lat: 29.7903872, lng: -95.4741456, price: 2449000, beds: 4, baths: 5.5, sqft: 5778, lotSize: 9984, yearBuilt: 2025, dom: 117, ppsf: 424, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7203-Tickner-St-77055/home/30014008", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2057000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.4 mi" } },
    { id: "r048", address: "7218 Schiller St", city: "Houston", state: "TX", zip: "77055", lat: 29.7989783, lng: -95.4742359, price: 1950000, beds: 4, baths: 5.0, sqft: 5300, lotSize: 9901, yearBuilt: 2025, dom: 124, ppsf: 368, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7218-Schiller-St-77055/home/30036933", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1701000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, school: { schoolName: "Bendwood Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 580, nicheGrade: "B-", testScores: 38, studentTeacherRatio: 15, notes: "Spring Branch ISD. Smaller campus with strong community involvement. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r049", address: "9839 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8007289, lng: -95.5363117, price: 1425000, beds: 5, baths: 4.5, sqft: 4173, lotSize: 12070, yearBuilt: 2026, dom: 143, ppsf: 341, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9839-Warwana-Rd-77080/home/30044936", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1220000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, school: { schoolName: "Cedar Brook Elementary", district: "SBISD", rating: 4, ratingSource: "GreatSchools", tier: "below", grades: "PK-5", enrollment: 480, nicheGrade: "C", testScores: 28, studentTeacherRatio: 16, notes: "Spring Branch ISD. Below average — consider SBISD magnet programs or transfers. Feeds into Northbrook Middle.", distance: "1.0 mi" } },
    { id: "r050", address: "1720 Huge Oaks St", city: "Houston", state: "TX", zip: "77055", lat: 29.802104, lng: -95.490798, price: 1250000, beds: 4, baths: 4.5, sqft: 3765, lotSize: 4998, yearBuilt: 2024, dom: 297, ppsf: 332, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1720-Huge-Oaks-St-77055/home/194216741", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1104000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Valley Oaks Elementary", district: "SBISD", rating: 6, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 650, nicheGrade: "B", testScores: 32, studentTeacherRatio: 17, notes: "Spring Branch ISD. Solid academics and active PTO. Feeds into Spring Oaks Middle.", distance: "0.5 mi" } },
    { id: "r051", address: "1131 Castellina Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.788488, lng: -95.464155, price: 1250000, beds: 4, baths: 4.5, sqft: 3368, lotSize: 3515, yearBuilt: 2024, dom: 472, ppsf: 371, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1131-Castellina-Ln-77055/home/52562173", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1104000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, school: { schoolName: "Housman Elementary", district: "SBISD", rating: 5, ratingSource: "GreatSchools", tier: "good", grades: "PK-5", enrollment: 620, nicheGrade: "B-", testScores: 42, studentTeacherRatio: 15, notes: "Spring Branch ISD. Dual language program available. Feeds into Spring Branch Middle and Memorial High.", distance: "0.2 mi" } },
    { id: "r052", address: "Custom Design 15218 Plan", city: "Houston", state: "TX", zip: "77043", lat: 29.820502, lng: -95.5643644, price: 1000000, beds: 5, baths: 6.0, sqft: 5580, lotSize: null, yearBuilt: null, dom: 836, ppsf: 179, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/Houston/Custom-Design-15218/home/188417430", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 929000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." }, school: { schoolName: "Bunker Hill Elementary", district: "SBISD", rating: 8, ratingSource: "GreatSchools", tier: "great", grades: "PK-5", enrollment: 680, nicheGrade: "A-", testScores: 85, studentTeacherRatio: 12, notes: "Spring Branch ISD. Memorial area. High-performing school in desirable zone. Feeds into Memorial Middle.", distance: "0.6 mi" } },
  ];
  });

  // Persist homes to localStorage (debounced 1s)
  const homesTimerRef = useRef(null);
  useEffect(() => {
    if (homesTimerRef.current) clearTimeout(homesTimerRef.current);
    homesTimerRef.current = setTimeout(() => {
      try { localStorage.setItem("cribs_homes", JSON.stringify(homes)); } catch {}
    }, 1000);
    return () => { if (homesTimerRef.current) clearTimeout(homesTimerRef.current); };
  }, [homes]);

  const [screen, setScreenRaw] = useState("list");
  const setScreen = (s) => { setScreenRaw(s); window.scrollTo(0, 0); };
  const [activeHome, setActiveHome] = useState(null);
  const [navList, setNavList] = useState([]);
  const [schoolFilter, setSchoolFilter] = useState(null);
  const [compareList, setCompareList] = useState([]);
  const [darkMode, setDarkMode] = useState(() => {
    try { const saved = localStorage.getItem("cribs_dark"); if (saved !== null) return saved === "true"; } catch {}
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });
  useEffect(() => {
    try { localStorage.setItem("cribs_dark", darkMode); } catch {}
  }, [darkMode]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const handler = (e) => {
      try { if (localStorage.getItem("cribs_dark") === null) setDarkMode(e.matches); } catch { setDarkMode(e.matches); }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const [soldComps, setSoldComps] = useState(() => {
    try { const s = localStorage.getItem("cribs_sold_comps"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [liveRate, setLiveRate] = useState(DEFAULT_RATE);
  const [rateInfo, setRateInfo] = useState({ loading: true, source: null, asOf: null });
  const [fin, setFin] = useState(() => {
    try { const s = localStorage.getItem("cribs_fin"); if (s) return JSON.parse(s); } catch {}
    return { cash: 750000, rate: DEFAULT_RATE, term: 30, propTax: 1.8, insurance: 3600, closing: 2.5, appreciation: 3, projYears: 10, grossIncome: 0, monthlyDebts: 0, dtiLimit: 36, places: [
    { label: "Work", address: "2322 W Grand Pkwy N, Katy, TX", lat: 29.8335, lng: -95.7675, icon: "briefcase" },
    { label: "Mom's House", address: "16015 Beechnut St, Houston, TX", lat: 29.6880, lng: -95.5810, icon: "heart" },
  ] };
  });
  const updateFin = (updates) => setFin((prev) => {
    const next = { ...prev, ...updates };
    try { localStorage.setItem("cribs_fin", JSON.stringify(next)); } catch {}
    return next;
  });
  const maxBudget = useMemo(() => calcMaxBudget(fin), [fin]);
  useEffect(() => { try { localStorage.setItem("cribs_sold_comps", JSON.stringify(soldComps)); } catch {} }, [soldComps]);

  useEffect(() => {
    let cancelled = false;
    fetchLiveRate().then((result) => {
      if (cancelled) return;
      if (result) {
        setLiveRate(result.rate);
        setRateInfo({ loading: false, source: result.source, asOf: result.asOf });
        setFin((prev) => ({ ...prev, rate: result.rate }));
      } else {
        setRateInfo({ loading: false, source: "default", asOf: null });
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Batch-fetch external data (flood, crime, school) for homes missing data
  const enrichingRef = useRef(false);
  const [enrichDone, setEnrichDone] = useState(false);
  useEffect(() => {
    if (enrichingRef.current) return;
    // Skip if all homes already have data
    const needsEnrich = homes.filter(h => !h.flood || !h.crime || !h.school || !h.parks || !h.groceries);
    if (needsEnrich.length === 0) { setEnrichDone(true); return; }
    enrichingRef.current = true;
    let cancelled = false;

    const enrich = async (homesList) => {
      for (let i = 0; i < homesList.length; i++) {
        if (cancelled) return;
        const h = homesList[i];

        // Check current state to skip already-enriched homes
        const needs = [];
        if (!h.flood) needs.push("flood");
        if (!h.crime) needs.push("crime");
        if (!h.school) needs.push("school");
        if (!h.parks) needs.push("parks");
        if (!h.groceries) needs.push("groceries");
        if (needs.length === 0) continue;

        try {
          const promises = [];
          if (needs.includes("flood")) promises.push(fetchFloodZone(h.address, h.city, h.state, h.zip).catch(() => null).then(r => ["flood", r]));
          if (needs.includes("crime")) promises.push(fetchCrime(h.address, h.city, h.state, h.zip).catch(() => null).then(r => ["crime", r]));
          if (needs.includes("school")) promises.push(fetchSchool(h.address, h.city, h.state, h.zip).catch(() => null).then(r => ["school", r]));
          if (needs.includes("parks")) promises.push(fetchNearbyParks(h.address, h.city, h.state, h.zip, h.lat, h.lng).catch(() => null).then(r => ["parks", r]));
          if (needs.includes("groceries")) promises.push(fetchNearbyGroceries(h.lat, h.lng).catch(() => null).then(r => ["groceries", r]));

          const results = await Promise.all(promises);
          if (cancelled) return;

          const updates = {};
          for (const [type, data] of results) {
            if (type === "flood" && data?.zone) updates.flood = data;
            if (type === "crime" && data?.risk) updates.crime = data;
            if (type === "school" && data?.schoolName) updates.school = data;
            if (type === "parks" && data?.parks) updates.parks = data;
            if (type === "groceries" && data) updates.groceries = data;
          }
          if (Object.keys(updates).length > 0) {
            setHomes(prev => prev.map(ph => ph.id === h.id ? { ...ph, ...updates } : ph));
          }
        } catch (e) {
          // Skip this home on error, continue to next
        }

        // Delay between homes to avoid rate limiting
        if (!cancelled && i < homesList.length - 1) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    };

    // Snapshot current homes for iteration. Also set a safety timeout
    // in case API is unreachable (no key on Vercel).
    const safetyTimeout = setTimeout(() => { if (!cancelled) setEnrichDone(true); }, 15000);
    enrich([...homes]).then(() => { clearTimeout(safetyTimeout); if (!cancelled) setEnrichDone(true); });
    return () => { cancelled = true; clearTimeout(safetyTimeout); };
  }, []);

  const handleImport = (newHomes) => {
    setHomes((prev) => {
      const byAddr = new Map(prev.map((h) => [h.address?.toLowerCase(), h]));
      const merged = [...prev];
      for (const incoming of newHomes) {
        const key = incoming.address?.toLowerCase();
        const existing = byAddr.get(key);
        if (existing) {
          // Update Redfin-sourced fields, preserve user-entered metadata
          const idx = merged.findIndex((h) => h.id === existing.id);
          if (idx !== -1) {
            merged[idx] = {
              ...existing,
              // Redfin fields (always overwrite with fresh data)
              price: incoming.price ?? existing.price,
              beds: incoming.beds ?? existing.beds,
              baths: incoming.baths ?? existing.baths,
              sqft: incoming.sqft ?? existing.sqft,
              lotSize: incoming.lotSize ?? existing.lotSize,
              yearBuilt: incoming.yearBuilt ?? existing.yearBuilt,
              dom: incoming.dom ?? existing.dom,
              ppsf: incoming.ppsf ?? existing.ppsf,
              hoa: incoming.hoa ?? existing.hoa,
              propertyType: incoming.propertyType || existing.propertyType,
              status: incoming.status || existing.status,
              url: incoming.url || existing.url,
              city: incoming.city || existing.city,
              state: incoming.state || existing.state,
              zip: incoming.zip || existing.zip,
              address: incoming.address || existing.address,
              // User metadata preserved: id, viewed, favorite, notes, ratings, pool, appraisal, flood, crime, school
            };
          }
        } else {
          merged.push(incoming);
          byAddr.set(key, incoming);
        }
      }
      return merged;
    });
  };

  const toggleCompare = (id) => {
    setCompareList((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  const updateHome = (id, updates) => {
    setHomes((prev) => prev.map((h) => (h.id === id ? { ...h, ...updates } : h)));
    if (activeHome?.id === id) setActiveHome((prev) => ({ ...prev, ...updates }));
  };

  const openHome = (h, filteredList) => {
    setActiveHome(h);
    if (filteredList) setNavList(filteredList.map(x => x.id));
    setScreen("detail");
  };
  const goList = () => setScreen("list");

  const navigateHome = (dir) => {
    if (!activeHome || navList.length < 2) return;
    const idx = navList.indexOf(activeHome.id);
    if (idx === -1) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= navList.length) return;
    const nextHome = homes.find(h => h.id === navList[nextIdx]);
    if (nextHome) { setActiveHome(nextHome); window.scrollTo(0, 0); }
  };

  useEffect(() => {
    if (activeHome) {
      const fresh = homes.find((h) => h.id === activeHome.id);
      if (fresh) setActiveHome(fresh);
    }
  }, [homes]);

  return (
    <div className={`min-h-screen bg-stone-50 text-stone-800 pb-20 md:pb-0 overflow-x-hidden ${darkMode ? "dark" : ""}`} style={{ fontFamily: "'DM Sans', 'Inter', system-ui, -apple-system, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet" />

      {/* Desktop top nav — always visible */}
      <header className="hidden md:block border-b border-stone-200 bg-white/90 backdrop-blur-md fixed top-0 inset-x-0 z-40 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between">
          <button onClick={goList} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 flex items-center justify-center shadow-lg shadow-fuchsia-200/50">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="white"><path d="M12 3L2 12h3v8h5v-5h4v5h5v-8h3L12 3z"/></svg>
            </div>
            <h1 className="text-lg font-bold tracking-tight text-stone-800">CRIBS</h1>
            <span className="text-[10px] text-stone-400 font-medium ml-1 self-end mb-0.5">v1.2.6</span>
          </button>
          <nav className="flex gap-1 bg-stone-100 rounded-lg p-0.5 border border-stone-200">
            <button onClick={goList} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "list" || screen === "detail" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>Homes</button>
            <button onClick={() => setScreen("compare")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "compare" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
              Compare {compareList.length > 0 && <span className="ml-1 bg-violet-100 text-violet-600 text-xs px-1.5 py-0.5 rounded-full font-semibold">{compareList.length}</span>}
            </button>
            <button onClick={() => setScreen("settings")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "settings" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>Settings</button>
          </nav>
        </div>
      </header>
      <div className="hidden md:block h-16" /> {/* Spacer for fixed header */}

      <div className="max-w-[1600px] mx-auto">
        {screen === "list" && <HomeListScreen homes={homes} setHomes={setHomes} onOpenHome={openHome} compareList={compareList} toggleCompare={toggleCompare} onImport={handleImport} fin={fin} rateInfo={rateInfo} schoolFilter={schoolFilter} setSchoolFilter={setSchoolFilter} maxBudget={maxBudget} enrichDone={enrichDone} />}
        {screen === "detail" && activeHome && <HomeDetailScreen home={activeHome} onBack={goList} onUpdate={updateHome} compareList={compareList} toggleCompare={toggleCompare} fin={fin} navList={navList} onNavigate={navigateHome} allHomes={homes} soldComps={soldComps} onFilterBySchool={(name) => { setSchoolFilter(name); setScreen("list"); }} maxBudget={maxBudget} />}
        {screen === "compare" && <CompareScreen homes={homes} compareList={compareList} toggleCompare={toggleCompare} clearCompare={() => setCompareList([])} onOpenHome={openHome} fin={fin} />}
        {screen === "settings" && <SettingsScreen fin={fin} updateFin={updateFin} liveRate={liveRate} rateInfo={rateInfo} homes={homes} setHomes={setHomes} soldComps={soldComps} setSoldComps={setSoldComps} darkMode={darkMode} setDarkMode={setDarkMode} />}
      </div>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-stone-200 z-50 safe-area-pb">
        <div className="flex">
          {[
            { id: "list", label: "Homes", icon: <HomeIcon className="w-5 h-5" /> },
            { id: "compare", label: "Compare", icon: <CompareIcon className="w-5 h-5" />, badge: compareList.length },
            { id: "settings", label: "Settings", icon: <SettingsIcon className="w-5 h-5" /> },
          ].map((tab) => (
            <button key={tab.id} onClick={() => setScreen(tab.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-3 transition-colors relative ${(screen === tab.id || (screen === "detail" && tab.id === "list")) ? "text-sky-600" : "text-stone-400"}`}>
              {tab.icon}
              <span className="text-[10px] font-semibold tracking-wide">{tab.label}</span>
              {tab.badge > 0 && <span className="absolute top-1 right-1/2 translate-x-5 bg-violet-500 text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-bold pointer-events-none">{tab.badge}</span>}
            </button>
          ))}
        </div>
      </nav>

      <style>{`
        .safe-area-pb { padding-bottom: env(safe-area-inset-bottom, 0); }
        * { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        @keyframes slideInLeft { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes slideInRight { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes popIn { from { transform: scale(0.8); opacity: 0; } 60% { transform: scale(1.05); } to { transform: scale(1); opacity: 1; } }
        @keyframes growBar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes pulseSubtle { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .anim-fade-up { animation: fadeUp 0.35s ease-out forwards; }
        .anim-fade-in { animation: fadeIn 0.3s ease-out forwards; }
        .anim-scale-in { animation: scaleIn 0.3s ease-out forwards; }
        .anim-slide-left { animation: slideInLeft 0.3s ease-out forwards; }
        .anim-slide-right { animation: slideInRight 0.3s ease-out forwards; }
        .anim-pop { animation: popIn 0.35s ease-out forwards; }
        .anim-grow-bar { animation: growBar 0.8s ease-out forwards; transform-origin: left; }
        .anim-pulse { animation: pulseSubtle 2s ease-in-out infinite; }
        .star-tap { transition: transform 0.15s ease; }
        .star-tap:active { transform: scale(1.3); }
        @media (hover: hover) {
          .card-hover { transition: transform 0.2s ease, box-shadow 0.2s ease; }
          .card-hover:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
        }
        .check-pop { transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .check-pop:active { transform: scale(0.85); }
        .slide-exit-left { transform: translateX(-100%) !important; opacity: 0 !important; transition: transform 0.2s ease-in, opacity 0.15s ease-in !important; }
        .slide-exit-right { transform: translateX(100%) !important; opacity: 0 !important; transition: transform 0.2s ease-in, opacity 0.15s ease-in !important; }
        .slide-enter-right { animation: slideFromRight 0.3s ease-out both; }
        .slide-enter-left { animation: slideFromLeft 0.3s ease-out both; }
        .slide-enter-fade { animation: fadeIn 0.25s ease-out both; }
        @keyframes slideFromRight { from { transform: translateX(35%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideFromLeft { from { transform: translateX(-35%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

        /* ═══ Dark Mode Overrides ═══════════════════════════════════════
         * Surfaces: #0c0a09 → #1c1917 → #292524
         * Text contrast on #1c1917: primary ≥7:1, secondary ≥5:1, muted ≥4.5:1
         * All colored text lightened to ≥4.5:1 contrast
         * ═══════════════════════════════════════════════════════════════ */
        .dark { color-scheme: dark; }

        /* ─── Surface backgrounds ─────────────────────────────────── */
        .dark.bg-stone-50, .dark .bg-stone-50 { background-color: #0c0a09 !important; }
        .dark .bg-stone-50\\/50 { background-color: rgba(12,10,9,0.5) !important; }
        .dark .bg-stone-50\\/60 { background-color: rgba(12,10,9,0.6) !important; }
        .dark .bg-stone-50\\/80 { background-color: rgba(12,10,9,0.8) !important; }
        .dark .bg-white { background-color: #1c1917 !important; }
        .dark .bg-white\\/80 { background-color: rgba(28,25,23,0.85) !important; }
        .dark .bg-white\\/90 { background-color: rgba(28,25,23,0.95) !important; }
        .dark .bg-white\\/95 { background-color: rgba(28,25,23,0.97) !important; }
        .dark .bg-white\\/60 { background-color: rgba(28,25,23,0.65) !important; }
        .dark .bg-stone-100, .dark .bg-stone-100\\/50 { background-color: #292524 !important; }
        .dark .bg-stone-200 { background-color: #44403c !important; }
        .dark .bg-stone-300 { background-color: #57534e !important; }

        /* ─── Neutral text — WCAG AA on #1c1917 ──────────────────── */
        .dark .text-stone-900, .dark.text-stone-900 { color: #fafaf9 !important; }
        .dark .text-stone-800, .dark.text-stone-800 { color: #e7e5e4 !important; }
        .dark .text-stone-700 { color: #d6d3d1 !important; }
        .dark .text-stone-600 { color: #a8a29e !important; }
        .dark .text-stone-500 { color: #a8a29e !important; }
        .dark .text-stone-400 { color: #87817b !important; }
        .dark .text-stone-300 { color: #57534e !important; }
        .dark .text-stone-200 { color: #44403c !important; }

        /* ─── Sky — info, low risk, navigation ───────────────────── */
        .dark .text-sky-400 { color: #38bdf8 !important; }
        .dark .text-sky-500 { color: #38bdf8 !important; }
        .dark .text-sky-600 { color: #38bdf8 !important; }
        .dark .text-sky-700 { color: #38bdf8 !important; }
        .dark .bg-sky-50 { background-color: rgba(56,189,248,0.08) !important; }
        .dark .bg-sky-50\\/50 { background-color: rgba(56,189,248,0.05) !important; }
        .dark .bg-sky-50\\/30 { background-color: rgba(56,189,248,0.04) !important; }
        .dark .bg-sky-50\\/40 { background-color: rgba(56,189,248,0.05) !important; }
        .dark .bg-sky-100 { background-color: rgba(56,189,248,0.12) !important; }
        .dark .bg-sky-100\\/40 { background-color: rgba(56,189,248,0.10) !important; }
        .dark .bg-sky-100\\/50 { background-color: rgba(56,189,248,0.10) !important; }
        .dark .bg-sky-100\\/70 { background-color: rgba(56,189,248,0.14) !important; }
        .dark .bg-sky-200, .dark .bg-sky-200\\/70 { background-color: rgba(56,189,248,0.18) !important; }
        .dark .border-sky-200 { border-color: rgba(56,189,248,0.20) !important; }
        .dark .border-sky-200\\/50 { border-color: rgba(56,189,248,0.15) !important; }
        .dark .border-sky-200\\/80 { border-color: rgba(56,189,248,0.22) !important; }
        .dark .border-sky-300 { border-color: rgba(56,189,248,0.25) !important; }
        .dark .border-sky-400 { border-color: rgba(56,189,248,0.35) !important; }
        .dark .border-l-sky-400 { border-left-color: rgba(56,189,248,0.5) !important; }

        /* ─── Amber — moderate risk, caution, ratings ────────────── */
        .dark .text-amber-200 { color: #fde68a !important; }
        .dark .text-amber-300 { color: #fcd34d !important; }
        .dark .text-amber-400 { color: #fbbf24 !important; }
        .dark .text-amber-500 { color: #fbbf24 !important; }
        .dark .text-amber-600 { color: #fbbf24 !important; }
        .dark .text-amber-700 { color: #f59e0b !important; }
        .dark .bg-amber-50 { background-color: rgba(251,191,36,0.08) !important; }
        .dark .bg-amber-50\\/50 { background-color: rgba(251,191,36,0.06) !important; }
        .dark .bg-amber-100 { background-color: rgba(251,191,36,0.12) !important; }
        .dark .bg-amber-100\\/30 { background-color: rgba(251,191,36,0.08) !important; }
        .dark .bg-amber-100\\/40 { background-color: rgba(251,191,36,0.10) !important; }
        .dark .bg-amber-100\\/50 { background-color: rgba(251,191,36,0.11) !important; }
        .dark .border-amber-200 { border-color: rgba(251,191,36,0.20) !important; }
        .dark .border-amber-200\\/50 { border-color: rgba(251,191,36,0.15) !important; }
        .dark .border-amber-200\\/60 { border-color: rgba(251,191,36,0.18) !important; }

        /* ─── Orange — high risk, warnings, over budget ──────────── */
        .dark .text-orange-500 { color: #fb923c !important; }
        .dark .text-orange-600 { color: #fb923c !important; }
        .dark .text-orange-700 { color: #fb923c !important; }
        .dark .bg-orange-50 { background-color: rgba(251,146,60,0.08) !important; }
        .dark .bg-orange-50\\/50 { background-color: rgba(251,146,60,0.06) !important; }
        .dark .bg-orange-100 { background-color: rgba(251,146,60,0.12) !important; }
        .dark .bg-orange-100\\/40 { background-color: rgba(251,146,60,0.10) !important; }
        .dark .bg-orange-100\\/50 { background-color: rgba(251,146,60,0.11) !important; }
        .dark .bg-orange-100\\/60 { background-color: rgba(251,146,60,0.12) !important; }
        .dark .border-orange-200 { border-color: rgba(251,146,60,0.20) !important; }
        .dark .border-orange-200\\/50 { border-color: rgba(251,146,60,0.15) !important; }

        /* ─── Teal — positive status, in budget, parks ───────────── */
        .dark .text-teal-500 { color: #2dd4bf !important; }
        .dark .text-teal-600 { color: #2dd4bf !important; }
        .dark .text-teal-700 { color: #2dd4bf !important; }
        .dark .bg-teal-50 { background-color: rgba(45,212,191,0.08) !important; }
        .dark .bg-teal-50\\/50 { background-color: rgba(45,212,191,0.05) !important; }
        .dark .bg-teal-50\\/40 { background-color: rgba(45,212,191,0.05) !important; }
        .dark .bg-teal-100 { background-color: rgba(45,212,191,0.12) !important; }
        .dark .border-teal-200 { border-color: rgba(45,212,191,0.20) !important; }
        .dark .border-teal-200\\/50 { border-color: rgba(45,212,191,0.15) !important; }
        .dark .border-teal-500 { border-color: rgba(45,212,191,0.40) !important; }

        /* ─── Emerald — parks excellent ──────────────────────────── */
        .dark .text-emerald-500 { color: #34d399 !important; }
        .dark .text-emerald-600 { color: #34d399 !important; }
        .dark .text-emerald-700 { color: #34d399 !important; }
        .dark .bg-emerald-50 { background-color: rgba(52,211,153,0.08) !important; }
        .dark .bg-emerald-50\\/50 { background-color: rgba(52,211,153,0.06) !important; }
        .dark .bg-emerald-100 { background-color: rgba(52,211,153,0.12) !important; }
        .dark .border-emerald-200 { border-color: rgba(52,211,153,0.20) !important; }

        /* ─── Violet — compare, UI accents ───────────────────────── */
        .dark .text-violet-400 { color: #a78bfa !important; }
        .dark .text-violet-500 { color: #a78bfa !important; }
        .dark .text-violet-600 { color: #a78bfa !important; }
        .dark .text-violet-700 { color: #a78bfa !important; }
        .dark .text-violet-800 { color: #a78bfa !important; }
        .dark .bg-violet-50 { background-color: rgba(167,139,250,0.08) !important; }
        .dark .bg-violet-50\\/50 { background-color: rgba(167,139,250,0.06) !important; }
        .dark .bg-violet-100 { background-color: rgba(167,139,250,0.12) !important; }
        .dark .border-violet-200 { border-color: rgba(167,139,250,0.20) !important; }
        .dark .border-violet-200\\/50 { border-color: rgba(167,139,250,0.15) !important; }
        .dark .border-violet-300 { border-color: rgba(167,139,250,0.30) !important; }
        .dark .border-violet-500 { border-color: rgba(167,139,250,0.40) !important; }

        /* ─── Red — recording, alerts, H-E-B ─────────────────────── */
        .dark .text-red-500 { color: #f87171 !important; }
        .dark .text-red-600 { color: #f87171 !important; }
        .dark .text-red-700 { color: #f87171 !important; }
        .dark .bg-red-50 { background-color: rgba(248,113,113,0.08) !important; }
        .dark .bg-red-100 { background-color: rgba(248,113,113,0.12) !important; }
        .dark .border-red-200 { border-color: rgba(248,113,113,0.20) !important; }

        /* ─── Blue — Costco ──────────────────────────────────────── */
        .dark .text-blue-600 { color: #60a5fa !important; }
        .dark .bg-blue-50 { background-color: rgba(96,165,250,0.08) !important; }

        /* ─── Green — Whole Foods ─────────────────────────────────── */
        .dark .text-green-700 { color: #4ade80 !important; }
        .dark .bg-green-50 { background-color: rgba(74,222,128,0.08) !important; }

        /* ─── Neutral borders ────────────────────────────────────── */
        .dark .border-stone-100 { border-color: #1c1917 !important; }
        .dark .border-stone-200 { border-color: #292524 !important; }
        .dark .border-b.border-stone-200 { border-color: #292524 !important; }
        .dark .border-stone-300 { border-color: #44403c !important; }
        .dark .border-stone-400 { border-color: #57534e !important; }
        .dark .divide-stone-100 > * + * { border-color: #292524 !important; }
        .dark .border-t.border-stone-100 { border-color: #292524 !important; }
        .dark .border-dashed.border-stone-200 { border-color: #44403c !important; }

        /* ─── Cards & gradients ──────────────────────────────────── */
        .dark .bg-gradient-to-r.from-stone-50 { background: #1c1917 !important; }
        .dark .bg-gradient-to-br.from-stone-50 { background: #1c1917 !important; }
        .dark .bg-gradient-to-r.from-violet-50, .dark .bg-gradient-to-r.from-violet-50.to-fuchsia-50\\/50 { background: rgba(167,139,250,0.06) !important; }
        .dark .bg-gradient-to-br.from-sky-50, .dark .bg-gradient-to-br.from-sky-50.via-blue-50 { background: rgba(56,189,248,0.05) !important; }

        /* ─── Inputs ─────────────────────────────────────────────── */
        .dark input, .dark textarea, .dark select { background-color: #292524 !important; color: #e7e5e4 !important; border-color: #44403c !important; }
        .dark input::placeholder, .dark textarea::placeholder { color: #78716c !important; }

        /* ─── Hover states ───────────────────────────────────────── */
        .dark .hover\\:bg-sky-50\\/30:hover { background-color: rgba(56,189,248,0.06) !important; }
        .dark .hover\\:bg-violet-50\\/50:hover { background-color: rgba(167,139,250,0.08) !important; }
        .dark .hover\\:bg-orange-50:hover { background-color: rgba(251,146,60,0.08) !important; }
        .dark .hover\\:bg-stone-100:hover { background-color: #292524 !important; }
        .dark .hover\\:border-stone-300:hover { border-color: #57534e !important; }
        .dark .hover\\:border-stone-400:hover { border-color: #78716c !important; }
        .dark .hover\\:border-violet-300:hover { border-color: rgba(167,139,250,0.35) !important; }
        .dark .hover\\:text-stone-600:hover { color: #d6d3d1 !important; }
        .dark .hover\\:text-stone-700:hover { color: #e7e5e4 !important; }
        .dark .hover\\:text-amber-200:hover { color: #fde68a !important; }

        /* ─── Active states ──────────────────────────────────────── */
        .dark .active\\:bg-stone-200:active { background-color: #44403c !important; }
        .dark .active\\:bg-violet-50:active { background-color: rgba(167,139,250,0.10) !important; }
        .dark .active\\:bg-orange-100:active { background-color: rgba(251,146,60,0.12) !important; }
        .dark .active\\:bg-sky-200:active { background-color: rgba(56,189,248,0.15) !important; }

        /* ─── Nav & chrome ───────────────────────────────────────── */
        .dark nav .bg-stone-100 { background-color: #292524 !important; }
        .dark .shadow-sm { box-shadow: 0 1px 2px rgba(0,0,0,0.4) !important; }
        .dark .shadow-lg { box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5) !important; }
        .dark .backdrop-blur-md { backdrop-filter: blur(12px); }
        .dark .card-hover:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.4); }

        /* ─── Ring utilities ─────────────────────────────────────── */
        .dark .ring-1.ring-sky-100 { --tw-ring-color: rgba(56,189,248,0.15) !important; }
        .dark .ring-1.ring-violet-300 { --tw-ring-color: rgba(167,139,250,0.25) !important; }

        /* ─── Scrollbar ──────────────────────────────────────────── */
        .dark ::-webkit-scrollbar { background: #0c0a09; }
        .dark ::-webkit-scrollbar-thumb { background: #44403c; border-radius: 4px; }      `}</style>
    </div>
  );
}
