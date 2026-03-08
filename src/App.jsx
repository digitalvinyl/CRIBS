import React, { useState, useMemo, useRef, useEffect, Component, createElement } from "react";

/* ─── Supabase Cloud Sync ─────────────────────────────────────────── */

const SUPABASE_URL = "https://edhsfcjtafiadjzjahko.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkaHNmY2p0YWZpYWRqemphaGtvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDE5MzcsImV4cCI6MjA4ODQ3NzkzN30.jrPyZP_BSYe2tZ2NS2WknLNkZHQNTHV0rtTYLeoC4x8";
const SUPA_HEADERS = { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" };
const SUPA_ENABLED = SUPABASE_KEY.length > 20;

// Cloud keys to sync (others stay localStorage-only)
const CLOUD_KEYS = ["cribs_homes", "cribs_fin", "cribs_sold_comps", "cribs_tour_days", "cribs_tour_notes", "cribs_user_data"];

async function supaGet(key) {
  if (!SUPA_ENABLED) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cribs_data?key=eq.${encodeURIComponent(key)}&select=value`, {
      headers: SUPA_HEADERS, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.value ?? null;
  } catch { return null; }
}

async function supaSet(key, value) {
  if (!SUPA_ENABLED) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cribs_data`, {
      method: "POST",
      headers: { ...SUPA_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* silent fail — localStorage is the fallback */ }
}

async function supaGetAll() {
  if (!SUPA_ENABLED) return {};
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cribs_data?select=key,value`, {
      headers: SUPA_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.warn("CRIBS cloud fetch failed:", res.status); return {}; }
    const text = await res.text();
    if (!text || text[0] !== "[") return {};
    const rows = JSON.parse(text);
    const result = {};
    for (const row of rows) { if (row && row.key) result[row.key] = row.value; }
    return result;
  } catch (e) { console.warn("CRIBS cloud getAll error:", e); return {}; }
}

// Debounced cloud saver — batches saves within 2 seconds
const _supaPending = {};
let _supaTimer = null;
function supaSetDebounced(key, value) {
  // Always save to localStorage immediately
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  if (!SUPA_ENABLED) return;
  _supaPending[key] = value;
  if (_supaTimer) clearTimeout(_supaTimer);
  _supaTimer = setTimeout(() => {
    const batch = { ..._supaPending };
    for (const k in _supaPending) delete _supaPending[k];
    for (const [k, v] of Object.entries(batch)) supaSet(k, v);
  }, 2000);
}

/* ─── Helpers ────────────────────────────────────────────────────── */

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return createElement('div', { className: 'p-6 max-w-xl mx-auto mt-20 text-center' },
        createElement('div', { className: 'bg-red-50 border border-red-200 rounded-2xl p-6' },
          createElement('h2', { className: 'text-lg font-bold text-red-600 mb-2' }, 'Something went wrong'),
          createElement('p', { className: 'text-sm text-stone-600 mb-3' }, String(this.state.error?.message || this.state.error)),
          createElement('button', { className: 'px-4 py-2 bg-sky-500 text-white rounded-xl text-sm font-medium', onClick: () => this.setState({ error: null }) }, 'Try Again')
        )
      );
    }
    return this.props.children;
  }
}

const fmt = (n) => (n != null && !isNaN(n) ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
const fmtC = (n) => (n != null && !isNaN(n) ? (Math.abs(n) >= 1e6 ? "$" + (n / 1e6).toFixed(3) + "M" : fmt(n)) : "—");
const fmtNum = (n) => (n != null && !isNaN(n) ? Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
const fmtShort = (n) => { if (n == null || isNaN(n)) return "—"; if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K"; return "$" + n; };
const parseNum = (v) => { if (v == null || v === "") return null; const n = parseFloat(String(v).replace(/[$,%\s]/g, "")); return isNaN(n) ? null : n; };
const normalizeAddr = (a) => (a || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
  soldDate: ["SOLD DATE"],
  nextOpenHouseStart: ["NEXT OPEN HOUSE START TIME", "NEXT OPEN HOUSE DATE"],
  nextOpenHouseEnd: ["NEXT OPEN HOUSE END TIME"],
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


async function fetchAppraisal(address, city, state, lat, lng) {
  // Primary: HCAD ArcGIS REST API (Harris County parcels with appraisal values)
  if (lat && lng) {
    try {
      const url = `https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=total_appraised_val,total_market_val,tax_year,acct_num&returnGeometry=false&f=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (data.features?.length > 0) {
        const f = data.features[0].attributes;
        const val = f.total_appraised_val || f.total_market_val;
        const year = f.tax_year ? parseInt(f.tax_year) : new Date().getFullYear();
        if (val && val > 0) {
          return { appraisalValue: val, appraisalYear: year, source: "HCAD (Harris County Appraisal District)", marketValue: f.total_market_val || null, acctNum: f.acct_num || null };
        }
      }
    } catch (e) { /* HCAD query failed, fall through */ }
  }
  return null;
}

async function fetchFloodZone(address, city, state, zip, lat, lng) {
  let fLat = lat, fLng = lng;
  if (!fLat || !fLng) {
    try {
      const q = encodeURIComponent(`${address}, ${city}, ${state} ${zip || ""}`);
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { "User-Agent": "CRIBSApp/1.0" }, signal: AbortSignal.timeout(6000) });
      const geoData = await geoRes.json();
      if (geoData?.[0]) { fLat = parseFloat(geoData[0].lat); fLng = parseFloat(geoData[0].lon); }
    } catch (e) { /* geocode failed */ }
  }
  if (!fLat || !fLng) return null;
  try {
    const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=${fLng},${fLat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.features?.length > 0) {
      const f = data.features[0].attributes;
      const zone = f.FLD_ZONE || "X";
      const isSFHA = f.SFHA_TF === "T";
      const subType = f.ZONE_SUBTY || "";
      let risk = "low", zoneDesc = "Minimal Flood Hazard";
      if (["A", "AE", "AH", "AO", "AR", "A99", "V", "VE"].includes(zone)) {
        risk = "high"; zoneDesc = zone.startsWith("V") ? "Coastal High Hazard (100-yr)" : "100-Year Floodplain";
      } else if (zone === "X" && subType.includes("0.2")) {
        risk = "moderate"; zoneDesc = "500-Year Floodplain (0.2% annual)";
      } else if (zone === "D") {
        risk = "moderate"; zoneDesc = "Undetermined Risk";
      }
      return { zone, zoneDesc, risk, panel: null, notes: isSFHA ? "In Special Flood Hazard Area — flood insurance likely required" : subType || null };
    }
    return { zone: "X", zoneDesc: "Minimal Flood Hazard (outside SFHA)", risk: "low", panel: null, notes: "Not in a FEMA-mapped flood zone" };
  } catch (e) { /* FEMA query failed */ }
  return null;
}

async function fetchCrime(address, city, state, zip, lat, lng) {
  let cLat = lat, cLng = lng;
  if (!cLat || !cLng) {
    try {
      const q = encodeURIComponent(`${address}, ${city}, ${state} ${zip || ""}`);
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { "User-Agent": "CRIBSApp/1.0" }, signal: AbortSignal.timeout(6000) });
      const geoData = await geoRes.json();
      if (geoData?.[0]) { cLat = parseFloat(geoData[0].lat); cLng = parseFloat(geoData[0].lon); }
    } catch (e) { /* geocode failed */ }
  }
  if (!cLat || !cLng) return null;
  try {
    // Houston PD open data via Socrata — count incidents within ~1 mile in last 12 months
    const radiusM = 1609;
    const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const url = `https://data.houstontx.gov/resource/59im-jpte.json?$where=within_circle(geolocation,${cLat},${cLng},${radiusM}) AND date > '${oneYearAgo}'&$select=count(*) as total,offense_type&$group=offense_type&$order=total DESC&$limit=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "Accept": "application/json" } });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const total = rows.reduce((s, r) => s + parseInt(r.total || 0, 10), 0);
        const violent = rows.filter(r => /assault|robbery|murder|homicide|rape|kidnap/i.test(r.offense_type || "")).reduce((s, r) => s + parseInt(r.total || 0, 10), 0);
        const property = rows.filter(r => /theft|burglary|auto.theft|arson|shoplifting/i.test(r.offense_type || "")).reduce((s, r) => s + parseInt(r.total || 0, 10), 0);
        const topConcerns = rows.slice(0, 3).map(r => r.offense_type).filter(Boolean);
        const estPop = 8;
        const violentPerK = Math.round(violent / estPop * 10) / 10;
        const propertyPerK = Math.round(property / estPop * 10) / 10;
        let risk = "low", grade = "B+";
        if (violentPerK >= 6 || total > 1200) { risk = "high"; grade = violent > 80 ? "F" : "D"; }
        else if (violentPerK >= 3 || total > 600) { risk = "moderate"; grade = violentPerK >= 4.5 ? "C-" : "C+"; }
        else if (total < 200) { grade = "A"; }
        else if (total < 400) { grade = "A-"; }
        else { grade = "B"; }
        return { risk, grade, violentPerK, propertyPerK, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns, source: "Houston PD Open Data", notes: `${total} incidents within 1 mi in past year` };
      }
    }
  } catch (e) { /* HPD query failed */ }
  // ZIP-based fallback
  try {
    const zipNum = parseInt(zip, 10);
    const low = [77024, 77079, 77055, 77056, 77027, 77005, 77025, 77030, 77401, 77459, 77494, 77450, 77479, 77043, 77077, 77063];
    const high = [77026, 77028, 77029, 77051, 77033, 77047, 77061, 77087, 77093, 77016, 77020, 77039, 77078];
    if (low.includes(zipNum)) return { risk: "low", grade: "A-", violentPerK: 2.1, propertyPerK: 12.0, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Theft", "Burglary"], source: "ZIP Estimate", notes: "Low-crime area" };
    if (high.includes(zipNum)) return { risk: "high", grade: "D", violentPerK: 8.5, propertyPerK: 32.0, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Assault", "Theft", "Burglary"], source: "ZIP Estimate", notes: "Higher-crime area" };
    return { risk: "moderate", grade: "C+", violentPerK: 4.2, propertyPerK: 20.0, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Theft", "Auto Theft"], source: "ZIP Estimate", notes: "Average crime for Houston metro" };
  } catch (e) { /* fallback failed */ }
  return null;
}

async function fetchSchool(address, city, state, zip, lat, lng) {
  // NCES EDGE 2022-23 ArcGIS REST API — find nearest elementary schools
  if (!lat || !lng) return null;
  try {
    const fields = "SCH_NAME,LEA_NAME,GSLO,GSHI,SCHOOL_LEVEL,MEMBER,STUTERATIO,FTE,TOTFRL,LATCOD,LONCOD,CHARTER_TEXT,VIRTUAL,LSTREET1,LCITY,LZIP,STATUS";
    const where = encodeURIComponent("SCHOOL_LEVEL='Elementary' AND STATUS='1'");
    const url = `https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_ADMINDATA_PUBLICSCH_2223/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4269&spatialRel=esriSpatialRelIntersects&distance=8046&units=esriSRUnit_Meter&where=${where}&outFields=${fields}&returnGeometry=false&resultRecordCount=5&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    if (data.features?.length > 0) {
      // Calculate distances and pick nearest
      const toRad = (d) => d * Math.PI / 180;
      const haversine = (lat1, lng1, lat2, lng2) => {
        const R = 3958.8; // miles
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const schools = data.features
        .map(f => ({ ...f.attributes, dist: haversine(lat, lng, f.attributes.LATCOD, f.attributes.LONCOD) }))
        .filter(s => s.VIRTUAL !== 'Virtual' && s.CHARTER_TEXT !== 'Yes')
        .sort((a, b) => a.dist - b.dist);
      if (schools.length === 0) return null;
      const s = schools[0];
      const enrollment = s.MEMBER || null;
      const str = s.STUTERATIO || (s.FTE && enrollment ? Math.round(enrollment / s.FTE) : null);
      const frlPct = (enrollment && s.TOTFRL) ? Math.round(s.TOTFRL / enrollment * 100) : null;
      // Derive tier from student-teacher ratio
      let tier = "good";
      if (str && str <= 14) tier = "great";
      else if (str && str > 20) tier = "below";
      // Grade range
      const gradeMap = { 'PK': 'PK', 'KG': 'K', '01': '1', '02': '2', '03': '3', '04': '4', '05': '5', '06': '6', '07': '7', '08': '8' };
      const lo = gradeMap[s.GSLO] || s.GSLO || '';
      const hi = gradeMap[s.GSHI] || s.GSHI || '';
      const grades = lo && hi ? `${lo}-${hi}` : null;
      return {
        schoolName: s.SCH_NAME || null,
        district: s.LEA_NAME || null,
        rating: null,
        ratingSource: null,
        tier,
        grades,
        enrollment,
        distance: s.dist ? s.dist.toFixed(1) + " mi" : null,
        nicheGrade: null,
        testScores: null,
        studentTeacherRatio: str ? Math.round(str) : null,
        notes: `NCES CCD 2022-23${frlPct != null ? " · " + frlPct + "% free/reduced lunch" : ""}`,
      };
    }
  } catch (e) { /* NCES query failed */ }
  return null;
}

async function fetchNearbyParks(address, city, state, zip, lat, lng) {
  if (!lat || !lng) return generateParks(lat, lng);

  // 1) Start with curated static parks
  const staticResult = generateParks(lat, lng);
  const staticParks = staticResult?.parks || [];
  const seenNames = new Set(staticParks.map(p => p.name.toLowerCase()));

  // 2) Supplement with Overpass — tight filters to exclude junk
  try {
    const radius = 2414; // 1.5 miles in meters
    // Only ways/relations (areas) with leisure=park that have a name — skip nodes (usually POI pins, not real parks)
    const query = `[out:json][timeout:8];(way["leisure"="park"]["name"](around:${radius},${lat},${lng});relation["leisure"="park"]["name"](around:${radius},${lat},${lng}););out center qt 60;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    if (data.elements && Array.isArray(data.elements)) {
      // Junk name patterns to exclude
      const junkPatterns = /apartment|condos?|townhome|residence|complex|hoa|courtyard|median|esplanade|office|plaza|shopping|center|commercial|industrial|retention|detention|easement/i;

      for (const el of data.elements) {
        const name = el.tags?.name;
        if (!name || name.length < 3) continue;
        if (junkPatterns.test(name)) continue;
        // Skip if access is private
        if (el.tags?.access === "private" || el.tags?.access === "no") continue;
        // Skip unnamed leisure areas tagged inside residential
        if (el.tags?.landuse === "residential") continue;

        const elLat = el.center?.lat;
        const elLng = el.center?.lon;
        if (!elLat || !elLng) continue;

        // Dedupe against static parks (fuzzy match)
        const nameLower = name.toLowerCase();
        if (seenNames.has(nameLower)) continue;
        // Also check partial matches (e.g. "Memorial Park" vs "Memorial Park Trails")
        let isDupe = false;
        for (const sn of seenNames) {
          if (nameLower.includes(sn) || sn.includes(nameLower)) { isDupe = true; break; }
        }
        if (isDupe) continue;

        const dist = haversine(lat, lng, elLat, elLng);
        if (dist > 3.1) continue;

        seenNames.add(nameLower);

        // Determine type from tags
        let type = "Park";
        const tags = el.tags || {};
        if (tags.leisure === "nature_reserve") type = "Nature Preserve";
        else if (tags.leisure === "garden" || tags.garden) type = "Garden";

        // Estimate acres from way_area
        let acres = null;
        if (tags.way_area) acres = Math.round(parseFloat(tags.way_area) * 0.000247105 * 10) / 10;

        // Extract amenities
        const amenities = [];
        if (tags.sport) amenities.push(...tags.sport.split(";").map(s => s.trim()));
        if (tags.playground === "yes" || tags.leisure === "playground") amenities.push("Playground");
        if (tags.dog === "yes" || tags.dogs === "yes") amenities.push("Dog park");
        if (tags.lit === "yes") amenities.push("Lit paths");

        staticParks.push({
          name, lat: elLat, lng: elLng,
          distanceMi: Math.round(dist * 100) / 100,
          type, acres, amenities: [...new Set(amenities)].slice(0, 5),
          source: "osm",
        });
      }
    }
  } catch (e) { /* Overpass failed — static results still available */ }

  // 3) Re-sort and rebuild result
  staticParks.sort((a, b) => a.distanceMi - b.distanceMi);
  const top = staticParks.slice(0, 4);
  const count = staticParks.length;
  const nearest = top[0] || null;

  let hasTrailFlag = false, hasPlaygroundFlag = false;
  for (const p of staticParks) {
    if (p.type === "Trail" || (p.amenities && p.amenities.some(a => a.toLowerCase().includes("trail")))) hasTrailFlag = true;
    if (p.amenities && p.amenities.some(a => a.toLowerCase().includes("playground"))) hasPlaygroundFlag = true;
  }

  const score = count >= 4 ? "excellent" : count >= 2 ? "good" : count >= 1 ? "fair" : "poor";
  return {
    parks: top,
    nearestParkName: nearest?.name || null,
    nearestDistanceMi: nearest?.distanceMi ?? null,
    parkCount1Mi: staticParks.filter(p => p.distanceMi <= 1.05).length,
    hasTrail: hasTrailFlag,
    hasPlayground: hasPlaygroundFlag,
    greenSpaceScore: score,
    notes: count > 0 ? `${count} parks within 3 miles. Nearest: ${nearest?.name} (${nearest?.distanceMi} mi).` : "No parks found within 3 miles.",
  };
}

// Known Spring Branch / Memorial area parks for instant distance calc
// Static parks database — Google Places verified coordinates, March 2025
const HOUSTON_PARKS = [
  // Major parks (>100 acres)
  { name: "Memorial Park", lat: 29.7667, lng: -95.441, type: "Park", acres: 1500, amenities: ["Trails", "Golf", "Tennis", "Playground"] },
  { name: "Hermann Park", lat: 29.7136, lng: -95.3893, type: "Park", acres: 445, amenities: ["Trails", "Playground", "Garden", "Lake"] },
  { name: "Buffalo Bayou Park", lat: 29.7631, lng: -95.3761, type: "Park", acres: 160, amenities: ["Trails", "Dog park", "Playground", "Kayak"] },
  { name: "Terry Hershey Park", lat: 29.7818, lng: -95.6237, type: "Park", acres: 500, amenities: ["Trails", "Cycling", "Playground"] },
  { name: "Bear Creek Pioneers Park", lat: 29.8252, lng: -95.627, type: "Park", acres: 2154, amenities: ["Trails", "Playground", "BBQ", "Aviary"] },
  { name: "George Bush Park", lat: 29.7458, lng: -95.6801, type: "Park", acres: 7800, amenities: ["Trails", "Cycling", "Sports fields"] },
  { name: "Cullen Park", lat: 29.8009, lng: -95.695, type: "Park", acres: 9300, amenities: ["Trails", "Cycling", "Playground"] },
  { name: "Tom Bass Regional Park", lat: 29.5897, lng: -95.3564, type: "Park", acres: 854, amenities: ["Trails", "Pool", "Tennis"] },
  { name: "Addicks Reservoir", lat: 29.8118, lng: -95.6146, type: "Nature Preserve", acres: 26000, amenities: ["Trails", "Cycling", "Wildlife"] },

  // Mid-size parks (10-100 acres)
  { name: "Discovery Green", lat: 29.7531, lng: -95.3596, type: "Park", acres: 12, amenities: ["Playground", "Events", "Lake", "Dog park"] },
  { name: "Levy Park", lat: 29.7327, lng: -95.4233, type: "Park", acres: 6, amenities: ["Playground", "Dog park", "Mini golf"] },
  { name: "Spotts Park", lat: 29.7652, lng: -95.3959, type: "Park", acres: 16, amenities: ["Basketball", "Volleyball", "Playground"] },
  { name: "Stude Park", lat: 29.7795, lng: -95.3838, type: "Park", acres: 12, amenities: ["Trails", "Playground", "Pool"] },
  { name: "Eleanor Tinsley Park", lat: 29.7623, lng: -95.3792, type: "Park", acres: 20, amenities: ["Trails", "Skyline views"] },
  { name: "Emancipation Park", lat: 29.7352, lng: -95.3656, type: "Park", acres: 11, amenities: ["Pool", "Tennis", "Basketball"] },
  { name: "Evelyn's Park", lat: 29.7066, lng: -95.4504, type: "Park", acres: 5, amenities: ["Playground", "Splash pad", "Café"] },
  { name: "T.C. Jester Park", lat: 29.8251, lng: -95.4547, type: "Park", acres: 25, amenities: ["Disc golf", "Pool", "Dog park", "Trails"] },
  { name: "Donovan Park", lat: 29.7837, lng: -95.3971, type: "Park", acres: 3, amenities: ["Playground"] },

  // Nature preserves & sanctuaries
  { name: "Houston Arboretum", lat: 29.7652, lng: -95.4521, type: "Nature Preserve", acres: 155, amenities: ["Trails", "Nature center", "Wildlife"] },
  { name: "Edith L. Moore Nature Sanctuary", lat: 29.7707, lng: -95.5683, type: "Nature Preserve", acres: 17, amenities: ["Trails", "Birding", "Wildlife"] },

  // Spring Branch / Memorial area neighborhood parks
  { name: "Nottingham Park", lat: 29.7759, lng: -95.5971, type: "Park", acres: 60, amenities: ["Splash pad", "Trails", "Disc golf", "Tennis"] },
  { name: "Bendwood Park", lat: 29.777, lng: -95.5568, type: "Park", acres: 12, amenities: ["Tennis", "Basketball", "Playground"] },
  { name: "Spring Valley Village Park", lat: 29.7876, lng: -95.5149, type: "Park", acres: 5, amenities: ["Playground", "Pavilion"] },
  { name: "Nob Hill Park", lat: 29.803, lng: -95.5516, type: "Park", acres: 15, amenities: ["Trails", "Playground", "Sports fields"] },
  { name: "James W. Lee Park", lat: 29.8277, lng: -95.5154, type: "Park", acres: 4, amenities: ["Playground", "Trails"] },
  { name: "Tanglewood Park", lat: 29.7616, lng: -95.4804, type: "Park", acres: 8, amenities: ["Tennis", "Dog park", "Playground"] },
  { name: "Binglewood Park", lat: 29.8035, lng: -95.4902, type: "Park", acres: 4, amenities: ["Playground", "Pavilion"] },
  { name: "Spring Branch Park", lat: 29.7942, lng: -95.4865, type: "Park", acres: 3, amenities: ["Playground"] },

  // Heights / Garden Oaks / Oak Forest
  { name: "Candlelight Park", lat: 29.8435, lng: -95.4329, type: "Park", acres: 5, amenities: ["Playground", "Tennis", "Pool"] },
  { name: "Oak Forest Park", lat: 29.8382, lng: -95.4513, type: "Park", acres: 8, amenities: ["Playground", "Pool", "Sports fields"] },
  { name: "Jaycee Park", lat: 29.8245, lng: -95.43, type: "Park", acres: 3, amenities: ["Playground", "Basketball"] },
  { name: "Love Park", lat: 29.7931, lng: -95.4165, type: "Park", acres: 2, amenities: ["Playground"] },

  // Galleria / West U / Bellaire
  { name: "Grady Park", lat: 29.7254, lng: -95.432, type: "Park", acres: 2, amenities: ["Playground", "Pool"] },
  { name: "Colonial Park", lat: 29.715, lng: -95.449, type: "Park", acres: 3, amenities: ["Pool", "Playground"] },
  { name: "Mulberry Park", lat: 29.714, lng: -95.422, type: "Park", acres: 2, amenities: ["Playground", "Pavilion"] },

  // Katy area
  { name: "Katy Park", lat: 29.784, lng: -95.807, type: "Park", acres: 30, amenities: ["Trails", "Playground", "Splash pad"] },
  { name: "Mary Jo Peckham Park", lat: 29.794, lng: -95.799, type: "Park", acres: 50, amenities: ["Pool", "Fishing", "Playground"] },
  { name: "Typhoon Texas Waterpark area", lat: 29.788, lng: -95.818, type: "Park", acres: 25, amenities: ["Sports fields", "Playground"] },

  // Sugar Land / Fort Bend
  { name: "Oyster Creek Park", lat: 29.613, lng: -95.648, type: "Park", acres: 100, amenities: ["Trails", "Playground", "Fishing"] },
  { name: "Brazos River Park", lat: 29.568, lng: -95.68, type: "Park", acres: 400, amenities: ["Trails", "Cycling", "Nature"] },

  // North Houston / Spring / Woodlands
  { name: "Meyer Park", lat: 30.085, lng: -95.576, type: "Park", acres: 100, amenities: ["Disc golf", "Trails", "Dog park"] },
  { name: "Spring Creek Greenway", lat: 30.087, lng: -95.5, type: "Park", acres: 3000, amenities: ["Trails", "Cycling", "Nature"] },
  { name: "Collins Park", lat: 30.043, lng: -95.417, type: "Park", acres: 22, amenities: ["Pool", "Playground", "Tennis"] },
];

// Static non-religious private elementary schools — Google Places verified, tuition ~2025-26
const HOUSTON_PRIVATE_SCHOOLS = [
  { name: "The Kinkaid School", lat: 29.7492, lng: -95.5108, tuition: 28500, grades: "PK–12", ratio: "10:1", nicheGrade: "A+", philosophy: "College prep", desc: "Houston's oldest independent co-ed school. Rigorous academics, strong arts & athletics. 100% college placement." },
  { name: "The Awty International School", lat: 29.7869, lng: -95.4602, tuition: 28000, grades: "PK–12", ratio: "8:1", nicheGrade: "A+", philosophy: "International / IB", desc: "French-American bilingual and international curriculum with IB program. 65+ nationalities represented." },
  { name: "School of the Woods", lat: 29.7936, lng: -95.4856, tuition: 19400, grades: "PK–12", ratio: "7:1", nicheGrade: "A+", philosophy: "Montessori", desc: "Montessori-based with contemporary methods. Student-led learning in Spring Branch/Hilshire Village area." },
  { name: "The Post Oak School", lat: 29.7145, lng: -95.456, tuition: 24000, grades: "PK–12", ratio: "10:1", nicheGrade: "A+", philosophy: "Montessori / IB", desc: "Montessori foundation with IB programme. Emphasis on independence, collaboration, and peace education." },
  { name: "The Village School", lat: 29.7457, lng: -95.6177, tuition: 26000, grades: "PK–12", ratio: "10:1", nicheGrade: "A", philosophy: "IB World School", desc: "Full IB continuum school (PYP, MYP, DP). Day and boarding options with global student body." },
  { name: "Trafton Academy", lat: 29.668, lng: -95.457, tuition: 12000, grades: "PK–8", ratio: "10:1", nicheGrade: "A", philosophy: "Traditional", desc: "Affordable independent school since 1973. Small classes, strong fundamentals, SW Houston location." },
  { name: "The Banff School", lat: 29.9768, lng: -95.5395, tuition: 14000, grades: "K–12", ratio: "8:1", nicheGrade: "B+", philosophy: "Traditional", desc: "North Houston independent school. Individualized learning plans, simplified admissions process." },
  { name: "British International School", lat: 29.7994, lng: -95.7371, tuition: 22000, grades: "PK–12", ratio: "8:1", nicheGrade: "A", philosophy: "British / IB", desc: "British National Curriculum with IB Diploma. Located in Katy area with global perspective." },
  { name: "Lycée International de Houston", lat: 29.7891, lng: -95.6619, tuition: 15000, grades: "PK–8", ratio: "12:1", nicheGrade: "A", philosophy: "French bilingual", desc: "French-English bilingual program following French Ministry of Education curriculum. Accredited by AEFE." },
];

function findNearestPrivateSchool(lat, lng) {
  if (!lat || !lng) return null;
  let best = null;
  for (const s of HOUSTON_PRIVATE_SCHOOLS) {
    const dist = haversine(lat, lng, s.lat, s.lng);
    if (!best || dist < best.distanceMi) {
      best = { ...s, distanceMi: Math.round(dist * 100) / 100 };
    }
  }
  return best;
}

function generateParks(lat, lng) {
  if (!lat || !lng) return null;
  const parks = [];
  let hasTrailFlag = false, hasPlaygroundFlag = false;
  for (const p of HOUSTON_PARKS) {
    const dist = haversine(lat, lng, p.lat, p.lng);
    if (dist > 3.1) continue;
    parks.push({ name: p.name, lat: p.lat, lng: p.lng, distanceMi: Math.round(dist * 100) / 100, type: p.type, acres: p.acres, amenities: p.amenities });
    if (p.type === "Trail" || p.amenities.some(a => a.toLowerCase().includes("trail"))) hasTrailFlag = true;
    if (p.amenities.some(a => a.toLowerCase().includes("playground"))) hasPlaygroundFlag = true;
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
    parkCount1Mi: parks.filter(p => p.distanceMi <= 1.05).length,
    hasTrail: hasTrailFlag,
    hasPlayground: hasPlaygroundFlag,
    greenSpaceScore: score,
    notes: count > 0 ? `${count} parks within 3 miles. Nearest: ${nearest?.name} (${nearest?.distanceMi} mi).` : "No parks found within 3 miles.",
  };
}

// Known Houston-area grocery store locations for instant distance calc
// Static grocery store database — Google Places verified coordinates, March 2025
const HOUSTON_GROCERIES = {
  heb: [
    { name: "H-E-B Spring Branch", lat: 29.791, lng: -95.497, address: "8106 Long Point Rd" },
    { name: "H-E-B Bunker Hill", lat: 29.7877, lng: -95.5324, address: "9710 Katy Fwy" },
    { name: "H-E-B Heights", lat: 29.8074, lng: -95.4088, address: "2300 N Shepherd Dr" },
    { name: "H-E-B Buffalo Heights", lat: 29.769, lng: -95.3966, address: "3663 Washington Ave" },
    { name: "H-E-B San Felipe", lat: 29.7479, lng: -95.4851, address: "5895 San Felipe St" },
    { name: "H-E-B Montrose", lat: 29.7377, lng: -95.4026, address: "1701 W Alabama St" },
    { name: "H-E-B Buffalo Speedway", lat: 29.7269, lng: -95.4272, address: "5225 Buffalo Speedway" },
    { name: "H-E-B MacGregor", lat: 29.7142, lng: -95.3769, address: "6055 South Fwy" },
    { name: "H-E-B Kempwood", lat: 29.8214, lng: -95.5473, address: "10251 Kempwood Dr" },
    { name: "H-E-B Westheimer & Kirkwood", lat: 29.7351, lng: -95.5873, address: "11815 Westheimer Rd" },
    { name: "H-E-B Meyerland", lat: 29.6889, lng: -95.4643, address: "4955 Beechnut St" },
    { name: "H-E-B Bellaire", lat: 29.7076, lng: -95.4697, address: "5106 Bissonnet St" },
    { name: "H-E-B Beechnut", lat: 29.687, lng: -95.571, address: "10100 Beechnut St" },
    { name: "H-E-B Bellaire Blvd", lat: 29.669, lng: -95.593, address: "14498 Bellaire Blvd" },
    { name: "H-E-B Gulfgate", lat: 29.675, lng: -95.337, address: "3111 Woodridge Dr" },
    { name: "H-E-B Blackhawk", lat: 29.651, lng: -95.298, address: "9828 Blackhawk Blvd" },
    { name: "H-E-B Braeswood", lat: 29.688, lng: -95.435, address: "5417 S Braeswood Blvd" },
    { name: "H-E-B Aldine Westfield", lat: 29.939, lng: -95.347, address: "12900 Aldine Westfield Rd" },
    { name: "H-E-B Jones Rd", lat: 29.911, lng: -95.5861, address: "9503 Jones Rd" },
    { name: "H-E-B Spring Cypress", lat: 30.0031, lng: -95.6386, address: "14100 Spring Cypress Rd" },
    { name: "H-E-B NW Fwy Cypress", lat: 29.9576, lng: -95.6733, address: "24224 Northwest Fwy" },
    { name: "H-E-B Champion Forest", lat: 30.0538, lng: -95.577, address: "20311 Champion Forest Dr" },
    { name: "H-E-B Tomball Pkwy", lat: 30.0887, lng: -95.6292, address: "28520 Tomball Pkwy" },
    { name: "H-E-B Creekside", lat: 30.1445, lng: -95.5496, address: "26500 Kuykendahl Rd" },
    { name: "H-E-B Grand Parkway Katy", lat: 29.7132, lng: -95.776, address: "6711 S Fry Rd" },
    { name: "H-E-B Mason Rd Katy", lat: 29.785, lng: -95.691, address: "1621 Mason Rd" },
    { name: "H-E-B Katy Market", lat: 29.7734, lng: -95.8225, address: "25675 Nelson Way" },
    { name: "H-E-B Katy Park", lat: 29.8191, lng: -95.8062, address: "24924 Morton Ranch Rd" },
    { name: "H-E-B Jordan Crossing", lat: 29.7544, lng: -95.8823, address: "29711 Jordan Crossing Blvd" },
    { name: "H-E-B Cross Creek Ranch", lat: 29.7193, lng: -95.8481, address: "4950 FM 1463" },
    { name: "H-E-B Sugar Land Hwy 6", lat: 29.608, lng: -95.6461, address: "530 Hwy 6" },
    { name: "H-E-B Sugar Land SW Fwy", lat: 29.565, lng: -95.6853, address: "19900 Southwest Fwy" },
    { name: "H-E-B Aliana", lat: 29.66, lng: -95.7134, address: "10161 W Grand Pkwy S" },
    { name: "H-E-B Richmond", lat: 29.5514, lng: -95.7471, address: "23500 Circle Oak Pkwy" },
    { name: "H-E-B Atascocita", lat: 29.9573, lng: -95.2085, address: "16000 Woodland Hills Dr" },
    { name: "H-E-B Humble FM 1960", lat: 30.0004, lng: -95.1645, address: "7405 FM 1960 E" },
    { name: "H-E-B Kingwood", lat: 29.9229, lng: -95.1969, address: "12680 W Lake Houston Pkwy" },
  ],
  costco: [
    { name: "Costco Bunker Hill", lat: 29.788, lng: -95.5304, address: "1150 Bunker Hill Rd" },
    { name: "Costco Richmond Ave", lat: 29.734, lng: -95.4397, address: "3836 Richmond Ave" },
    { name: "Costco N Gessner", lat: 29.9547, lng: -95.5483, address: "12405 N Gessner Rd" },
    { name: "Costco Katy", lat: 29.7829, lng: -95.7811, address: "23645 Katy Fwy" },
    { name: "Costco Sugar Land", lat: 29.5855, lng: -95.6439, address: "17520 Southwest Fwy" },
    { name: "Costco Pearland", lat: 29.5443, lng: -95.3909, address: "3500 Business Center Dr" },
  ],
  wholefoods: [
    { name: "Whole Foods Voss", lat: 29.7524, lng: -95.5, address: "1407 S Voss Rd" },
    { name: "Whole Foods Post Oak", lat: 29.7497, lng: -95.4617, address: "1700 Post Oak Blvd" },
    { name: "Whole Foods Montrose", lat: 29.7579, lng: -95.3976, address: "701 Waugh Dr" },
    { name: "Whole Foods Kirby", lat: 29.7393, lng: -95.418, address: "2955 Kirby Dr" },
    { name: "Whole Foods Westheimer", lat: 29.7349, lng: -95.5706, address: "11041 Westheimer Rd" },
    { name: "Whole Foods Bellaire Blvd", lat: 29.7068, lng: -95.4415, address: "4004 Bellaire Blvd" },
    { name: "Whole Foods Independence Heights", lat: 29.8137, lng: -95.3981, address: "101 N Loop W" },
    { name: "Whole Foods Champions", lat: 29.9985, lng: -95.562, address: "10133 Louetta Rd" },
    { name: "Whole Foods Katy", lat: 29.7124, lng: -95.7716, address: "6601 S Fry Rd" },
  ],
  traderjoes: [
    { name: "Trader Joe's Voss", lat: 29.7527, lng: -95.5017, address: "1440 S Voss Rd" },
    { name: "Trader Joe's Shepherd", lat: 29.7392, lng: -95.4113, address: "2922 S Shepherd Dr" },
    { name: "Trader Joe's Westheimer", lat: 29.7354, lng: -95.5825, address: "11683 Westheimer Rd" },
    { name: "Trader Joe's Katy", lat: 29.7403, lng: -95.7752, address: "2717 Commercial Center Blvd" },
    { name: "Trader Joe's Woodlands", lat: 30.1762, lng: -95.5361, address: "10868 Kuykendahl Rd" },
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

function fetchNearbyGroceries(lat, lng) {
  // Pure static lookup — no API calls needed, returns synchronously
  return Promise.resolve(generateGroceries(lat, lng));
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
  const roadMiles = crowMiles * 1.35;
  const avgSpeed = roadMiles < 5 ? 22 : roadMiles < 15 ? 28 : 35;
  const minutes = Math.round((roadMiles / avgSpeed) * 60);
  return { miles: Math.round(roadMiles * 10) / 10, minutes, source: "estimate" };
}

async function fetchCommute(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.routes?.[0]) {
      const r = data.routes[0];
      const miles = Math.round(r.distance / 1609.34 * 10) / 10;
      const minutes = Math.round((r.duration / 60) * 1.3);
      return { miles, minutes, source: "osrm" };
    }
  } catch (e) { /* OSRM failed */ }
  return estimateCommute(lat1, lng1, lat2, lng2);
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
const HomeIcon = (p) => <svg {...p} viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L2 12h3v8h5v-5h4v5h5v-8h3L12 3z"/></svg>;
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

/* ─── Grocery Map (Leaflet + CartoDB Voyager) ─────────────────────── */
function GroceryMap({ home, groceries, className = "", visible = true }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const boundsRef = useRef(null);

  useEffect(() => {
    if (!visible || !home?.lat || !home?.lng || !groceries) return;

    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    const init = (L) => {
      if (!mapRef.current) return;
      if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; }

      const map = L.map(mapRef.current, { zoomControl: false, attributionControl: false, scrollWheelZoom: true });
      L.control.zoom({ position: "topright" }).addTo(map);
      const tileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 18, subdomains: "abcd" });
      tileLayer.on("tileerror", () => {
        if (!map._osfallback) {
          map._osfallback = true;
          tileLayer.remove();
          L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
        }
      });
      tileLayer.addTo(map);

      const makeIcon = (emoji, bg, border) => L.divIcon({
        html: `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:${bg};border:2px solid ${border};border-radius:50%;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,0.2);">${emoji}</div>`,
        className: "", iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18],
      });

      const homeIcon = L.divIcon({
        html: `<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#8b5cf6,#d946ef);border:3px solid white;border-radius:50%;font-size:18px;box-shadow:0 3px 10px rgba(139,92,246,0.4);">🏠</div>`,
        className: "", iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -22],
      });

      const bounds = L.latLngBounds([[home.lat, home.lng]]);
      L.marker([home.lat, home.lng], { icon: homeIcon }).addTo(map).bindPopup(`<strong>${home.address}</strong>`);

      const chains = [
        { key: "heb", label: "H-E-B", emoji: "🛒", bg: "#fef2f2", border: "#dc2626" },
        { key: "costco", label: "Costco", emoji: "🏪", bg: "#eff6ff", border: "#2563eb" },
        { key: "wholefoods", label: "Whole Foods", emoji: "🥬", bg: "#f0fdf4", border: "#15803d" },
        { key: "traderjoes", label: "Trader Joe\'s", emoji: "🍊", bg: "#fff7ed", border: "#ea580c" },
      ];

      chains.forEach(({ key, label, emoji, bg, border }) => {
        const store = groceries[key];
        if (!store?.lat || !store?.lng) return;
        const icon = makeIcon(emoji, bg, border);
        L.marker([store.lat, store.lng], { icon }).addTo(map)
          .bindPopup(`<strong>${label}</strong><br/>${store.distanceMi} mi${store.address ? "<br/><span style='color:#888;font-size:11px'>" + store.address + "</span>" : ""}`);
        bounds.extend([store.lat, store.lng]);
      });

      boundsRef.current = bounds;
      mapInstance.current = map;

      requestAnimationFrame(() => {
        if (map && mapRef.current) {
          map.invalidateSize();
          map.fitBounds(bounds.pad(0.15));
        }
      });
    };

    if (window.L) { init(window.L); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => init(window.L);
    document.head.appendChild(script);

    return () => { if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; } };
  }, [visible, home?.lat, home?.lng, groceries]);

  return <div ref={mapRef} className={className} style={{ minHeight: 220, borderRadius: 12, zIndex: 0 }} />;
}

function ParkMap({ home, parks, className = "", visible = true }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);

  useEffect(() => {
    if (!visible || !home?.lat || !home?.lng || !parks?.parks?.length) return;

    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    const init = (L) => {
      if (!mapRef.current) return;
      if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; }

      const map = L.map(mapRef.current, { zoomControl: false, attributionControl: false, scrollWheelZoom: true });
      L.control.zoom({ position: "topright" }).addTo(map);
      const tileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 18, subdomains: "abcd" });
      tileLayer.on("tileerror", () => {
        if (!map._osfallback) {
          map._osfallback = true;
          tileLayer.remove();
          L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
        }
      });
      tileLayer.addTo(map);

      const homeIcon = L.divIcon({
        html: `<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#8b5cf6,#d946ef);border:3px solid white;border-radius:50%;font-size:18px;box-shadow:0 3px 10px rgba(139,92,246,0.4);">🏠</div>`,
        className: "", iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -22],
      });

      const bounds = L.latLngBounds([[home.lat, home.lng]]);
      L.marker([home.lat, home.lng], { icon: homeIcon }).addTo(map).bindPopup(`<strong>${home.address}</strong>`);

      const colors = [
        { bg: "#ecfdf5", border: "#059669" },
        { bg: "#f0fdfa", border: "#0d9488" },
        { bg: "#eff6ff", border: "#2563eb" },
        { bg: "#fffbeb", border: "#d97706" },
      ];

      parks.parks.slice(0, 4).forEach((park, i) => {
        if (!park.lat || !park.lng) return;
        const getEmoji = (p) => p.type === "Trail" || p.type === "Linear Park" ? "🥾" : p.type === "Nature Preserve" ? "🌿" : p.amenities?.includes("Playground") ? "🛝" : "🌳";
        const c = colors[i] || colors[0];
        const icon = L.divIcon({
          html: `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:${c.bg};border:2px solid ${c.border};border-radius:50%;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,0.2);">${getEmoji(park)}</div>`,
          className: "", iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18],
        });
        L.marker([park.lat, park.lng], { icon }).addTo(map)
          .bindPopup(`<strong>${park.name}</strong><br/>${park.distanceMi} mi${park.type ? "<br/><span style='color:#888;font-size:11px'>" + park.type + (park.acres ? " · " + park.acres + " ac" : "") + "</span>" : ""}`);
        bounds.extend([park.lat, park.lng]);
      });

      mapInstance.current = map;
      requestAnimationFrame(() => {
        if (map && mapRef.current) {
          map.invalidateSize();
          map.fitBounds(bounds.pad(0.15));
        }
      });
    };

    if (window.L) { init(window.L); return; }
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => init(window.L);
    document.head.appendChild(script);

    return () => { if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; } };
  }, [visible, home?.lat, home?.lng, parks]);

  return <div ref={mapRef} className={className} style={{ minHeight: 220, borderRadius: 12, zIndex: 0 }} />;
}

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
          className={`${size} transition-all star-tap ${s <= display ? "text-amber-400 hover:opacity-75 active:opacity-65" : "text-stone-400"}`}>
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
  if (s.includes("sold")) return <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">Sold</span>;
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
function HomeListScreen({ homes, setHomes, onOpenHome, compareList, toggleCompare, onImport, fin, rateInfo, schoolFilter, setSchoolFilter, maxBudget, enrichDone, enrichProgress }) {
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
        if (sortKey === "appraisalPct") return h.appraisal?.value && h.price ? ((h.price - h.appraisal.value) / h.appraisal.value * 100) : null;
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
    const enriched = filtered.filter((h) => h.flood && h.crime && h.school && h.parks && h.groceries && h.appraisal).length;
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
          { label: "Toured", value: `${stats.viewed}/${stats.count}`, color: "text-teal-600" },
          ...(stats.inBudget != null ? [{ label: "In Budget", value: `${stats.inBudget}/${stats.count}`, color: stats.inBudget > 0 ? "text-emerald-600" : "text-orange-600" }] : []),
          { label: "Avg Price", value: fmt(stats.avg), color: "text-stone-800" },
          { label: "30yr Rate", value: rateInfo.loading ? "..." : `${fin.rate}%`, color: rateInfo.loading ? "text-stone-400" : "text-sky-600", sub: rateInfo.loading ? "Fetching" : rateInfo.source === "default" ? "Default" : "Live" },
          ...(enrichProgress.total > 0 && !enrichDone ? [{ label: "Data", value: `${enrichProgress.done}/${enrichProgress.total}`, color: "text-violet-600", sub: "Enriching" }] : []),
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
          {[["all", "All"], ["favorites", "★"], ["viewed", "Toured"], ["not_viewed", "Not Toured"]].map(([v, l]) => (
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
              className={`anim-fade-up rounded-xl border shadow-sm active:scale-[0.99] transition-transform cursor-pointer card-hover ${!h.viewed ? "bg-white border-l-[3px] border-l-sky-400 border-t border-r border-b border-t-stone-200 border-r-stone-200 border-b-stone-200 ring-1 ring-sky-100" : "bg-stone-50/70 border-stone-200"}`}>
              <div className="p-3.5">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className={`font-semibold truncate text-[15px] ${h.viewed ? "text-stone-500" : "text-stone-800"}`}>{h.address || "—"}</p>
                      <StatusBadge status={h.status} />
                      {h.nextOpenHouseStart && parseOHDate(h.nextOpenHouseStart) >= new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) && (
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md uppercase tracking-wide">Open House</span>
                      )}
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
                      title={h.favorite ? "Unfavorite" : "Favorite"}
                      className={`mt-0.5 star-tap ${h.favorite ? "text-amber-400" : "text-stone-300 hover:text-amber-300"}`}>
                      <StarIcon filled={h.favorite} className="w-5 h-5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setHomes((p) => p.map((x) => x.id === h.id ? { ...x, viewed: !x.viewed } : x)); }}
                      title={h.viewed ? "Mark as not toured" : "Mark as toured in person"}
                      className={`mt-0.5 ${h.viewed ? "text-stone-400 hover:text-stone-600" : "text-stone-200 hover:text-stone-400"} transition-colors`}>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
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
                  {h.viewed && <span className="text-teal-600 font-semibold bg-teal-50 px-1.5 py-0.5 rounded text-[10px]">Toured ✓</span>}
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
              <th className="py-3 px-3 w-8" title="Compare"></th>
              <th className="py-3 px-3 w-8" title="Link"></th>
              <th className="py-3 px-3 w-8" title="Delete"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {filtered.map((h) => {
              const isComp = compareList.includes(h.id);
              const hTax2 = h.taxRate || fin.propTax;
              const monthly = h.price ? quickMonthly(h.price, fin.cash, h.hoa || 0, fin.rate, fin.closing, hTax2, h) : 0;
              const monthlyTax = h.price ? Math.round((h.price * hTax2 / 100) / 12) : 0;
              return (
                <tr key={h.id} onClick={() => onOpenHome(h, filtered)} className={`group cursor-pointer transition-colors duration-200 hover:shadow-sm ${h.viewed ? "bg-stone-50/50 hover:bg-stone-100/50" : "bg-white hover:bg-sky-50/30"}`}>
                  <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setHomes((p) => p.map((x) => x.id === h.id ? { ...x, favorite: !x.favorite } : x))}
                      title={h.favorite ? "Unfavorite" : "Favorite"}
                      className={`star-tap ${h.favorite ? "text-amber-400" : "text-stone-300 hover:text-amber-300"}`}>
                      <StarIcon filled={h.favorite} className="w-4 h-4" />
                    </button>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium truncate max-w-[220px] ${h.viewed ? "text-stone-500" : "text-stone-800"}`}>{h.address || "—"}</span>
                      {h.viewed && <svg className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                      <StatusBadge status={h.status} />
                      {h.notes && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Has notes" />}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-stone-500">{h.city || "—"}</td>
                  <td className="py-2.5 px-3 text-stone-900 font-semibold tabular-nums">{fmt(h.price)} {maxBudget && <span className={`text-[9px] font-bold ml-1 px-1 py-0.5 rounded ${h.price > maxBudget.maxPrice ? "text-orange-600 bg-orange-50" : "text-teal-600 bg-teal-50"}`}>{h.price > maxBudget.maxPrice ? "OVER" : "OK"}</span>}</td>
                  <td className="py-2.5 px-3 tabular-nums text-xs font-semibold">
                    {h.appraisal?.value && h.price ? (() => {
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
                    <button onClick={() => toggleCompare(h.id)} title={isComp ? "Remove from compare" : "Add to compare"}
                      className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${isComp ? "bg-violet-100 text-violet-600 ring-1 ring-violet-300" : "text-stone-300 hover:text-violet-400 hover:bg-violet-50"}`}><CompareIcon className="w-3.5 h-3.5" /></button>
                  </td>
                  <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                    {h.url && <a href={h.url} target="_blank" rel="noreferrer" title="Open listing" className="text-sky-400 hover:text-sky-600 transition-colors"><LinkIcon className="w-4 h-4" /></a>}
                  </td>
                  <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => { if (window.confirm(`Remove "${h.address || "this listing"}" from your list?`)) { trackDeletion(h.address); setHomes((p) => p.filter((x) => x.id !== h.id)); }; }}
                      title="Remove listing"
                      className="w-6 h-6 rounded flex items-center justify-center text-stone-300 hover:text-red-400 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
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

function HomeDetailScreen({ home, onBack, onUpdate, onDelete, compareList, toggleCompare, fin, navList = [], onNavigate, allHomes = [], soldComps = [], onFilterBySchool, maxBudget }) {
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

  useEffect(() => { stopVoice(); setNotes(home.notes || ""); setEditingNotes(false); setShowFinancial(false); setVoiceError(null); setSchool(home.school || null); setFlood(home.flood || null); setCrime(home.crime || null); setAppraisal(home.appraisal || null); setGroceryMapOpen(false); setParkMapOpen(false); window.scrollTo(0, 0); }, [home.id]);

  // Appraisal value — fetch once per home, cache on the home object
  const [appraisal, setAppraisal] = useState(home.appraisal || null);
  const [appraisalLoading, setAppraisalLoading] = useState(false);

  useEffect(() => {
    if (home.appraisal) { setAppraisal(home.appraisal); return; }
    let cancelled = false;
    setAppraisalLoading(true);
    setAppraisal(null);
    fetchAppraisal(home.address, home.city, home.state, home.lat, home.lng).then((result) => {
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
  const [commutes, setCommutes] = useState({});

  // Fetch OSRM commute times
  useEffect(() => {
    if (!home.lat || !home.lng || !fin.places?.length) return;
    setCommutes({});
    fin.places.forEach((place, i) => {
      fetchCommute(home.lat, home.lng, place.lat, place.lng).then((r) => {
        if (r) setCommutes(prev => ({ ...prev, [i]: r }));
      });
    });
  }, [home.id, home.lat, home.lng, fin.places]);
  const [groceries, setGroceries] = useState(home.groceries || null);
  const [groceriesLoading, setGroceriesLoading] = useState(false);
  const [groceryMapOpen, setGroceryMapOpen] = useState(false);
  const [parkMapOpen, setParkMapOpen] = useState(false);

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
    fetchFloodZone(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((result) => {
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
    fetchCrime(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((result) => {
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
    fetchSchool(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((result) => {
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
    <>
    {/* Header — outside swipe container so transform doesn't break fixed positioning */}
    <div className="fixed top-0 md:top-16 left-0 right-0 z-[45] bg-white/95 backdrop-blur-md border-b border-stone-200 px-4 py-3 md:px-6 shadow-sm">
        <div className="flex items-center gap-3 max-w-5xl mx-auto">
          <button onClick={onBack} title="Back to list" className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-stone-100 active:bg-stone-200 text-stone-500 -ml-2 transition-colors"><BackIcon className="w-5 h-5" /></button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-stone-800 truncate text-base md:text-lg">{home.address}</h1>
              {navLabel && <span className="text-[10px] text-stone-400 font-semibold bg-stone-100 px-1.5 py-0.5 rounded tabular-nums flex-shrink-0">{navLabel}</span>}
            </div>
            <p className="text-xs text-stone-400 truncate">{[home.city, home.state, home.zip].filter(Boolean).join(", ")}</p>
          </div>
          {navList.length > 1 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => doNavigate(-1)} disabled={!hasPrev} title="Previous home"
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${hasPrev ? "text-stone-500 hover:bg-stone-100 active:bg-stone-200" : "text-stone-200"}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button onClick={() => doNavigate(1)} disabled={!hasNext} title="Next home"
                className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${hasNext ? "text-stone-500 hover:bg-stone-100 active:bg-stone-200" : "text-stone-200"}`}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => onUpdate(home.id, { favorite: !home.favorite })}
              title={home.favorite ? "Unfavorite" : "Favorite"}
              className={`w-10 h-10 flex items-center justify-center rounded-xl border transition-colors star-tap ${home.favorite ? "bg-amber-50 border-amber-200 text-amber-400" : "bg-stone-50 border-stone-200 text-stone-300 hover:text-amber-300 hover:border-amber-200 hover:bg-amber-50/50"}`}>
              <StarIcon filled={home.favorite} className="w-5 h-5" />
            </button>
            <StatusBadge status={home.status} />
            <button onClick={(e) => { e.stopPropagation(); onUpdate(home.id, { viewed: !home.viewed }); }}
              title={home.viewed ? "Mark as not toured" : "Mark as toured in person"}
              className={`w-10 h-10 flex items-center justify-center rounded-xl border transition-colors ${home.viewed ? "bg-stone-100 border-stone-300 text-stone-500" : "bg-sky-50 border-sky-200 text-sky-500"}`}>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                {home.viewed ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>}
              </svg>
            </button>
            {home.url && (
              <a href={home.url} target="_blank" rel="noreferrer" title="Open listing"
                className="w-10 h-10 flex items-center justify-center rounded-xl bg-sky-50 border border-sky-200 text-sky-600 hover:bg-sky-100 active:bg-sky-200 transition-colors">
                <LinkIcon className="w-4 h-4" />
              </a>
            )}
            {onDelete && (
              <button onClick={() => { if (window.confirm(`Remove "${home.address || "this listing"}" from your list?`)) { onDelete(home.id); onBack(); } }}
                title="Remove listing"
                className="w-10 h-10 flex items-center justify-center rounded-xl bg-stone-50 border border-stone-200 text-stone-400 hover:text-red-500 hover:bg-red-50 hover:border-red-200 active:bg-red-100 transition-colors">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
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
      <div className="h-16 md:h-[60px]" /> {/* Spacer for fixed detail header */}

      <div className="relative z-0 max-w-5xl mx-auto px-4 md:px-6 py-5 space-y-4">
        {/* ── Price Hero ─────────────────────────────────────────── */}
        <div className="bg-gradient-to-br from-sky-50 via-blue-50 to-indigo-50 border border-sky-200/80 rounded-2xl p-5">
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
                    {school.rating ? school.rating + "/10" : school.tier === "great" ? "A" : school.tier === "good" ? "B" : "C"}
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
              ...(home.soldDate ? [["Sold Date", home.soldDate]] : []),
              ...(home.nextOpenHouseStart ? [["Open House", (() => { const d = parseOHDate(home.nextOpenHouseStart); const e = parseOHDate(home.nextOpenHouseEnd); return d ? formatOHDate(d) + " " + formatOHTime(d) + (e ? " – " + formatOHTime(e) : "") : home.nextOpenHouseStart; })()]] : []),
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
                  <span className={`text-sm font-bold ${school.tier === "great" ? "text-sky-600" : school.tier === "good" ? "text-amber-600" : "text-orange-600"}`}>{school.rating ? school.rating + "/10" : school.tier === "great" ? "A" : school.tier === "good" ? "B" : "C"}</span>
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
                        <Tip label="Rating" tip="Overall rating from 1-10 based on test scores, student progress, and equity. 8+ is great, 5-7 is average, below 5 is below average.">
                          <div className={`text-xl font-bold mt-0.5 ${accent}`}>{school.rating}<span className="text-xs text-stone-400 font-normal">/10</span></div>
                          <div className="text-[10px] text-stone-400">{school.ratingSource || "Rating"}</div>
                        </Tip>
                      )}
                      {school.nicheGrade && (
                        <Tip label="Niche" tip="Niche composite grade (A+ to F) based on academics, teachers, diversity, resources, and parent/student reviews.dent reviews. A well-rounded school report card.">
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
                    <p>This home is zoned to a <strong className="text-sky-600">top-rated elementary school</strong> with excellent student-teacher ratios. Homes in highly-rated school zones typically command a premium and hold value well. Strong school zoning is one of the most reliable long-term value drivers.</p>
                  )}
                  {school.tier === "good" && (
                    <p>This home is zoned to a <strong className="text-amber-600">solid elementary school</strong> with average class sizes. Steady academic performanceics. Check for magnet programs, recent improvements, and parent reviews for a fuller picture.</p>
                  )}
                  {school.tier === "below" && (
                    <p>This home is zoned to an elementary school with <strong className="text-orange-600">higher-than-average class sizes</strong>. Consider investigating charter school options, magnet transfers, or private school costs ($10K-$25K+/year) when budgeting for this home.</p>
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
                  <span className="text-xs text-stone-400">{school.ratingSource || "NCES CCD 2022-23"} · {school.district}</span>
                  <button onClick={() => {
                    setSchoolLoading(true);
                    setSchool(null);
                    fetchSchool(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
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
                  fetchSchool(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
                    setSchoolLoading(false);
                    if (r && r.schoolName) { setSchool(r); onUpdate(home.id, { school: r }); }
                  });
                }} className="text-sm text-sky-600 font-medium hover:text-sky-700">Fetch school data →</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Nearest Private School (Non-Religious) ──────────────── */}
        {(() => {
          const ps = findNearestPrivateSchool(home.lat, home.lng);
          if (!ps) return null;
          return (
            <div className="border rounded-2xl overflow-hidden anim-fade-up bg-violet-50/40 border-violet-200" style={{ animationDelay: '248ms' }}>
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🎓</span>
                    <h3 className="text-sm font-semibold text-stone-700">Private School Alternative</h3>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-violet-100 text-violet-600">Non-Religious</span>
                </div>
                <div className="space-y-3">
                  <div className="rounded-xl p-3.5 bg-violet-100/60 border border-violet-200/50">
                    <div className="text-lg font-bold text-violet-700">{ps.name}</div>
                    <div className="text-sm text-stone-500 mt-0.5">{ps.philosophy} · {ps.grades}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <div className="bg-violet-100/40 rounded-xl p-2.5 text-center flex-1 min-w-[70px]">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Tuition</div>
                      <div className="text-xl font-bold mt-0.5 text-violet-600">${(ps.tuition / 1000).toFixed(0)}<span className="text-xs text-stone-400 font-normal">K/yr</span></div>
                    </div>
                    <div className="bg-violet-100/40 rounded-xl p-2.5 text-center flex-1 min-w-[70px]">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Distance</div>
                      <div className="text-xl font-bold mt-0.5 text-violet-600">{ps.distanceMi}<span className="text-xs text-stone-400 font-normal"> mi</span></div>
                    </div>
                    <div className="bg-violet-100/40 rounded-xl p-2.5 text-center flex-1 min-w-[70px]">
                      <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Stu:Teacher</div>
                      <div className="text-xl font-bold mt-0.5 text-violet-600">{ps.ratio}</div>
                    </div>
                    {ps.nicheGrade && (
                      <div className="bg-violet-100/40 rounded-xl p-2.5 text-center flex-1 min-w-[70px]">
                        <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Niche</div>
                        <div className="text-xl font-bold mt-0.5 text-violet-600">{ps.nicheGrade}</div>
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-stone-600 leading-relaxed">{ps.desc}</p>
                  <div className="rounded-xl px-3.5 py-2.5 text-sm bg-violet-100/40 text-violet-700">
                    <strong className="text-xs uppercase tracking-wider">Annual cost:</strong> ~${ps.tuition.toLocaleString()}/year ({`$${Math.round(ps.tuition / 12).toLocaleString()}/mo`})
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Parks & Green Space ──────────────────────────────── */}
        <div className={`border rounded-2xl overflow-hidden anim-fade-up ${parks?.greenSpaceScore === "excellent" ? "bg-emerald-50/50 border-emerald-200" : parks?.greenSpaceScore === "good" ? "bg-teal-50/50 border-teal-200" : "bg-white border-stone-200"}`} style={{ animationDelay: '260ms' }}>
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className={`w-5 h-5 ${parks?.greenSpaceScore === "excellent" ? "text-emerald-500" : parks?.greenSpaceScore === "good" ? "text-teal-500" : parks?.greenSpaceScore === "fair" ? "text-amber-500" : "text-stone-400"}`} viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 2 6 5 6 8c0 2 1.5 3.5 3 4.5V22h6V12.5c1.5-1 3-2.5 3-4.5 0-3-2.5-6-6-6zm-2 14H8v-1h2v1zm0-2.5H8v-1h2v1zm4 2.5h-2v-1h2v1zm0-2.5h-2v-1h2v1z"/></svg>
                <h3 className="text-sm font-semibold text-stone-700">Parks & Green Space</h3>
              </div>
              <div className="flex items-center gap-2">
                {parks && (
                  <button onClick={() => setParkMapOpen(v => !v)}
                    className="md:hidden text-xs font-medium text-emerald-500 hover:text-emerald-600 flex items-center gap-1 transition-colors">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    {parkMapOpen ? "Hide Map" : "Map"}
                  </button>
                )}
                {parks && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${parks.greenSpaceScore === "excellent" ? "bg-emerald-100 text-emerald-600" : parks.greenSpaceScore === "good" ? "bg-teal-100 text-teal-600" : parks.greenSpaceScore === "fair" ? "bg-amber-100 text-amber-600" : "bg-stone-100 text-stone-500"}`}>
                  {parks.greenSpaceScore === "excellent" ? "Excellent" : parks.greenSpaceScore === "good" ? "Good" : parks.greenSpaceScore === "fair" ? "Fair" : "Limited"}
                </span>
              )}
              </div>
            </div>

            {parksLoading && <div className="text-sm text-stone-400 animate-pulse py-4">Finding nearby parks...</div>}

            {parks && (() => {
              const parkList = parks.parks?.slice(0, 4) || [];
              const getEmoji = (p) => p.type === "Trail" || p.type === "Linear Park" ? "🥾" : p.type === "Nature Preserve" ? "🌿" : p.amenities?.includes("Playground") ? "🛝" : "🌳";
              const getBg = (i) => ["bg-emerald-50", "bg-teal-50", "bg-sky-50", "bg-amber-50"][i] || "bg-teal-50";
              const getColor = (i) => ["text-emerald-600", "text-teal-600", "text-sky-600", "text-amber-600"][i] || "text-teal-600";
              return (
                <div className="flex flex-col md:flex-row gap-3">
                  <div className="md:w-2/5 flex flex-col gap-1.5">
                    {parkList.map((park, i) => (
                      <div key={i} className={`rounded-lg px-3 py-2 border flex items-center gap-2.5 ${getBg(i)} border-stone-100`}>
                        <span className="text-base flex-shrink-0">{getEmoji(park)}</span>
                        <span className={`text-xs font-bold truncate flex-shrink-0 ${getColor(i)}`}>{park.name}</span>
                        <div className="ml-auto text-right flex-shrink-0">
                          <span className={`text-sm font-bold tabular-nums ${getColor(i)}`}>{park.distanceMi != null ? park.distanceMi.toFixed(1) : "—"} <span className="text-[10px] text-stone-400 font-normal">mi</span></span>
                        </div>
                      </div>
                    ))}
                    {parkList.length === 0 && (
                      <div className="rounded-lg px-3 py-2 border bg-stone-50/50 border-stone-100 text-xs text-stone-400">No parks found nearby</div>
                    )}
                    <div className="text-[10px] text-stone-500 px-1 mt-0.5">
                      {parks.parkCount1Mi || 0} green space{(parks.parkCount1Mi || 0) !== 1 ? "s" : ""} within 1 mi{parks.hasTrail ? " · Trail access" : ""}{parks.hasPlayground ? " · Playground" : ""}
                    </div>
                  </div>
                  <div className={`md:w-3/5 ${parkMapOpen ? "block" : "hidden md:block"}`}>
                    <ParkMap home={home} parks={parks} visible={parkMapOpen || window.innerWidth >= 768} className="w-full h-full min-h-[220px] md:min-h-[260px] rounded-xl border border-stone-200" />
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

        {/* ── {/* ── Groceries ─────────────────────────────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '275ms' }}>
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" /></svg>
              <h3 className="text-sm font-semibold text-stone-700">Nearest Groceries</h3>
              {groceries && (
                <button onClick={() => setGroceryMapOpen(v => !v)}
                  className="md:hidden ml-auto text-xs font-medium text-orange-500 hover:text-orange-600 flex items-center gap-1 transition-colors">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  {groceryMapOpen ? "Hide Map" : "Map"}
                </button>
              )}
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
                <div className="flex flex-col md:flex-row gap-3">
                  {/* Store list — compact on desktop */}
                  <div className="md:w-2/5 flex flex-col gap-1.5">
                    {stores.map((s) => {
                      const store = groceries[s.key];
                      return (
                        <div key={s.key} className={`rounded-lg px-3 py-2 border flex items-center gap-2.5 ${store ? s.bg + " border-stone-100" : "bg-stone-50/50 border-stone-100"}`}>
                          <span className="text-base flex-shrink-0">{s.emoji}</span>
                          <span className={`text-xs font-bold flex-shrink-0 ${store ? s.color : "text-stone-400"}`}>{s.label}</span>
                          {store ? (
                            <div className="ml-auto text-right flex-shrink-0">
                              <span className={`text-sm font-bold tabular-nums ${s.color}`}>{store.distanceMi} <span className="text-[10px] text-stone-400 font-normal">mi</span></span>
                            </div>
                          ) : (
                            <span className="ml-auto text-[10px] text-stone-400">—</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Map — always visible desktop, toggle mobile */}
                  <div className={`md:w-3/5 ${groceryMapOpen ? "block" : "hidden md:block"}`}>
                    <GroceryMap home={home} groceries={groceries} visible={groceryMapOpen || window.innerWidth >= 768} className="w-full h-full min-h-[220px] md:min-h-[260px] rounded-xl border border-stone-200 overflow-hidden" />
                  </div>
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
                  const c = commutes[i] || estimateCommute(home.lat, home.lng, place.lat, place.lng);
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
              <p className="text-[10px] text-stone-400 mt-2.5">{Object.values(commutes).some(x => x?.source === "osrm") ? "Drive times via OSRM routing + Houston traffic factor." : "Loading route data..."}</p>
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
                    fetchFloodZone(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
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
                  fetchFloodZone(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
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
                    fetchCrime(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
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
                  fetchCrime(home.address, home.city, home.state, home.zip, home.lat, home.lng).then((r) => {
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
                    <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Strong</div>
                    <div className="text-xl font-bold text-violet-800 tabular-nums">{fmtC(offer.strong)}</div>
                    <div className="text-[10px] text-violet-500 tabular-nums">{((offer.strong / home.price - 1) * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold mb-1">Competitive</div>
                    <div className="text-lg font-bold text-violet-700 tabular-nums">{fmtC(offer.competitive)}</div>
                    <div className="text-[10px] text-violet-500 tabular-nums">{((offer.competitive / home.price - 1) * 100).toFixed(1)}%</div>
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

        {/* ── Value Score Breakdown ──────────────────────────────────── */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden anim-fade-up" style={{ animationDelay: '230ms' }}>
          <div className="p-4">
            {(() => {
              const vs = calcValueScore(home, allHomes);
              const color = vs >= 70 ? "text-teal-600" : vs >= 50 ? "text-amber-600" : "text-orange-500";
              const bgColor = vs >= 70 ? "bg-teal-50 border-teal-200" : vs >= 50 ? "bg-amber-50 border-amber-200" : "bg-orange-50 border-orange-200";
              const barColor = vs >= 70 ? "bg-teal-500" : vs >= 50 ? "bg-amber-500" : "bg-orange-500";
              const label = vs >= 80 ? "Excellent" : vs >= 70 ? "Strong" : vs >= 60 ? "Good" : vs >= 50 ? "Average" : vs >= 40 ? "Below Avg" : "Weak";

              // Recalculate each component for breakdown
              const components = [];

              // Price vs Appraisal
              if (home.appraisal?.value && home.price) {
                const gap = (home.price - home.appraisal.value) / home.appraisal.value;
                const pts = Math.max(-20, Math.min(20, -gap * 100));
                const pct = ((gap) * 100).toFixed(1);
                components.push({ label: "Price vs Appraisal", pts, max: 20, detail: gap > 0 ? `${Math.abs(pct)}% above appraisal` : `${Math.abs(pct)}% below appraisal`, icon: "💰" });
              } else {
                components.push({ label: "Price vs Appraisal", pts: 0, max: 20, detail: "No appraisal data", icon: "💰", missing: true });
              }

              // $/sqft vs median
              if (home.ppsf && allHomes.length > 3) {
                const ppsfList = allHomes.filter(x => x.ppsf).map(x => x.ppsf).sort((a, b) => a - b);
                const median = ppsfList[Math.floor(ppsfList.length / 2)];
                if (median) {
                  const diff = (home.ppsf - median) / median;
                  const pts = Math.max(-15, Math.min(15, -diff * 50));
                  components.push({ label: "$/sqft vs Median", pts, max: 15, detail: `$${home.ppsf}/sqft vs $${median}/sqft median`, icon: "📐" });
                }
              } else {
                components.push({ label: "$/sqft vs Median", pts: 0, max: 15, detail: "Need more homes to compare", icon: "📐", missing: true });
              }

              // School
              if (home.school?.rating != null) {
                const pts = (home.school.rating / 10) * 15;
                components.push({ label: "School Rating", pts, max: 15, detail: `${home.school.rating}/10 — ${home.school.schoolName || "nearby school"}`, icon: "🏫" });
              } else {
                components.push({ label: "School Rating", pts: 0, max: 15, detail: "No school data", icon: "🏫", missing: true });
              }

              // Flood
              {
                const pts = home.flood?.risk === "high" ? -12 : home.flood?.risk === "moderate" ? -5 : home.flood?.risk === "low" ? 3 : 0;
                const riskLabel = home.flood?.risk ? (home.flood.risk.charAt(0).toUpperCase() + home.flood.risk.slice(1)) + " risk" : "No data";
                const zone = home.flood?.zone ? ` (Zone ${home.flood.zone})` : "";
                components.push({ label: "Flood Risk", pts, max: 12, min: -12, detail: riskLabel + zone, icon: "💧", missing: !home.flood });
              }

              // Crime
              {
                const pts = home.crime?.risk === "high" ? -8 : home.crime?.risk === "low" ? 4 : 0;
                const riskLabel = home.crime?.risk ? (home.crime.risk.charAt(0).toUpperCase() + home.crime.risk.slice(1)) + " risk" : "No data";
                components.push({ label: "Crime", pts, max: 8, min: -8, detail: riskLabel, icon: "🛡️", missing: !home.crime });
              }

              // Parks
              {
                let pts = 0;
                if (home.parks?.greenSpaceScore === "excellent") pts += 8;
                else if (home.parks?.greenSpaceScore === "good") pts += 5;
                else if (home.parks?.greenSpaceScore === "fair") pts += 2;
                if (home.parks?.hasTrail) pts += 2;
                if (home.parks?.hasPlayground) pts += 1;
                const details = home.parks ? [home.parks.greenSpaceScore, home.parks.hasTrail && "trail", home.parks.hasPlayground && "playground"].filter(Boolean).join(", ") : "No data";
                components.push({ label: "Parks & Green Space", pts, max: 11, detail: details || "None nearby", icon: "🌳", missing: !home.parks });
              }

              // DOM
              {
                const dom = home.dom || 0;
                const pts = dom > 90 ? 10 : dom > 60 ? 7 : dom > 30 ? 4 : dom > 14 ? 2 : 0;
                components.push({ label: "Days on Market", pts, max: 10, detail: dom ? `${dom} days — ${dom > 90 ? "strong leverage" : dom > 60 ? "good leverage" : dom > 30 ? "some leverage" : dom > 14 ? "slight leverage" : "fresh listing"}` : "Unknown", icon: "📅", missing: !dom });
              }

              return (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-teal-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                    <h3 className="text-sm font-semibold text-stone-700">Value Score</h3>
                  </div>
                  {/* Hero score */}
                  <div className={`rounded-xl border p-4 mb-4 ${bgColor}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-baseline gap-2">
                        <span className={`text-3xl font-bold tabular-nums ${color}`}>{vs}</span>
                        <span className="text-sm text-stone-500">/ 100</span>
                      </div>
                      <span className={`text-sm font-semibold ${color}`}>{label}</span>
                    </div>
                    <div className="w-full bg-white/60 rounded-full h-2.5">
                      <div className={`h-2.5 rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${vs}%` }} />
                    </div>
                    <p className="text-[10px] text-stone-400 mt-2">Composite score from pricing, location, schools, and market factors. Base starts at 50.</p>
                  </div>
                  {/* Component breakdown */}
                  <div className="space-y-2">
                    {components.map((c, i) => {
                      const ptsColor = c.missing ? "text-stone-300" : c.pts > 0 ? "text-teal-600" : c.pts < 0 ? "text-red-500" : "text-stone-400";
                      const ptsStr = c.pts > 0 ? `+${c.pts.toFixed(1)}` : c.pts.toFixed(1);
                      const barW = c.max > 0 ? Math.abs(c.pts) / c.max * 100 : 0;
                      return (
                        <div key={i} className={`flex items-center gap-3 py-2 px-3 rounded-lg ${c.missing ? "bg-stone-50/50" : "bg-stone-50"}`}>
                          <span className="text-sm flex-shrink-0">{c.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-xs font-semibold text-stone-700">{c.label}</span>
                              <span className={`text-xs font-bold tabular-nums ${ptsColor}`}>{c.missing ? "—" : ptsStr}</span>
                            </div>
                            <div className="w-full bg-stone-200/50 rounded-full h-1.5 mb-1">
                              {!c.missing && <div className={`h-1.5 rounded-full ${c.pts >= 0 ? "bg-teal-400" : "bg-red-400"}`} style={{ width: `${Math.min(100, barW)}%` }} />}
                            </div>
                            <p className={`text-[10px] ${c.missing ? "text-stone-300" : "text-stone-400"}`}>{c.detail}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

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
                        fetchAppraisal(home.address, home.city, home.state, home.lat, home.lng).then((r) => {
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
                  fetchAppraisal(home.address, home.city, home.state, home.lat, home.lng).then((r) => {
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
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   SCREEN: Compare
   ═══════════════════════════════════════════════════════════════════ */
/* ─── SCREEN: Open House Tour Planner ─────────────────── */

function parseOHDate(str) {
  if (!str) return null;
  try {
    let d = new Date(str);
    if (!isNaN(d.getTime())) return d;
    const stripped = str.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, "");
    d = new Date(stripped);
    if (!isNaN(d.getTime())) return d;
    d = new Date(stripped.replace(/(\d)(am|pm)/i, "$1 $2"));
    if (!isNaN(d.getTime())) return d;
  } catch (e) {}
  return null;
}
function formatOHTime(d) { return d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : ""; }
function formatOHDate(d) { return d ? d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) : ""; }
function getDateKey(d) { return d ? d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }) : ""; }

// Nearest-neighbor TSP approximation for route optimization
function optimizeRoute(stops) {
  if (stops.length <= 2) return stops;
  const remaining = [...stops];
  const route = [remaining.shift()]; // start with first
  while (remaining.length > 0) {
    const last = route[route.length - 1];
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      if (!last.lat || !remaining[i].lat) continue;
      const d = haversine(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    route.push(remaining.splice(bestIdx, 1)[0]);
  }
  return route;
}

// Estimate drive time (Houston traffic: ~25mph avg)
function estDriveMin(miles) { return Math.round(miles / 25 * 60); }

function TourRouteMap({ stops, myHome, dayKey }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const stopsKey = stops.map(h => h.id).join(",") + (myHome?.lat || "");

  useEffect(() => {
    if (!ref.current || stops.length === 0) return;

    // Load CSS
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    const init = (L) => {
      if (!ref.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

      const allPts = [];
      if (myHome?.lat) allPts.push([myHome.lat, myHome.lng]);
      stops.forEach(h => { if (h.lat) allPts.push([h.lat, h.lng]); });
      if (allPts.length === 0) return;

      const map = L.map(ref.current, { zoomControl: false, attributionControl: false, scrollWheelZoom: true });
      L.control.zoom({ position: "topright" }).addTo(map);
      const tileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 18, subdomains: "abcd" });
      tileLayer.on("tileerror", () => {
        if (!map._osfallback) { map._osfallback = true; tileLayer.remove(); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map); }
      });
      tileLayer.addTo(map);
      mapRef.current = map;

      // Home marker
      if (myHome?.lat) {
        L.marker([myHome.lat, myHome.lng], {
          icon: L.divIcon({ className: "", html: '<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#d946ef);display:flex;align-items:center;justify-content:center;color:white;font-size:16px;box-shadow:0 2px 8px rgba(139,92,246,0.5);border:3px solid white;">🏠</div>', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18] })
        }).addTo(map).bindPopup("<b>Home</b><br/>" + (myHome.address || "Starting point"));
      }

      // Stop markers
      const colors = ["#0ea5e9", "#8b5cf6", "#10b981", "#f59e0b", "#f43f5e", "#6366f1", "#14b8a6", "#f97316"];
      const bounds = L.latLngBounds(allPts);
      stops.forEach((h, i) => {
        if (!h.lat) return;
        const color = colors[i % colors.length];
        L.marker([h.lat, h.lng], {
          icon: L.divIcon({ className: "", html: '<div style="width:28px;height:28px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;color:white;font-size:13px;font-weight:bold;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:2.5px solid white;">' + (i + 1) + '</div>', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -16] })
        }).addTo(map).bindPopup("<b>" + (i + 1) + ". " + h.address + "</b>" + (h.ohStart ? "<br/>" + formatOHTime(h.ohStart) + (h.ohEnd ? " – " + formatOHTime(h.ohEnd) : "") : "") + (h.price ? "<br/>" + fmtShort(h.price) : ""));
      });

      // Route polyline
      const routePts = [];
      if (myHome?.lat) routePts.push([myHome.lat, myHome.lng]);
      stops.forEach(h => { if (h.lat) routePts.push([h.lat, h.lng]); });
      if (routePts.length >= 2) {
        L.polyline(routePts, { color: "#0ea5e9", weight: 3, opacity: 0.7, dashArray: "8 6" }).addTo(map);
      }

      requestAnimationFrame(() => {
        if (map && ref.current) { map.invalidateSize(); map.fitBounds(bounds.pad(0.15)); }
      });
    };

    // Load Leaflet JS if not present
    if (window.L) { init(window.L); }
    else {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      script.onload = () => init(window.L);
      document.head.appendChild(script);
    }

    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [dayKey, stopsKey]);

  return <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden mb-4" style={{ height: 280 }}><div ref={ref} style={{ width: "100%", height: "100%" }} /></div>;
}

function TourPlannerScreen({ homes, onOpenHome, myHome }) {
  const [tourDays, setTourDays] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cribs_tour_days") || "{}"); } catch { return {}; }
  });
  const [activeDay, setActiveDay] = useState(null);
  const [tourNotes, setTourNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cribs_tour_notes") || "{}"); } catch { return {}; }
  });
  const [showBrowse, setShowBrowse] = useState(false);
  const [browseSearch, setBrowseSearch] = useState("");

  // Persist
  useEffect(() => { try { localStorage.setItem("cribs_tour_days", JSON.stringify(tourDays)); } catch {} supaSetDebounced("cribs_tour_days", tourDays); }, [tourDays]);
  useEffect(() => { try { localStorage.setItem("cribs_tour_notes", JSON.stringify(tourNotes)); } catch {} supaSetDebounced("cribs_tour_notes", tourNotes); }, [tourNotes]);

  const toggleHomeInDay = (dayKey, homeId) => {
    setTourDays(prev => {
      const dayList = prev[dayKey] || [];
      const next = dayList.includes(homeId) ? dayList.filter(x => x !== homeId) : [...dayList, homeId];
      return { ...prev, [dayKey]: next };
    });
  };

  const removeDay = (dayKey) => setTourDays(prev => { const n = { ...prev }; delete n[dayKey]; return n; });

  const reorderInDay = (dayKey, fromIdx, toIdx) => {
    setTourDays(prev => {
      const list = [...(prev[dayKey] || [])];
      const [item] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, item);
      return { ...prev, [dayKey]: list };
    });
  };

  const autoOptimizeDay = (dayKey) => {
    setTourDays(prev => {
      const ids = prev[dayKey] || [];
      const stops = ids.map(id => homes.find(h => h.id === id)).filter(Boolean);
      const optimized = optimizeRoute(stops);
      return { ...prev, [dayKey]: optimized.map(h => h.id) };
    });
  };

  // Collect homes with open houses
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ohHomes = homes.map(h => {
    const start = parseOHDate(h.nextOpenHouseStart);
    const end = parseOHDate(h.nextOpenHouseEnd);
    return { ...h, ohStart: start, ohEnd: end };
  });
  const upcomingOH = ohHomes.filter(h => h.ohStart && h.ohStart >= todayStart).sort((a, b) => a.ohStart - b.ohStart);

  // Group upcoming OH by date
  const ohByDate = {};
  for (const h of upcomingOH) {
    const key = getDateKey(h.ohStart);
    if (!ohByDate[key]) ohByDate[key] = { date: h.ohStart, homes: [] };
    ohByDate[key].homes.push(h);
  }

  // Build tour days list — include user-created days + OH days
  const allDayKeys = new Set([...Object.keys(tourDays), ...Object.keys(ohByDate)]);
  const daysList = [...allDayKeys].map(key => {
    const ohDay = ohByDate[key];
    const tourIds = tourDays[key] || [];
    const tourStops = tourIds.map(id => homes.find(h => h.id === id)).filter(Boolean);
    // Enrich with OH data
    const enriched = tourStops.map(h => {
      const oh = upcomingOH.find(o => o.id === h.id);
      return { ...h, ohStart: oh?.ohStart || null, ohEnd: oh?.ohEnd || null };
    });
    return { key, date: ohDay?.date || parseOHDate(key) || new Date(key), tourStops: enriched, ohHomes: ohDay?.homes || [], hasTour: tourIds.length > 0 };
  }).sort((a, b) => a.date - b.date);

  // Active day for detail view — default to first day with a tour, or first upcoming
  const activeDayObj = daysList.find(d => d.key === activeDay) || daysList.find(d => d.hasTour) || daysList[0];

  // Available homes for browsing (not sold)
  const soldSet = new Set(homes.filter(h => h.status && h.status.toLowerCase().includes("sold")).map(h => h.id));
  const browsableHomes = homes.filter(h => !soldSet.has(h.id));
  const filteredBrowse = browseSearch
    ? browsableHomes.filter(h => (h.address || "").toLowerCase().includes(browseSearch.toLowerCase()) || (h.city || "").toLowerCase().includes(browseSearch.toLowerCase()))
    : browsableHomes;

  // Day label helpers
  const dayLabel = (d) => {
    const key = getDateKey(d);
    const todayKey = getDateKey(now);
    const tom = new Date(now); tom.setDate(tom.getDate() + 1);
    if (key === todayKey) return "Today";
    if (key === getDateKey(tom)) return "Tomorrow";
    return formatOHDate(d);
  };
  const dayTag = (d) => {
    const dow = d.getDay();
    const days = Math.ceil((d - todayStart) / 86400000);
    if (days === 0) return { text: "Today", color: "sky" };
    if (days === 1) return { text: "Tomorrow", color: "sky" };
    if ((dow === 0 || dow === 6) && days <= 7) return { text: "This Weekend", color: "emerald" };
    if ((dow === 0 || dow === 6) && days <= 14) return { text: "Next Weekend", color: "amber" };
    return null;
  };

  // Route distances for active day (including home -> first stop)
  const activeStops = activeDayObj?.tourStops || [];
  const routeLegs = [];
  // Home to first stop
  if (myHome?.lat && activeStops.length > 0 && activeStops[0].lat) {
    const mi = haversine(myHome.lat, myHome.lng, activeStops[0].lat, activeStops[0].lng);
    routeLegs.push({ miles: mi, minutes: estDriveMin(mi), fromHome: true });
  }
  for (let i = 1; i < activeStops.length; i++) {
    const a = activeStops[i-1], b = activeStops[i];
    if (a.lat && b.lat) {
      const mi = haversine(a.lat, a.lng, b.lat, b.lng);
      routeLegs.push({ miles: mi, minutes: estDriveMin(mi) });
    } else routeLegs.push(null);
  }
  const totalMi = routeLegs.filter(Boolean).reduce((s, l) => s + l.miles, 0);
  const totalMin = routeLegs.filter(Boolean).reduce((s, l) => s + l.minutes, 0);

  // Color palette for stop numbers
  const stopColors = ["bg-sky-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-indigo-500", "bg-teal-500", "bg-orange-500"];

  return (
    <div className="px-4 md:px-6 py-4 md:py-6 max-w-6xl mx-auto pb-28 md:pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 anim-fade-up">
        <div>
          <h2 className="text-2xl font-bold text-stone-800 flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-sky-500 flex items-center justify-center text-white text-lg shadow-lg shadow-emerald-200/50">🗓</span>
            Tour Planner
          </h2>
          <p className="text-sm text-stone-400 mt-1">Plan your open house route &amp; build your weekend tour</p>
        </div>
        <button onClick={() => setShowBrowse(!showBrowse)}
          className={`flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-xl border transition-all ${showBrowse ? "bg-sky-50 border-sky-300 text-sky-700" : "bg-white border-stone-200 text-stone-600 hover:border-stone-300"}`}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
          Add Homes
        </button>
      </div>

      <div className="flex gap-6 flex-col lg:flex-row">
        {/* ── Left: Day Tabs + Itinerary ───────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Day selector tabs */}
          {daysList.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 anim-fade-up" style={{ animationDelay: "50ms" }}>
              {daysList.map(d => {
                const tag = dayTag(d.date);
                const isActive = activeDayObj?.key === d.key;
                const ct = (tourDays[d.key] || []).length;
                const ohCt = d.ohHomes.length;
                return (
                  <button key={d.key} onClick={() => { setActiveDay(d.key); setShowBrowse(false); }}
                    className={`flex-shrink-0 px-4 py-2.5 rounded-xl border text-left transition-all ${isActive ? "bg-white border-sky-300 shadow-md shadow-sky-100/50 ring-1 ring-sky-200" : "bg-stone-50 border-stone-200 hover:border-stone-300"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-bold ${isActive ? "text-sky-700" : "text-stone-700"}`}>{dayLabel(d.date)}</span>
                      {tag && <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-${tag.color}-100 text-${tag.color}-600 uppercase`}>{tag.text}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {ct > 0 && <span className="text-[10px] text-sky-600 font-semibold">{ct} stop{ct !== 1 ? "s" : ""}</span>}
                      {ohCt > 0 && ct === 0 && <span className="text-[10px] text-emerald-600 font-semibold">{ohCt} open house{ohCt !== 1 ? "s" : ""}</span>}
                    </div>
                  </button>
                );
              })}
              {/* Add custom day */}
              <button onClick={() => {
                const input = window.prompt("Enter a date for your tour (e.g. 3/15/2025):");
                if (input) {
                  const d = new Date(input);
                  if (!isNaN(d.getTime())) {
                    const key = getDateKey(d);
                    if (!tourDays[key]) setTourDays(prev => ({ ...prev, [key]: [] }));
                    setActiveDay(key);
                  }
                }
              }} className="flex-shrink-0 px-3 py-2.5 rounded-xl border-2 border-dashed border-stone-200 text-stone-400 hover:border-sky-300 hover:text-sky-500 transition-all text-sm font-medium">
                + Day
              </button>
            </div>
          )}

          {/* Active day itinerary */}
          {activeDayObj && (activeDayObj.hasTour || activeDayObj.ohHomes.length > 0) ? (
            <div className="anim-fade-up" style={{ animationDelay: "100ms" }}>
              {/* Day header + stats */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-stone-800">{dayLabel(activeDayObj.date)}</h3>
                  {activeStops.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-sky-600 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full">{activeStops.length} stop{activeStops.length !== 1 ? "s" : ""}</span>
                      {totalMi > 0 && <span className="text-xs font-semibold text-violet-600 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">~{totalMi.toFixed(1)} mi</span>}
                      {totalMin > 0 && <span className="text-xs font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">~{totalMin} min drive</span>}
                    </div>
                  )}
                </div>
                {activeStops.length >= 2 && (
                  <button onClick={() => autoOptimizeDay(activeDayObj.key)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors">
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    Optimize Route
                  </button>
                )}
              </div>

              {/* Tour Route Map */}
              {activeStops.length > 0 && activeStops.some(h => h.lat) && (
                <TourRouteMap stops={activeStops} myHome={myHome} dayKey={activeDayObj?.key} />
              )}

              {/* Tour stops */}
              {activeStops.length > 0 ? (
                <div className="space-y-0">
                  {activeStops.map((h, i) => {
                    const color = stopColors[i % stopColors.length];
                    const note = tourNotes[h.id] || "";
                    const school = h.school;
                    // Leg index: if myHome exists, legs are [home->0, 0->1, 1->2, ...] so leg before stop i is routeLegs[i]
                    // If no myHome, legs are [0->1, 1->2, ...] so leg before stop i (for i>0) is routeLegs[i-1]
                    const hasHomeLeg = myHome?.lat && routeLegs[0]?.fromHome;
                    const legIdx = hasHomeLeg ? i : i - 1;
                    const leg = legIdx >= 0 ? routeLegs[legIdx] : null;
                    return (
                      <div key={h.id}>
                        {/* Drive leg between stops */}
                        {leg && (i > 0 || leg.fromHome) && (
                          <div className="flex items-center gap-2 py-2 pl-3.5">
                            <div className="w-7 flex justify-center"><div className="w-0.5 h-6 bg-stone-200 rounded-full" /></div>
                            <div className="flex items-center gap-1.5 text-[10px] text-stone-400 font-medium">
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" /></svg>
                              {leg.fromHome ? "From home: " : ""}{leg.miles.toFixed(1)} mi · ~{leg.minutes} min drive
                            </div>
                          </div>
                        )}

                        {/* Stop card */}
                        <div className={`border rounded-2xl p-4 hover:border-stone-300 transition-all hover:shadow-sm group ${h.viewed ? "bg-stone-50/80 border-stone-200" : "bg-white border-stone-200"}`}>
                          <div className="flex gap-3">
                            {/* Stop number */}
                            <div className="flex flex-col items-center gap-1 flex-shrink-0">
                              <div className={`w-8 h-8 rounded-full ${color} text-white flex items-center justify-center text-sm font-bold shadow-sm`}>{i + 1}</div>
                              {/* Move arrows */}
                              <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
                                {i > 0 && <button onClick={() => reorderInDay(activeDayObj.key, i, i - 1)} className="text-stone-300 hover:text-stone-600 p-0.5"><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg></button>}
                                {i < activeStops.length - 1 && <button onClick={() => reorderInDay(activeDayObj.key, i, i + 1)} className="text-stone-300 hover:text-stone-600 p-0.5"><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg></button>}
                              </div>
                            </div>

                            {/* Main card content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => onOpenHome(h.id)} className="text-base font-bold text-stone-800 hover:text-sky-600 transition-colors truncate text-left">{h.address}</button>
                                    {h.viewed && <svg className="w-4 h-4 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                                  </div>
                                  <div className="text-xs text-stone-400 mt-0.5">{[h.city, h.zip].filter(Boolean).join(" ")}</div>
                                </div>
                                <button onClick={() => toggleHomeInDay(activeDayObj.key, h.id)} className="text-stone-300 hover:text-red-500 transition-colors p-1 flex-shrink-0" title="Remove stop">
                                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>

                              {/* Stats row */}
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                                {h.price > 0 && <span className="text-sm font-bold text-stone-800">{fmtShort(h.price)}</span>}
                                <span className="text-xs text-stone-500">{h.beds || "?"}bd / {h.baths || "?"}ba</span>
                                {h.sqft > 0 && <span className="text-xs text-stone-500">{h.sqft.toLocaleString()} sf</span>}
                                {h.ppsf > 0 && <span className="text-xs text-stone-400">${h.ppsf}/sf</span>}
                                {h.yearBuilt > 0 && <span className="text-xs text-stone-400">Built {h.yearBuilt}</span>}
                              </div>

                              {/* Open house time + School + Status badges */}
                              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                {h.ohStart && (
                                  <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                                    🏠 {formatOHTime(h.ohStart)}{h.ohEnd ? " – " + formatOHTime(h.ohEnd) : ""}
                                  </span>
                                )}
                                {school && school.rating && (
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${school.tier === "great" ? "text-sky-700 bg-sky-50 border-sky-200" : school.tier === "good" ? "text-amber-700 bg-amber-50 border-amber-200" : "text-orange-700 bg-orange-50 border-orange-200"}`}>
                                    🏫 {school.schoolName ? school.schoolName.split(" ").slice(0,2).join(" ") : ""} {school.rating}/10
                                  </span>
                                )}
                                {h.hoa > 0 && <span className="text-[10px] font-semibold text-stone-500 bg-stone-100 px-2 py-0.5 rounded-md">HOA ${h.hoa}/mo</span>}
                                {h.dom != null && <span className="text-[10px] font-semibold text-stone-500 bg-stone-100 px-2 py-0.5 rounded-md">{h.dom}d on market</span>}
                                {h.favorite && <span className="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-md">♥ Favorite</span>}
                                {h.viewed && <span className="text-[10px] font-semibold text-stone-500 bg-stone-100 border border-stone-200 px-2 py-0.5 rounded-md flex items-center gap-1"><svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Toured ✓</span>}
                              </div>

                              {/* Inline notes */}
                              <div className="mt-2">
                                <input
                                  type="text"
                                  placeholder="Add tour notes (questions to ask, things to check)..."
                                  value={note}
                                  onChange={(e) => setTourNotes(prev => ({ ...prev, [h.id]: e.target.value }))}
                                  className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-1.5 placeholder-stone-300 focus:outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-200 transition-all"
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Day has open houses but no tour stops yet */
                <div className="bg-stone-50 border border-dashed border-stone-200 rounded-2xl p-6 text-center">
                  <p className="text-stone-500 font-medium mb-1">No stops planned yet for {dayLabel(activeDayObj.date)}</p>
                  <p className="text-xs text-stone-400">Add homes from the open houses below or click "Add Homes" to browse all listings</p>
                </div>
              )}

              {/* Open houses available this day (not yet in tour) */}
              {activeDayObj.ohHomes.filter(h => !(tourDays[activeDayObj.key] || []).includes(h.id)).length > 0 && (
                <div className="mt-4">
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-wider mb-2">Available Open Houses</h4>
                  <div className="grid gap-1.5">
                    {activeDayObj.ohHomes.filter(h => !(tourDays[activeDayObj.key] || []).includes(h.id)).map(h => (
                      <div key={h.id} className={`flex items-center gap-3 border rounded-xl p-3 hover:border-emerald-300 transition-all ${h.viewed ? "bg-stone-50/80 border-stone-200" : "bg-white border-stone-200"}`}>
                        <button onClick={() => toggleHomeInDay(activeDayObj.key, h.id)}
                          className="w-6 h-6 rounded-lg border-2 border-emerald-300 hover:bg-emerald-500 hover:border-emerald-500 hover:text-white flex items-center justify-center flex-shrink-0 transition-all text-emerald-500">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => onOpenHome(h.id)} className="text-sm font-semibold text-stone-700 hover:text-sky-600 truncate text-left">{h.address}</button>
                            {h.viewed && <svg className="w-3.5 h-3.5 text-stone-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0 rounded">{formatOHTime(h.ohStart)}{h.ohEnd ? " – " + formatOHTime(h.ohEnd) : ""}</span>
                            {h.beds && <span className="text-[10px] text-stone-400">{h.beds}bd/{h.baths}ba</span>}
                            {h.sqft > 0 && <span className="text-[10px] text-stone-400">{fmtNum(h.sqft)}sf</span>}
                            {h.yearBuilt > 0 && <span className="text-[10px] text-stone-400">'{String(h.yearBuilt).slice(2)}</span>}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          {h.price > 0 && <div className="text-sm font-bold text-stone-700">{fmtShort(h.price)}</div>}
                          {h.ppsf > 0 && <div className="text-[10px] text-stone-400">${h.ppsf}/sf</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Day actions */}
              {activeDayObj.hasTour && (
                <div className="flex items-center gap-3 mt-4 pt-3 border-t border-stone-100">
                  <button onClick={() => { if (window.confirm("Remove all stops from " + dayLabel(activeDayObj.date) + "?")) removeDay(activeDayObj.key); }}
                    className="text-xs text-stone-400 hover:text-red-500 transition-colors">Clear day</button>
                </div>
              )}
            </div>
          ) : daysList.length === 0 ? (
            <div className="bg-stone-50 border border-dashed border-stone-200 rounded-2xl p-10 text-center anim-fade-up" style={{ animationDelay: "100ms" }}>
              <span className="text-5xl block mb-4">🏡</span>
              <p className="text-stone-600 font-semibold text-lg mb-2">No open houses or tours yet</p>
              <p className="text-sm text-stone-400 max-w-md mx-auto mb-4">Import a fresh Redfin CSV to pull open house dates, or click "Add Homes" to manually build a tour day.</p>
              <button onClick={() => setShowBrowse(true)}
                className="px-4 py-2 bg-sky-500 text-white font-medium rounded-xl hover:bg-sky-600 transition-colors text-sm">
                + Build a Tour
              </button>
            </div>
          ) : null}
        </div>

        {/* ── Right: Add Homes Sidebar ─────────────────── */}
        {showBrowse && (
          <div className="lg:w-80 flex-shrink-0 anim-fade-up" style={{ animationDelay: "50ms" }}>
            <div className="bg-white border border-stone-200 rounded-2xl p-4 lg:sticky lg:top-20">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-stone-700">Add to {activeDayObj ? dayLabel(activeDayObj.date) : "Tour"}</h4>
                <button onClick={() => setShowBrowse(false)} className="text-stone-400 hover:text-stone-600 p-1">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <input type="text" placeholder="Search by address..." value={browseSearch} onChange={(e) => setBrowseSearch(e.target.value)}
                className="w-full text-sm bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 mb-3 placeholder-stone-400 focus:outline-none focus:border-sky-300" />
              {!activeDayObj && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">Select or create a day first using the tabs above, then add homes to it.</p>
              )}
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {filteredBrowse.map(h => {
                  const inDay = activeDayObj && (tourDays[activeDayObj.key] || []).includes(h.id);
                  const hasOH = h.nextOpenHouseStart && parseOHDate(h.nextOpenHouseStart) >= todayStart;
                  const ohD = hasOH ? parseOHDate(h.nextOpenHouseStart) : null;
                  return (
                    <div key={h.id} className={`rounded-xl p-2.5 border transition-all ${inDay ? "bg-sky-50 border-sky-200" : h.viewed ? "bg-stone-50 border-stone-200" : "bg-white border-stone-100 hover:border-stone-200 hover:bg-stone-50"}`}>
                      <div className="flex items-start gap-2.5">
                        <button onClick={() => activeDayObj && toggleHomeInDay(activeDayObj.key, h.id)} disabled={!activeDayObj}
                          className={`w-5 h-5 mt-0.5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${inDay ? "bg-sky-500 border-sky-500 text-white" : "border-stone-300 hover:border-sky-400"} ${!activeDayObj ? "opacity-30" : ""}`}>
                          {inDay && <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <button onClick={() => onOpenHome(h.id)} className="text-xs font-bold text-stone-700 hover:text-sky-600 truncate text-left">{h.address}</button>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {h.viewed && <svg className="w-3 h-3 text-stone-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                              {h.favorite && <span className="text-[10px] text-rose-500">♥</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {h.price > 0 && <span className="text-[10px] font-bold text-stone-800">{fmtShort(h.price)}</span>}
                            {h.beds && <span className="text-[10px] text-stone-400">{h.beds}bd/{h.baths}ba</span>}
                            {h.sqft > 0 && <span className="text-[10px] text-stone-400">{fmtNum(h.sqft)}sf</span>}
                            {h.yearBuilt > 0 && <span className="text-[10px] text-stone-400">'{String(h.yearBuilt).slice(2)}</span>}
                          </div>
                          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                            {hasOH && <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1 py-0 rounded">OH {ohD ? formatOHTime(ohD) : ""}</span>}
                            {h.status && h.status.toLowerCase().includes("new") && <span className="text-[9px] font-bold text-sky-600 bg-sky-50 border border-sky-200 px-1 py-0 rounded">New</span>}
                            {h.school?.rating && <span className="text-[9px] text-stone-400">🏫 {h.school.rating}/10</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredBrowse.length === 0 && <p className="text-xs text-stone-400 text-center py-4">No homes match</p>}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="text-xs text-stone-400 pt-4 mt-6 border-t border-stone-100 anim-fade-up" style={{ animationDelay: "300ms" }}>
        {upcomingOH.length} upcoming open house{upcomingOH.length !== 1 ? "s" : ""}
        {" · "}{Object.values(tourDays).filter(d => d.length > 0).length} tour day{Object.values(tourDays).filter(d => d.length > 0).length !== 1 ? "s" : ""} planned
        {" · "}{Object.values(tourDays).flat().length} total stop{Object.values(tourDays).flat().length !== 1 ? "s" : ""}
        {soldSet.size > 0 && <span> · {soldSet.size} sold (hidden)</span>}
      </div>
    </div>
  );
}


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
        {h.viewed && <span className="text-[10px] text-teal-600 font-bold bg-teal-50 px-1.5 py-0.5 rounded">Toured ✓</span>}
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
                ) : <span className="text-stone-300">—</span>}
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
                ) : <span className="text-stone-300">—</span>}
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
function MyHomeEditor({ fin, updateFin }) {
  const [myAddr, setMyAddr] = useState(fin.myHome?.address || "407 Detering Street, Houston, TX 77007");
  const [myLat, setMyLat] = useState(fin.myHome?.lat ?? 29.7663);
  const [myLng, setMyLng] = useState(fin.myHome?.lng ?? -95.4165);
  const [geoStatus, setGeoStatus] = useState(null);
  const saveMyHome = (addr, lat, lng) => updateFin({ myHome: { address: addr, lat, lng } });
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '270ms' }}>
      <h3 className="text-sm font-semibold text-stone-700 mb-1">My Home Address</h3>
      <p className="text-xs text-stone-400 mb-3">Starting point for tour route planning and distance calculations.</p>
      <div className="space-y-2">
        <input
          type="text"
          value={myAddr}
          onChange={(e) => { setMyAddr(e.target.value); saveMyHome(e.target.value, myLat, myLng); }}
          placeholder="Enter your home address"
          className="w-full text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
        />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Latitude</label>
            <input type="number" step="0.0001" value={myLat || ""} onChange={(e) => { const v = parseFloat(e.target.value) || null; setMyLat(v); saveMyHome(myAddr, v, myLng); }}
              className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-sky-400" />
          </div>
          <div>
            <label className="text-[10px] text-stone-400 uppercase tracking-wider font-semibold">Longitude</label>
            <input type="number" step="0.0001" value={myLng || ""} onChange={(e) => { const v = parseFloat(e.target.value) || null; setMyLng(v); saveMyHome(myAddr, myLat, v); }}
              className="w-full text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 focus:outline-none focus:border-sky-400" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => {
            if (!myAddr) { setGeoStatus("Enter an address first"); return; }
            setGeoStatus("Looking up...");
            const q = encodeURIComponent(myAddr);
            fetch("https://nominatim.openstreetmap.org/search?q=" + q + "&format=json&limit=1", { headers: { "User-Agent": "CRIBSApp/1.0" } })
              .then(r => r.json())
              .then(data => {
                if (data && data[0]) {
                  const lat = parseFloat(data[0].lat);
                  const lng = parseFloat(data[0].lon);
                  setMyLat(lat); setMyLng(lng);
                  saveMyHome(myAddr, lat, lng);
                  setGeoStatus("Found: " + lat.toFixed(4) + ", " + lng.toFixed(4));
                } else { setGeoStatus("Address not found"); }
              })
              .catch(() => setGeoStatus("Geocode failed"));
          }} className="text-xs font-medium text-sky-600 hover:text-sky-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-1.5 hover:bg-sky-100 transition-colors">
            Geocode from address
          </button>
          {geoStatus && <span className="text-xs text-stone-500">{geoStatus}</span>}
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ fin, updateFin, liveRate, rateInfo, homes = [], setHomes, soldComps = [], setSoldComps, darkMode, setDarkMode, onTriggerEnrich, enrichDone }) {
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

        {/* My Home Address */}
        <MyHomeEditor fin={fin} updateFin={updateFin} />

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
            <button onClick={() => { if (window.confirm("Reset toured status on all homes?")) { const cleaned = homes.map(h => ({ ...h, viewed: false })); setHomes(cleaned); try { localStorage.setItem("cribs_homes", JSON.stringify(cleaned)); } catch {} } }}
              className="text-xs font-medium text-violet-600 hover:text-violet-800 bg-violet-50 hover:bg-violet-100 px-3 py-1.5 rounded-lg border border-violet-200 transition-colors">Reset All Toured</button>
            <button onClick={() => { if (window.confirm("Clear ALL enrichment data (flood, crime, school, parks, groceries) from every home?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.flood; delete c.crime; delete c.school; delete c.parks; delete c.groceries; return c; }); setHomes(cleaned); try { localStorage.setItem("cribs_homes", JSON.stringify(cleaned)); } catch {} window.location.reload(); } }}
              className="text-xs font-medium text-stone-600 hover:text-stone-800 bg-stone-50 hover:bg-stone-100 px-3 py-1.5 rounded-lg border border-stone-200 transition-colors">Clear All Enrichment</button>
            <button onClick={() => { if (window.confirm("Clear parks data from all homes?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.parks; return c; }); setHomes(cleaned); try { localStorage.setItem("cribs_homes", JSON.stringify(cleaned)); } catch {} window.location.reload(); } }}
              className="text-xs font-medium text-teal-600 hover:text-teal-700 bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-lg border border-teal-200 transition-colors">Clear Parks</button>
            <button onClick={() => { if (window.confirm("Clear grocery data from all homes?")) { const cleaned = homes.map(h => { const c = {...h}; delete c.groceries; return c; }); setHomes(cleaned); try { localStorage.setItem("cribs_homes", JSON.stringify(cleaned)); } catch {} window.location.reload(); } }}
              className="text-xs font-medium text-orange-600 hover:text-orange-700 bg-orange-50 hover:bg-orange-100 px-3 py-1.5 rounded-lg border border-orange-200 transition-colors">Clear Groceries</button>
          </div>
        </div>

        {/* Clear All Homes */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 anim-fade-up" style={{ animationDelay: '315ms' }}>
          <h3 className="text-sm font-semibold text-stone-700 mb-2">Clear All Homes</h3>
          <p className="text-xs text-stone-400 mb-3">Remove all homes from the list. Your notes, favorites, ratings, and other personal data will be saved and automatically restored if you re-import the same addresses.</p>
          <button onClick={() => { if (window.confirm("Clear all homes? Your notes, favorites, ratings, and pool/tax overrides will be saved and restored on re-import.")) {
            // Save user-entered data before clearing
            const userDataCache = {};
            let savedCount = 0;
            homes.forEach(h => {
              const key = normalizeAddr(h.address);
              if (!key) return;
              const userData = {};
              if (h.notes) userData.notes = h.notes;
              if (h.favorite) userData.favorite = h.favorite;
              if (h.viewed) userData.viewed = h.viewed;
              if (h.ratings && Object.keys(h.ratings).length > 0) userData.ratings = h.ratings;
              if (h.pool != null) userData.pool = h.pool;
              if (h.taxRate != null) userData.taxRate = h.taxRate;
              if (Object.keys(userData).length > 0) {
                userDataCache[key] = userData;
                savedCount++;
              }
            });
            // Merge with existing cache (don't overwrite older entries if current home has no user data)
            try {
              const existing = JSON.parse(localStorage.getItem("cribs_user_data") || "{}");
              const merged = { ...existing, ...userDataCache };
              localStorage.setItem("cribs_user_data", JSON.stringify(merged));
              supaSetDebounced("cribs_user_data", merged);
            } catch {}
            setHomes([]);
            // Save immediately — don't wait for debounced persist
            try { localStorage.setItem("cribs_homes", JSON.stringify([])); } catch {}
          }}}
            className="text-xs font-medium text-stone-600 hover:text-stone-800 bg-stone-50 hover:bg-stone-100 px-3 py-1.5 rounded-lg border border-stone-200 transition-colors">Clear All Homes</button>
          {(() => {
            try {
              const cached = JSON.parse(localStorage.getItem("cribs_user_data") || "{}");
              const count = Object.keys(cached).length;
              if (count > 0) return <p className="text-[10px] text-stone-400 mt-2">{count} home{count !== 1 ? "s" : ""} with saved personal data (will restore on re-import)</p>;
            } catch {}
            return null;
          })()}
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
        if (Array.isArray(p)) {
          // Empty array = user intentionally cleared homes, respect it
          if (p.length === 0) return [];
          // One-time migration: clear old school/appraisal data from Anthropic API so it re-fetches from NCES/HCAD
          const needsMigration = p.some(h => h.school?.ratingSource === "GreatSchools" || h.school?.nicheGrade || (h.appraisal && !h.appraisal.value) || (h.appraisal && h.appraisal.source !== "HCAD (Harris County Appraisal District)"));
          if (needsMigration) {
            const migrated = p.map(h => ({ ...h, school: null, appraisal: null }));
            localStorage.setItem("cribs_homes", JSON.stringify(migrated));
            return migrated;
          }
          return p;
        }
      }
    } catch {}
    return [
    { id: "r001", address: "6510 Sivley St", city: "Houston", state: "TX", zip: "77055", lat: 29.7971612, lng: -95.4650439, price: 1695000, beds: 4, baths: 5.0, sqft: 5288, lotSize: 8125, yearBuilt: 2025, dom: 1, ppsf: 321, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6510-Sivley-St-77055/home/30017890", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1417000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r002", address: "1410 Aldrich St", city: "Houston", state: "TX", zip: "77055", lat: 29.7954556, lng: -95.4641365, price: 1836880, beds: 5, baths: 5.5, sqft: 5032, lotSize: 7553, yearBuilt: 2026, dom: 1, ppsf: 365, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1410-Aldrich-St-77055/home/30018417", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1649000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r003", address: "9908 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8011501, lng: -95.5380544, price: 1499000, beds: 5, baths: 4.5, sqft: 4860, lotSize: 14257, yearBuilt: 2025, dom: 1, ppsf: 308, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9908-Warwana-Rd-77080/home/30044914", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1338000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." }, },
    { id: "r004", address: "1502 Adkins Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.7971551, lng: -95.5198305, price: 1100000, beds: 4, baths: 4.0, sqft: 3300, lotSize: 10166, yearBuilt: 1954, dom: 3, ppsf: 333, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1502-Adkins-Rd-77055/home/30074953", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1020000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r005", address: "9756 Westview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7929313, lng: -95.5324124, price: 1670000, beds: 4, baths: 3.5, sqft: 4200, lotSize: 8764, yearBuilt: 2026, dom: 4, ppsf: 398, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9756-Westview-Dr-77055/home/30066168", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1380000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r006", address: "1240 Mosaico Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7900874, lng: -95.4621978, price: 1388000, beds: 4, baths: 3.5, sqft: 3833, lotSize: 4896, yearBuilt: 2018, dom: 4, ppsf: 362, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1240-Mosaico-Ln-77055/home/52562067", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1183000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." }, },
    { id: "r007", address: "6534 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7963058, lng: -95.4662584, price: 1655000, beds: 4, baths: 5.0, sqft: 4832, lotSize: 8123, yearBuilt: 2025, dom: 5, ppsf: 343, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6534-Corbin-St-77055/home/30017833", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1342000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r008", address: "8006 Longridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8093655, lng: -95.4897827, price: 1050000, beds: 5, baths: 4.0, sqft: 5112, lotSize: 7957, yearBuilt: 2023, dom: 8, ppsf: 205, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8006-Longridge-Dr-77055/home/30072819", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 988000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r009", address: "7210 Jalna St", city: "Houston", state: "TX", zip: "77055", lat: 29.8022204, lng: -95.4735621, price: 1399000, beds: 5, baths: 4.0, sqft: 4337, lotSize: 7200, yearBuilt: 2026, dom: 9, ppsf: 323, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7210-Jalna-St-77055/home/30036785", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1228000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." }, },
    { id: "r010", address: "1458 Oak Tree Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7963361, lng: -95.5261206, price: 1350000, beds: 5, baths: 5.5, sqft: 4568, lotSize: 9100, yearBuilt: 2025, dom: 9, ppsf: 296, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1458-Oak-Tree-Dr-77055/home/30056132", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1238000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r011", address: "1730 Bayram", city: "Houston", state: "TX", zip: "77055", lat: 29.8012931, lng: -95.4978617, price: 2250000, beds: 4, baths: 4.5, sqft: 4125, lotSize: 8400, yearBuilt: 2025, dom: 11, ppsf: 545, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1730-Bayram-Dr-77055/home/30058158", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1863000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r012", address: "1201 Confederate Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.7902432, lng: -95.5283515, price: 1420000, beds: 4, baths: 4.5, sqft: 4482, lotSize: 8320, yearBuilt: 2025, dom: 11, ppsf: 317, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1201-Confederate-Rd-77055/home/30066150", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1235000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r013", address: "1216 Mosaico Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7896774, lng: -95.461992, price: 1173000, beds: 4, baths: 4.5, sqft: 3961, lotSize: 1685, yearBuilt: 2014, dom: 11, ppsf: 296, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1216-Mosaico-Ln-77055/home/52562063", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1076000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r014", address: "9115 Hammerly Blvd", city: "Houston", state: "TX", zip: "77080", lat: 29.8103782, lng: -95.5153388, price: 1499000, beds: 4, baths: 3.5, sqft: 4066, lotSize: 19584, yearBuilt: 2016, dom: 12, ppsf: 369, hoa: 67, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9115-Hammerly-Blvd-77080/home/29964997", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1349000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r015", address: "6502 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7962792, lng: -95.4646412, price: 1699900, beds: 5, baths: 6.0, sqft: 4855, lotSize: 8751, yearBuilt: 2025, dom: 17, ppsf: 350, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6502-Corbin-St-77055/home/30017856", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1419000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r016", address: "6711 Housman St", city: "Houston", state: "TX", zip: "77055", lat: 29.7992881, lng: -95.4687778, price: 1260000, beds: 5, baths: 4.5, sqft: 3624, lotSize: 8041, yearBuilt: 2025, dom: 24, ppsf: 348, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6711-Housman-St-77055/home/30036994", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1091000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r017", address: "1514 Jacquelyn Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7977192, lng: -95.4804267, price: 1149750, beds: 6, baths: 4.0, sqft: 4247, lotSize: 7840, yearBuilt: 1949, dom: 28, ppsf: 271, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1514-Jacquelyn-Dr-77055/home/30033639", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1032000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r018", address: "7407 Janak Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7993846, lng: -95.4763834, price: 1459000, beds: 5, baths: 5.0, sqft: 3996, lotSize: 6899, yearBuilt: 2025, dom: 28, ppsf: 365, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7407-Janak-Dr-77055/home/30078711", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1256000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r019", address: "1713 Bayram Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8005988, lng: -95.498418, price: 2099000, beds: 4, baths: 6.0, sqft: 5127, lotSize: 10798, yearBuilt: 2026, dom: 32, ppsf: 409, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1713-Bayram-Dr-77055/home/30058087", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1614000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r020", address: "1941 Coulcrest Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8070349, lng: -95.4990735, price: 1195000, beds: 5, baths: 4.5, sqft: 3914, lotSize: 7501, yearBuilt: 2026, dom: 32, ppsf: 305, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1941-Coulcrest-Dr-77055/home/30031745", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1099000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r021", address: "1518 Hillendahl Blvd", city: "Houston", state: "TX", zip: "77055", lat: 29.7981696, lng: -95.4929243, price: 2150000, beds: 5, baths: 5.5, sqft: 6444, lotSize: 13298, yearBuilt: 2015, dom: 32, ppsf: 334, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1518-Hillendahl-Blvd-77055/home/30131667", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1654000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r022", address: "7115 Raton St", city: "Houston", state: "TX", zip: "77055", lat: 29.8010162, lng: -95.4727984, price: 1492500, beds: 5, baths: 6.0, sqft: 4375, lotSize: 7200, yearBuilt: 2025, dom: 32, ppsf: 341, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7115-Raton-St-77055/home/30036845", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1269000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r023", address: "7908 Westwood Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7994469, lng: -95.4862212, price: 2700000, beds: 5, baths: 6.0, sqft: 5591, lotSize: 15999, yearBuilt: 2025, dom: 33, ppsf: 483, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7908-Westwood-Dr-77055/home/30030472", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2203000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0410M", notes: "Near Spring Branch creek tributary. BFE varies. Flood insurance required. Significant Harvey flooding in area." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r024", address: "1503 Johanna Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7974083, lng: -95.4830652, price: 1500000, beds: 4, baths: 4.5, sqft: 4993, lotSize: 12066, yearBuilt: 2004, dom: 33, ppsf: 300, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1503-Johanna-Dr-77055/home/30033575", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1357000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r025", address: "6533 Corbin St", city: "Houston", state: "TX", zip: "77055", lat: 29.7958381, lng: -95.4662585, price: 1625000, beds: 4, baths: 4.5, sqft: 4622, lotSize: 6825, yearBuilt: 2022, dom: 36, ppsf: 352, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6533-Corbin-St-77055/home/30018066", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1307000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r026", address: "8102 Montridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8085216, lng: -95.4920293, price: 1195000, beds: 4, baths: 4.5, sqft: 4240, lotSize: 7200, yearBuilt: 2025, dom: 37, ppsf: 282, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8102-Montridge-Dr-77055/home/30055700", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1059000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r027", address: "10418 Brinwood Dr", city: "Houston", state: "TX", zip: "77043", lat: 29.7953696, lng: -95.5547775, price: 1229000, beds: 5, baths: 4.5, sqft: 4173, lotSize: 10018, yearBuilt: 2026, dom: 37, ppsf: 295, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/10418-Brinwood-Dr-77043/home/30122892", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1119000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." },  },
    { id: "r028", address: "1825 Huge Oaks St", city: "Houston", state: "TX", zip: "77055", lat: 29.8042346, lng: -95.491406, price: 1049000, beds: 4, baths: 4.5, sqft: 3213, lotSize: 6760, yearBuilt: null, dom: 38, ppsf: 326, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1825-Huge-Oaks-St-77055/home/30077113", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 986000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r029", address: "6430 Rolla St", city: "Houston", state: "TX", zip: "77055", lat: 29.7930779, lng: -95.4641805, price: 1499000, beds: 4, baths: 4.0, sqft: 4703, lotSize: 8123, yearBuilt: 2017, dom: 41, ppsf: 319, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6430-Rolla-St-77055/home/30018469", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1252000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r030", address: "9926 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8011714, lng: -95.5386369, price: 1799995, beds: 5, baths: 6.0, sqft: 5632, lotSize: 14257, yearBuilt: 2026, dom: 43, ppsf: 320, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9926-Warwana-Rd-77080/home/30044908", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1511000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r031", address: "8033 Ridgeview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8096623, lng: -95.4912979, price: 1100000, beds: 5, baths: 4.5, sqft: 4031, lotSize: 7522, yearBuilt: 2026, dom: 43, ppsf: 273, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8033-Ridgeview-Dr-77055/home/30072950", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 956000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r032", address: "8029 Longridge Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.8088977, lng: -95.4911576, price: 1100000, beds: 5, baths: 4.5, sqft: 4031, lotSize: 7958, yearBuilt: 2026, dom: 43, ppsf: 273, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8029-Longridge-Dr-77055/home/30072793", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 965000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r033", address: "1731 Benbow Way", city: "Houston", state: "TX", zip: "77080", lat: 29.8017046, lng: -95.5226701, price: 1549995, beds: 4, baths: 3.5, sqft: 4252, lotSize: 14069, yearBuilt: 2026, dom: 44, ppsf: 365, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1731-Benbow-Way-77080/home/30048665", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1312000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r034", address: "9345 Leto Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8035666, lng: -95.5214137, price: 1799995, beds: 5, baths: 5.5, sqft: 5353, lotSize: 13412, yearBuilt: 2026, dom: 44, ppsf: 336, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9345-Leto-Rd-77080/home/30049012", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1445000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0410M", notes: "Near Spring Branch creek tributary. BFE varies. Flood insurance required. Significant Harvey flooding in area." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r035", address: "2021 Marnel Rd", city: "Houston", state: "TX", zip: "77055", lat: 29.8089138, lng: -95.498504, price: 1120000, beds: 5, baths: 4.5, sqft: 3750, lotSize: 9273, yearBuilt: 2025, dom: 49, ppsf: 299, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/2021-Marnel-Rd-77055/home/30068543", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 988000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r036", address: "8021 Turquoise Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.8112489, lng: -95.4906674, price: 1299999, beds: 4, baths: 4.5, sqft: 3742, lotSize: 7631, yearBuilt: 2025, dom: 50, ppsf: 347, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8021-Turquoise-Ln-77055/home/30073918", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1124000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r037", address: "8553 Western Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.804563, lng: -95.4995973, price: 1274999, beds: 4, baths: 4.5, sqft: 3922, lotSize: 8999, yearBuilt: 2025, dom: 50, ppsf: 325, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/8553-Western-Dr-77055/home/30032127", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1067000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r038", address: "6610 Housman St", city: "Houston", state: "TX", zip: "77055", lat: 29.7997135, lng: -95.4668495, price: 1595000, beds: 5, baths: 5.5, sqft: 4512, lotSize: 7501, yearBuilt: 2025, dom: 63, ppsf: 354, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/6610-Housman-St-77055/home/30018141", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1337000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r039", address: "10303 Eddystone Dr", city: "Houston", state: "TX", zip: "77043", lat: 29.7987193, lng: -95.5516996, price: 1020000, beds: 4, baths: 3.5, sqft: 3260, lotSize: 9374, yearBuilt: 1960, dom: 66, ppsf: 313, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/10303-Eddystone-Dr-77043/home/30101445", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 881000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." },  },
    { id: "r040", address: "1611 Lynnview Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.7996967, lng: -95.492471, price: 1800000, beds: 5, baths: 4.5, sqft: 5046, lotSize: 13198, yearBuilt: 2010, dom: 72, ppsf: 357, hoa: 3, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1611-Lynnview-Dr-77055/home/30131640", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1516000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r041", address: "9603 Carousel Ln", city: "Houston", state: "TX", zip: "77080", lat: 29.8136785, lng: -95.5292293, price: 1080000, beds: 5, baths: 4.5, sqft: 4089, lotSize: 7701, yearBuilt: 2026, dom: 89, ppsf: 264, hoa: 2, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9603-Carousel-Ln-77080/home/30106041", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 950000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r042", address: "7214 Blandford Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7899237, lng: -95.4747114, price: 2399995, beds: 5, baths: 4.5, sqft: 5188, lotSize: 9029, yearBuilt: 2026, dom: 93, ppsf: 463, hoa: 8, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7214-Blandford-Ln-77055/home/30104141", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2029000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r043", address: "1749 Parana Dr", city: "Houston", state: "TX", zip: "77080", lat: 29.8040211, lng: -95.5322821, price: 1349000, beds: 5, baths: 4.5, sqft: 4220, lotSize: 12392, yearBuilt: 2025, dom: 107, ppsf: 320, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1749-Parana-Dr-77080/home/30067821", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.63, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }, { entity: "HC MUD 71", rate: 0.5200 }], appraisal: { value: 1210000, year: 2025, source: "HCAD" }, flood: { zone: "AE", zoneDesc: "100-Year Floodplain", risk: "high", panel: "48201C0415M", notes: "Special Flood Hazard Area. Flood insurance required for federally backed mortgages. Check Harvey flood history." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r044", address: "1523 Cunningham Parc Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.7984458, lng: -95.4874978, price: 1189000, beds: 5, baths: 4.5, sqft: 4078, lotSize: 2914, yearBuilt: 2016, dom: 107, ppsf: 292, hoa: 292, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1523-Cunningham-Parc-Ln-77055/home/112825548", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1059000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r045", address: "1918 Ridgecrest Dr", city: "Houston", state: "TX", zip: "77055", lat: 29.805923, lng: -95.4927818, price: 1225000, beds: 5, baths: 4.5, sqft: 4080, lotSize: 9165, yearBuilt: 2026, dom: 107, ppsf: 300, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1918-Ridgecrest-Dr-77055/home/30031614", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1117000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r046", address: "1306 Zora St", city: "Houston", state: "TX", zip: "77055", lat: 29.7934132, lng: -95.4632266, price: 1695000, beds: 5, baths: 4.5, sqft: 4143, lotSize: 7622, yearBuilt: 2026, dom: 108, ppsf: 409, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1306-Zora-St-77055/home/30018492", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1486000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r047", address: "7203 Tickner St", city: "Houston", state: "TX", zip: "77055", lat: 29.7903872, lng: -95.4741456, price: 2449000, beds: 4, baths: 5.5, sqft: 5778, lotSize: 9984, yearBuilt: 2025, dom: 117, ppsf: 424, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7203-Tickner-St-77055/home/30014008", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 2057000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r048", address: "7218 Schiller St", city: "Houston", state: "TX", zip: "77055", lat: 29.7989783, lng: -95.4742359, price: 1950000, beds: 4, baths: 5.0, sqft: 5300, lotSize: 9901, yearBuilt: 2025, dom: 124, ppsf: 368, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/7218-Schiller-St-77055/home/30036933", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1701000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C+", violentPerK: 4.5, propertyPerK: 27.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Burglary"], source: "NeighborhoodScout", notes: "Spring Branch area. Property crime above average — standard for inner-loop Houston. Vehicle theft is primary concern." },  },
    { id: "r049", address: "9839 Warwana Rd", city: "Houston", state: "TX", zip: "77080", lat: 29.8007289, lng: -95.5363117, price: 1425000, beds: 5, baths: 4.5, sqft: 4173, lotSize: 12070, yearBuilt: 2026, dom: 143, ppsf: 341, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/9839-Warwana-Rd-77080/home/30044936", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1220000, year: 2025, source: "HCAD" }, flood: { zone: "X (shaded)", zoneDesc: "500-Year Floodplain", risk: "moderate", panel: "48201C0415M", notes: "Between 100-year and 500-year floodplain. Flood insurance recommended but not required." }, crime: { risk: "moderate", grade: "C", violentPerK: 5.8, propertyPerK: 33.2, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle theft", "Robbery", "Burglary"], source: "NeighborhoodScout", notes: "Near Long Point corridor. Higher property crime due to commercial proximity. New construction areas improving." },  },
    { id: "r050", address: "1720 Huge Oaks St", city: "Houston", state: "TX", zip: "77055", lat: 29.802104, lng: -95.490798, price: 1250000, beds: 4, baths: 4.5, sqft: 3765, lotSize: 4998, yearBuilt: 2024, dom: 297, ppsf: 332, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1720-Huge-Oaks-St-77055/home/194216741", viewed: false, favorite: true, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1104000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r051", address: "1131 Castellina Ln", city: "Houston", state: "TX", zip: "77055", lat: 29.788488, lng: -95.464155, price: 1250000, beds: 4, baths: 4.5, sqft: 3368, lotSize: 3515, yearBuilt: 2024, dom: 472, ppsf: 371, hoa: 560, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/1131-Castellina-Ln-77055/home/52562173", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 1104000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "moderate", grade: "B-", violentPerK: 3.2, propertyPerK: 21.5, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Vehicle break-ins", "Package theft"], source: "NeighborhoodScout", notes: "Newer residential area of Spring Branch. Below-average crime for the ZIP code. Active HOA patrols in some sections." },  },
    { id: "r052", address: "Custom Design 15218 Plan", city: "Houston", state: "TX", zip: "77043", lat: 29.820502, lng: -95.5643644, price: 1000000, beds: 5, baths: 6.0, sqft: 5580, lotSize: null, yearBuilt: null, dom: 836, ppsf: 179, hoa: 0, propertyType: "Single Family Residential", status: "Active", url: "https://www.redfin.com/TX/Houston/Houston/Custom-Design-15218/home/188417430", viewed: false, favorite: false, notes: "", ratings: emptyRatings(), pool: null, taxRate: 2.11, taxJurisdictions: [{ entity: "Harris County", rate: 0.3491 }, { entity: "HC Flood Control", rate: 0.0281 }, { entity: "Port of Houston", rate: 0.0106 }, { entity: "HC Hospital District", rate: 0.1439 }, { entity: "HC Dept of Education", rate: 0.0049 }, { entity: "City of Houston", rate: 0.5189 }, { entity: "Spring Branch ISD", rate: 1.0572 }], appraisal: { value: 929000, year: 2025, source: "HCAD" }, flood: { zone: "X", zoneDesc: "Minimal Flood Hazard", risk: "low", panel: "48201C0415M", notes: null }, crime: { risk: "low", grade: "B+", violentPerK: 2.1, propertyPerK: 14.8, nationalAvgViolent: 4.0, nationalAvgProperty: 19.6, topConcerns: ["Package theft", "Vehicle break-ins"], source: "NeighborhoodScout", notes: "Memorial-adjacent area. Lower crime than Spring Branch core. Benefits from Memorial Villages patrol spillover." },  },
  ];
  });

  // Set favicon to match app icon
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    // Rounded rect with gradient matching from-violet-500 via-fuchsia-500 to-pink-500
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.lineTo(64 - r, 0); ctx.quadraticCurveTo(64, 0, 64, r);
    ctx.lineTo(64, 64 - r); ctx.quadraticCurveTo(64, 64, 64 - r, 64);
    ctx.lineTo(r, 64); ctx.quadraticCurveTo(0, 64, 0, 64 - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, "#8b5cf6"); grad.addColorStop(0.5, "#d946ef"); grad.addColorStop(1, "#ec4899");
    ctx.fillStyle = grad; ctx.fill();
    // White house icon
    ctx.fillStyle = "white"; ctx.beginPath();
    ctx.moveTo(32, 12); ctx.lineTo(10, 30); ctx.lineTo(16, 30); ctx.lineTo(16, 48);
    ctx.lineTo(27, 48); ctx.lineTo(27, 37); ctx.lineTo(37, 37); ctx.lineTo(37, 48);
    ctx.lineTo(48, 48); ctx.lineTo(48, 30); ctx.lineTo(54, 30); ctx.closePath(); ctx.fill();
    // Set as favicon
    let link = document.querySelector("link[rel~='icon']");
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = canvas.toDataURL("image/png");
    // Also set page title
    document.title = "CRIBS";
  }, []);

  // Cloud sync: load from Supabase on mount
  const [cloudStatus, setCloudStatus] = useState(SUPA_ENABLED ? "loading" : "off"); // "off" | "loading" | "synced" | "error"
  useEffect(() => {
    if (!SUPA_ENABLED) return;
    let cancelled = false;
    (async () => {
      try {
        setCloudStatus("loading");
        const cloud = await supaGetAll();
        if (cancelled) return;
        if (!cloud || Object.keys(cloud).length === 0) {
          // Cloud is empty — push localStorage data up as initial seed
          setCloudStatus("synced");
          try { await supaSet("cribs_homes", homes); } catch {}
          try { await supaSet("cribs_fin", fin); } catch {}
          try { if (soldComps.length > 0) await supaSet("cribs_sold_comps", soldComps); } catch {}
          try { const ud = JSON.parse(localStorage.getItem("cribs_user_data") || "{}"); if (Object.keys(ud).length > 0) await supaSet("cribs_user_data", ud); } catch {}
          return;
        }
        // Cloud has data — use it as source of truth
        try {
          if (cloud.cribs_homes && Array.isArray(cloud.cribs_homes) && cloud.cribs_homes.length > 0) {
            if (!cancelled) setHomes(cloud.cribs_homes);
            try { localStorage.setItem("cribs_homes", JSON.stringify(cloud.cribs_homes)); } catch {}
          }
          if (cloud.cribs_fin && typeof cloud.cribs_fin === "object") {
            if (!cancelled) setFin(prev => ({ ...prev, ...cloud.cribs_fin }));
            try { localStorage.setItem("cribs_fin", JSON.stringify(cloud.cribs_fin)); } catch {}
          }
          if (cloud.cribs_sold_comps && Array.isArray(cloud.cribs_sold_comps)) {
            if (!cancelled) setSoldComps(cloud.cribs_sold_comps);
            try { localStorage.setItem("cribs_sold_comps", JSON.stringify(cloud.cribs_sold_comps)); } catch {}
          }
          if (cloud.cribs_user_data) {
            try { localStorage.setItem("cribs_user_data", JSON.stringify(cloud.cribs_user_data)); } catch {}
          }
        } catch (e) { console.warn("CRIBS cloud parse error:", e); }
        if (!cancelled) setCloudStatus("synced");
      } catch (e) {
        console.warn("CRIBS cloud sync error:", e);
        if (!cancelled) setCloudStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist homes to localStorage (debounced 1s) + cloud
  const homesTimerRef = useRef(null);
  useEffect(() => {
    if (homesTimerRef.current) clearTimeout(homesTimerRef.current);
    homesTimerRef.current = setTimeout(() => {
      try { localStorage.setItem("cribs_homes", JSON.stringify(homes)); } catch {}
      supaSetDebounced("cribs_homes", homes);
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
    const defaults = { myHome: { address: "407 Detering Street, Houston, TX 77007", lat: 29.7663, lng: -95.4165 } };
    try { const s = localStorage.getItem("cribs_fin"); if (s) { const parsed = JSON.parse(s); return { ...defaults, ...parsed }; } } catch {}
    return { cash: 750000, rate: DEFAULT_RATE, term: 30, propTax: 1.8, insurance: 3600, closing: 2.5, appreciation: 3, projYears: 10, grossIncome: 0, monthlyDebts: 0, dtiLimit: 36, places: [
    { label: "Work", address: "2322 W Grand Pkwy N, Katy, TX", lat: 29.8335, lng: -95.7675, icon: "briefcase" },
    { label: "Mom's House", address: "16015 Beechnut St, Houston, TX", lat: 29.6880, lng: -95.5810, icon: "heart" },
  ], ...defaults };
  });
  const updateFin = (updates) => setFin((prev) => {
    const next = { ...prev, ...updates };
    try { localStorage.setItem("cribs_fin", JSON.stringify(next)); } catch {}
    supaSetDebounced("cribs_fin", next);
    return next;
  });
  const maxBudget = useMemo(() => calcMaxBudget(fin), [fin]);
  useEffect(() => { try { localStorage.setItem("cribs_sold_comps", JSON.stringify(soldComps)); } catch {} supaSetDebounced("cribs_sold_comps", soldComps); }, [soldComps]);

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
  const [enrichTrigger, setEnrichTrigger] = useState(0);
  const [enrichProgress, setEnrichProgress] = useState({ done: 0, total: 0 });
  useEffect(() => {
    if (enrichingRef.current) return;
    // Skip if all homes already have data
    const needsEnrich = homes.filter(h => !h.flood || !h.crime || !h.school || !h.parks || !h.groceries || !h.appraisal);
    if (needsEnrich.length === 0) { setEnrichDone(true); return; }
    enrichingRef.current = true;
    setEnrichProgress({ done: 0, total: needsEnrich.length });
    let cancelled = false;
    let doneCount = 0;

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
        if (!h.appraisal) needs.push("appraisal");
        if (needs.length === 0) { doneCount++; if (!cancelled) setEnrichProgress(p => ({ ...p, done: doneCount })); continue; }

        try {
          const promises = [];
          if (needs.includes("flood")) promises.push(fetchFloodZone(h.address, h.city, h.state, h.zip, h.lat, h.lng).catch(() => null).then(r => ["flood", r]));
          if (needs.includes("crime")) promises.push(fetchCrime(h.address, h.city, h.state, h.zip, h.lat, h.lng).catch(() => null).then(r => ["crime", r]));
          if (needs.includes("school")) promises.push(fetchSchool(h.address, h.city, h.state, h.zip, h.lat, h.lng).catch(() => null).then(r => ["school", r]));
          if (needs.includes("parks")) promises.push(fetchNearbyParks(h.address, h.city, h.state, h.zip, h.lat, h.lng).catch(() => null).then(r => ["parks", r]));
          if (needs.includes("groceries")) promises.push(fetchNearbyGroceries(h.lat, h.lng).catch(() => null).then(r => ["groceries", r]));
          if (needs.includes("appraisal")) promises.push(fetchAppraisal(h.address, h.city, h.state, h.lat, h.lng).catch(() => null).then(r => ["appraisal", r]));

          const results = await Promise.all(promises);
          if (cancelled) return;

          const updates = {};
          for (const [type, data] of results) {
            if (type === "flood" && data?.zone) updates.flood = data;
            if (type === "crime" && data?.risk) updates.crime = data;
            if (type === "school" && data?.schoolName) updates.school = data;
            if (type === "parks" && data?.parks) updates.parks = data;
            if (type === "groceries" && data) updates.groceries = data;
            if (type === "appraisal" && data?.appraisalValue) updates.appraisal = { value: data.appraisalValue, year: data.appraisalYear, source: data.source };
          }
          if (Object.keys(updates).length > 0) {
            setHomes(prev => prev.map(ph => ph.id === h.id ? { ...ph, ...updates } : ph));
          }
        } catch (e) {
          // Skip this home on error, continue to next
        }

        doneCount++;
        if (!cancelled) setEnrichProgress(p => ({ ...p, done: doneCount }));

        // Delay between homes to avoid rate limiting
        if (!cancelled && i < homesList.length - 1) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    };

    // Only iterate homes that actually need enrichment
    const timeoutMs = Math.max(120000, needsEnrich.length * 15000);
    const safetyTimeout = setTimeout(() => { if (!cancelled) { setEnrichDone(true); enrichingRef.current = false; } }, timeoutMs);
    enrich(needsEnrich).then(() => { clearTimeout(safetyTimeout); if (!cancelled) { setEnrichDone(true); enrichingRef.current = false; } });
    return () => { cancelled = true; clearTimeout(safetyTimeout); enrichingRef.current = false; };
  }, [enrichTrigger]);

  const [importDialog, setImportDialog] = useState(null);
  const [deletedAddresses, setDeletedAddresses] = useState(() => {
    try { return JSON.parse(localStorage.getItem("cribs_deleted") || "[]"); } catch { return []; }
  });
  const trackDeletion = (addr) => {
    if (!addr) return;
    setDeletedAddresses(prev => {
      const next = [...new Set([...prev, addr.toLowerCase()])];
      localStorage.setItem("cribs_deleted", JSON.stringify(next));
      return next;
    });
  };

  const handleImport = (newHomes) => {
    const byAddr = new Map(homes.map((h) => [normalizeAddr(h.address), h]));
    const newList = [], dupeList = [], deletedList = [];
    for (const incoming of newHomes) {
      const key = normalizeAddr(incoming.address);
      if (!key) { newList.push(incoming); continue; }
      if (byAddr.has(key)) { dupeList.push(incoming); }
      else if (deletedAddresses.some(a => normalizeAddr(a) === key)) { deletedList.push(incoming); }
      else { newList.push(incoming); }
    }
    setImportDialog({ newList, dupeList, deletedList, includeDeleted: false, markFavorites: false });
  };

  const confirmImport = () => {
    if (!importDialog) return;
    const { newList, dupeList, deletedList, includeDeleted, markFavorites } = importDialog;
    // Load any cached user data from previous clears
    let userDataCache = {};
    try { userDataCache = JSON.parse(localStorage.getItem("cribs_user_data") || "{}"); } catch {}
    const restoreUserData = (h) => {
      const key = normalizeAddr(h.address);
      const cached = userDataCache[key];
      if (!cached) return h;
      const restored = { ...h };
      if (cached.notes) restored.notes = cached.notes;
      if (cached.favorite) restored.favorite = cached.favorite;
      if (cached.viewed) restored.viewed = cached.viewed;
      if (cached.ratings) restored.ratings = cached.ratings;
      if (cached.pool != null) restored.pool = cached.pool;
      if (cached.taxRate != null) restored.taxRate = cached.taxRate;
      // Remove from cache after restoring
      delete userDataCache[key];
      return restored;
    };
    setHomes((prev) => {
      const byAddr = new Map(prev.map((h) => [normalizeAddr(h.address), h]));
      const merged = [...prev];
      for (const incoming of dupeList) {
        const key = normalizeAddr(incoming.address);
        const existing = byAddr.get(key);
        if (existing) {
          const idx = merged.findIndex((h) => h.id === existing.id);
          if (idx !== -1) merged[idx] = { ...existing, price: incoming.price ?? existing.price, beds: incoming.beds ?? existing.beds, baths: incoming.baths ?? existing.baths, sqft: incoming.sqft ?? existing.sqft, lotSize: incoming.lotSize ?? existing.lotSize, yearBuilt: incoming.yearBuilt ?? existing.yearBuilt, dom: incoming.dom ?? existing.dom, ppsf: incoming.ppsf ?? existing.ppsf, hoa: incoming.hoa ?? existing.hoa, propertyType: incoming.propertyType || existing.propertyType, status: incoming.status || existing.status, soldDate: incoming.soldDate || existing.soldDate, nextOpenHouseStart: incoming.nextOpenHouseStart || existing.nextOpenHouseStart, nextOpenHouseEnd: incoming.nextOpenHouseEnd || existing.nextOpenHouseEnd, url: incoming.url || existing.url, city: incoming.city || existing.city, state: incoming.state || existing.state, zip: incoming.zip || existing.zip, address: incoming.address || existing.address, ...(markFavorites ? { favorite: true } : {}) };
        }
      }
      for (const h of newList) { merged.push(restoreUserData(markFavorites ? { ...h, favorite: true } : h)); }
      if (includeDeleted) {
        for (const h of deletedList) { merged.push(restoreUserData(markFavorites ? { ...h, favorite: true } : h)); }
        const removedKeys = new Set(deletedList.map(d => normalizeAddr(d.address)));
        const updated = deletedAddresses.filter(a => !removedKeys.has(normalizeAddr(a)));
        localStorage.setItem("cribs_deleted", JSON.stringify(updated));
        setDeletedAddresses(updated);
      }
      return merged;
    });
    // Save updated cache (with restored entries removed)
    try { localStorage.setItem("cribs_user_data", JSON.stringify(userDataCache)); } catch {}
    supaSetDebounced("cribs_user_data", userDataCache);
    setImportDialog(null);
    // Trigger enrichment for newly imported homes
    enrichingRef.current = false;
    setEnrichDone(false);
    setEnrichProgress({ done: 0, total: 0 });
    setEnrichTrigger(t => t + 1);
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

  const openHome = (hOrId, filteredList) => {
    let h = typeof hOrId === "string" ? homes.find(x => x.id === hOrId) : hOrId;
    if (!h) return;
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
    let nextHome = homes.find(h => h.id === navList[nextIdx]);
    if (nextHome) {
      if (!nextHome.viewed) {
        setHomes((prev) => prev.map((x) => x.id === nextHome.id ? { ...x, viewed: true } : x));
        nextHome = { ...nextHome, viewed: true };
      }
      setActiveHome(nextHome); window.scrollTo(0, 0);
    }
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
            <span className="text-[10px] text-stone-400 font-medium ml-1 self-end mb-0.5">v1.7.5</span>
            {SUPA_ENABLED && (
              <span title={cloudStatus === "synced" ? "Cloud sync active" : cloudStatus === "loading" ? "Syncing..." : cloudStatus === "error" ? "Cloud sync error — using local data" : "Cloud sync disabled"}
                className={`w-2 h-2 rounded-full ml-1 self-end mb-1 flex-shrink-0 ${cloudStatus === "synced" ? "bg-emerald-400" : cloudStatus === "loading" ? "bg-amber-400 animate-pulse" : cloudStatus === "error" ? "bg-red-400" : "bg-stone-300"}`} />
            )}
          </button>
          <nav className="flex gap-1 bg-stone-100 rounded-lg p-0.5 border border-stone-200">
            <button onClick={goList} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "list" || screen === "detail" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>Homes</button>
            <button onClick={() => setScreen("tours")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "tours" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
              Tours {(() => { const ct = homes.filter(h => h.nextOpenHouseStart && parseOHDate(h.nextOpenHouseStart) >= new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())).length; return ct > 0 ? <span className="ml-1 bg-emerald-100 text-emerald-600 text-xs px-1.5 py-0.5 rounded-full font-semibold">{ct}</span> : null; })()}
            </button>
            <button onClick={() => setScreen("compare")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "compare" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
              Compare {compareList.length > 0 && <span className="ml-1 bg-violet-100 text-violet-600 text-xs px-1.5 py-0.5 rounded-full font-semibold">{compareList.length}</span>}
            </button>
            <button onClick={() => setScreen("settings")} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${screen === "settings" ? "bg-white text-sky-600 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>Settings</button>
          </nav>
        </div>
      </header>
      <div className="hidden md:block h-16" /> {/* Spacer for fixed header */}

      <div className="max-w-[1600px] mx-auto">
        {screen === "list" && <HomeListScreen homes={homes} setHomes={setHomes} onOpenHome={openHome} compareList={compareList} toggleCompare={toggleCompare} onImport={handleImport} fin={fin} rateInfo={rateInfo} schoolFilter={schoolFilter} setSchoolFilter={setSchoolFilter} maxBudget={maxBudget} enrichDone={enrichDone} enrichProgress={enrichProgress} />}
        {screen === "detail" && activeHome && <ErrorBoundary><HomeDetailScreen home={activeHome} onBack={goList} onUpdate={updateHome} onDelete={(id) => { const found = homes.find(x => x.id === id); if (found) trackDeletion(found.address); setHomes((p) => p.filter((x) => x.id !== id)); }} compareList={compareList} toggleCompare={toggleCompare} fin={fin} navList={navList} onNavigate={navigateHome} allHomes={homes} soldComps={soldComps} onFilterBySchool={(name) => { setSchoolFilter(name); setScreen("list"); }} maxBudget={maxBudget} /></ErrorBoundary>}
        {screen === "compare" && <CompareScreen homes={homes} compareList={compareList} toggleCompare={toggleCompare} clearCompare={() => setCompareList([])} onOpenHome={openHome} fin={fin} />}
        {screen === "tours" && <TourPlannerScreen homes={homes} onOpenHome={openHome} myHome={fin.myHome} />}
        {screen === "settings" && <SettingsScreen fin={fin} updateFin={updateFin} liveRate={liveRate} rateInfo={rateInfo} homes={homes} setHomes={setHomes} soldComps={soldComps} setSoldComps={setSoldComps} darkMode={darkMode} setDarkMode={setDarkMode} onTriggerEnrich={() => { enrichingRef.current = false; setEnrichDone(false); setEnrichProgress({ done: 0, total: 0 }); setEnrichTrigger(t => t + 1); }} enrichDone={enrichDone} />}
      </div>

      {/* Import Dialog */}
      {importDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setImportDialog(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-4 anim-scale-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-stone-800">Import Summary</h2>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between p-3 rounded-xl bg-sky-50 border border-sky-200">
                <div className="flex items-center gap-2"><span className="text-lg">🆕</span><span className="text-sm font-medium text-stone-700">New Homes</span></div>
                <span className="text-lg font-bold text-sky-600 tabular-nums">{importDialog.newList.length}</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-xl bg-amber-50 border border-amber-200">
                <div className="flex items-center gap-2"><span className="text-lg">🔄</span><span className="text-sm font-medium text-stone-700">Duplicates (will update)</span></div>
                <span className="text-lg font-bold text-amber-600 tabular-nums">{importDialog.dupeList.length}</span>
              </div>
              {importDialog.deletedList.length > 0 && (
                <div className="p-3 rounded-xl bg-orange-50 border border-orange-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><span className="text-lg">🗑️</span><span className="text-sm font-medium text-stone-700">Previously Deleted</span></div>
                    <span className="text-lg font-bold text-orange-600 tabular-nums">{importDialog.deletedList.length}</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={importDialog.includeDeleted} onChange={(e) => setImportDialog(prev => ({ ...prev, includeDeleted: e.target.checked }))}
                      className="w-4 h-4 rounded border-stone-300 text-orange-500 focus:ring-orange-200" />
                    <span className="text-xs text-stone-600">Re-import deleted homes</span>
                  </label>
                </div>
              )}
            </div>
            {/* Mark as favorites toggle */}
            <label className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 cursor-pointer hover:bg-amber-100/70 transition-colors">
              <input type="checkbox" checked={importDialog.markFavorites} onChange={(e) => setImportDialog(prev => ({ ...prev, markFavorites: e.target.checked }))}
                className="w-4 h-4 rounded border-stone-300 text-amber-500 focus:ring-amber-200" />
              <span className="flex items-center gap-1.5"><span className="text-sm">⭐</span><span className="text-xs font-medium text-stone-700">Import all as favorites</span></span>
            </label>
            <div className="flex gap-2.5 pt-1">
              <button onClick={() => setImportDialog(null)}
                className="flex-1 py-3 rounded-xl font-medium text-sm border border-stone-200 text-stone-600 hover:bg-stone-50 active:bg-stone-100 transition-colors">Cancel</button>
              <button onClick={confirmImport}
                className="flex-1 py-3 rounded-xl font-medium text-sm bg-sky-500 text-white hover:bg-sky-600 active:bg-sky-700 shadow-sm shadow-sky-200 transition-colors">
                Import {importDialog.newList.length + importDialog.dupeList.length + (importDialog.includeDeleted ? importDialog.deletedList.length : 0)} Homes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-stone-200 z-50 safe-area-pb">
        <div className="flex">
          {[
            { id: "list", label: "Homes", icon: <HomeIcon className="w-5 h-5" /> },
            { id: "tours", label: "Tours", icon: <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>, badge: homes.filter(h => h.nextOpenHouseStart && parseOHDate(h.nextOpenHouseStart) >= new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())).length || 0 },
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
        .star-tap { transition: transform 0.15s ease, filter 0.2s ease, opacity 0.2s ease; }
        .star-tap:hover { transform: scale(1.15); filter: drop-shadow(0 0 4px rgba(251,191,36,0.35)); }
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
