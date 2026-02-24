#!/usr/bin/env python3
"""
CRIBS — Redfin Stingray API Scraper
====================================
Pulls active listings from Redfin's unofficial Stingray API for Spring Branch
Houston, then enriches each listing with property details (tax info, school
ratings, walk scores, etc.).

Outputs:
  1. redfin_listings.csv      — raw CSV from Redfin search
  2. redfin_enriched.json     — enriched data ready to paste into CRIBS

Usage:
  python redfin_stingray.py                    # default Spring Branch search
  python redfin_stingray.py --zip 77055,77080  # custom zip codes
  python redfin_stingray.py --sold 6mo         # sold in last 6 months
"""

import argparse
import csv
import io
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
import pandas as pd

# ═══════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════

BASE = "https://www.redfin.com"

# Spring Branch / Memorial area zip codes
DEFAULT_ZIPS = ["77055", "77080", "77024", "77043", "77079"]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.redfin.com/",
}

# Rate-limiting: be respectful
REQUEST_DELAY = 1.5  # seconds between detail requests


# ═══════════════════════════════════════════════════════════════════════
# Step 1: Search — Download CSV of listings
# ═══════════════════════════════════════════════════════════════════════

def search_listings(
    zip_codes: list[str],
    min_price: int = 900_000,
    max_price: int = 2_100_000,
    min_beds: int = 3,
    min_sqft: int = 2500,
    property_types: str = "1",  # 1=SFR
    sold: bool = False,
    sale_period: str = None,
    num_homes: int = 350,
) -> pd.DataFrame:
    """
    Hit /stingray/api/gis-csv to download listings as CSV.

    This is the same endpoint Redfin's "Download All" button uses.
    You can reverse-engineer the URL by applying filters on redfin.com
    and copying the "Download All" link.
    """
    session = requests.Session()
    session.headers.update(HEADERS)

    all_frames = []

    for zip_code in zip_codes:
        params = {
            "al": 1,
            "market": "houston",
            "min_price": min_price,
            "max_price": max_price,
            "min_num_beds": min_beds,
            "min_listing_approx_size": min_sqft,
            "num_homes": num_homes,
            "ord": "redfin-recommended-asc",
            "page_number": 1,
            "region_id": zip_code,
            "region_type": 2,  # 2 = zip code
            "sf": "1,2,3,5,6,7",
            "status": 9,  # 9 = active, 130 = sold
            "uipt": property_types,
            "v": 8,
        }

        if sold:
            params["status"] = 130
            if sale_period:
                params["sold_within_days"] = {
                    "1mo": 30, "3mo": 90, "6mo": 180,
                    "1yr": 365, "2yr": 730, "3yr": 1095, "5yr": 1825,
                }.get(sale_period, 180)

        url = f"{BASE}/stingray/api/gis-csv"
        print(f"  → Searching zip {zip_code}...", end=" ", flush=True)

        try:
            resp = session.get(url, params=params, timeout=30)
            resp.raise_for_status()

            # CSV response
            content = resp.content.decode("utf-8")
            if content.strip().startswith("<!DOCTYPE") or len(content) < 50:
                print(f"⚠ blocked or empty (status {resp.status_code})")
                continue

            df = pd.read_csv(io.StringIO(content))
            print(f"✓ {len(df)} listings")
            all_frames.append(df)

        except requests.RequestException as e:
            print(f"✗ Error: {e}")

        time.sleep(REQUEST_DELAY)

    if not all_frames:
        print("\n⚠ No listings found. Redfin may be blocking requests.")
        print("  Try the manual approach: go to redfin.com, apply your filters,")
        print("  and click 'Download All' to get the CSV, then use --csv flag.\n")
        return pd.DataFrame()

    combined = pd.concat(all_frames, ignore_index=True)
    # Deduplicate by MLS#
    if "MLS#" in combined.columns:
        combined = combined.drop_duplicates(subset=["MLS#"], keep="first")

    return combined


# ═══════════════════════════════════════════════════════════════════════
# Step 2: Enrich — Get property details via Stingray API
# ═══════════════════════════════════════════════════════════════════════

def parse_stingray_json(text: str) -> dict:
    """
    Stingray API prepends '{}&&' to JSON responses as a security measure.
    Strip that prefix and parse.
    """
    cleaned = re.sub(r"^.*?&&", "", text, count=1)
    return json.loads(cleaned)


def get_initial_info(session: requests.Session, redfin_url: str) -> dict | None:
    """
    Call /stingray/api/home/details/initialInfo to get propertyId + listingId.
    """
    # Extract the path portion from full Redfin URL
    path = redfin_url.replace("https://www.redfin.com", "")

    url = f"{BASE}/stingray/api/home/details/initialInfo"
    params = {"path": path}

    try:
        resp = session.get(url, params=params, timeout=15)
        if resp.status_code != 200:
            return None
        data = parse_stingray_json(resp.text)
        payload = data.get("payload", {})
        if payload.get("responseCode") != 200:
            return None
        return {
            "propertyId": payload.get("propertyId"),
            "listingId": payload.get("listingId"),
            "path": path,
        }
    except Exception:
        return None


def get_below_the_fold(session: requests.Session, property_id, listing_id=None) -> dict | None:
    """
    Call /stingray/api/home/details/belowTheFold to get detailed property data:
    - Tax assessment history
    - School info
    - Walk/transit/bike scores
    - Property details
    """
    url = f"{BASE}/stingray/api/home/details/belowTheFold"
    params = {
        "propertyId": property_id,
        "accessLevel": 1,
    }
    if listing_id:
        params["listingId"] = listing_id

    try:
        resp = session.get(url, params=params, timeout=15)
        if resp.status_code != 200:
            return None
        return parse_stingray_json(resp.text).get("payload", {})
    except Exception:
        return None


def get_above_the_fold(session: requests.Session, property_id, listing_id=None) -> dict | None:
    """
    Call /stingray/api/home/details/aboveTheFold for listing-level details.
    """
    url = f"{BASE}/stingray/api/home/details/aboveTheFold"
    params = {
        "propertyId": property_id,
        "accessLevel": 1,
    }
    if listing_id:
        params["listingId"] = listing_id

    try:
        resp = session.get(url, params=params, timeout=15)
        if resp.status_code != 200:
            return None
        return parse_stingray_json(resp.text).get("payload", {})
    except Exception:
        return None


def extract_tax_info(below_fold: dict) -> dict:
    """Pull latest tax assessment from belowTheFold data."""
    try:
        tax_records = below_fold.get("publicRecordsInfo", {}).get("allTaxInfo", [])
        if not tax_records:
            return {}
        # Sort by year descending
        latest = sorted(tax_records, key=lambda x: x.get("rollYear", 0), reverse=True)[0]
        land = latest.get("taxableLandValue", 0) or 0
        improvement = latest.get("taxableImprovementValue", 0) or 0
        return {
            "appraisalValue": land + improvement,
            "appraisalYear": latest.get("rollYear"),
            "taxableLand": land,
            "taxableImprovement": improvement,
            "annualTax": latest.get("taxPaid"),
        }
    except Exception:
        return {}


def extract_school_info(below_fold: dict) -> list[dict]:
    """Pull school ratings from belowTheFold data."""
    try:
        schools = []
        school_data = below_fold.get("schoolsAndDistrictsInfo", {}).get("servingThisHome", [])
        for s in school_data:
            schools.append({
                "name": s.get("schoolName", ""),
                "rating": s.get("rating"),
                "parentRating": s.get("parentRating"),
                "type": s.get("schoolType", ""),
                "grades": s.get("gradeRanges", ""),
                "distance": s.get("distanceInMiles"),
                "enrollment": s.get("enrollment"),
                "studentTeacherRatio": s.get("studentTeacherRatio"),
            })
        return schools
    except Exception:
        return []


def extract_walkscores(above_fold: dict) -> dict:
    """Pull walk/transit/bike scores from aboveTheFold data."""
    try:
        ws = above_fold.get("walkScore", {})
        return {
            "walkScore": ws.get("walkScore"),
            "transitScore": ws.get("transitScore"),
            "bikeScore": ws.get("bikeScore"),
        }
    except Exception:
        return {}


def enrich_listing(session: requests.Session, row: dict, index: int, total: int) -> dict:
    """
    Given a CSV row from the search results, call the detail APIs
    to get tax, school, and score data.
    """
    url_col = [c for c in row.keys() if "URL" in c.upper()]
    redfin_url = row.get(url_col[0]) if url_col else None

    address = row.get("ADDRESS", "Unknown")
    print(f"  [{index+1}/{total}] {address}...", end=" ", flush=True)

    enriched = {
        "address": row.get("ADDRESS"),
        "city": row.get("CITY"),
        "state": row.get("STATE OR PROVINCE"),
        "zip": str(row.get("ZIP OR POSTAL CODE", "")),
        "price": row.get("PRICE"),
        "beds": row.get("BEDS"),
        "baths": row.get("BATHS"),
        "sqft": row.get("SQUARE FEET"),
        "lotSize": row.get("LOT SIZE"),
        "yearBuilt": row.get("YEAR BUILT"),
        "dom": row.get("DAYS ON MARKET"),
        "ppsf": row.get("$/SQUARE FEET"),
        "hoa": row.get("HOA/MONTH"),
        "propertyType": row.get("PROPERTY TYPE"),
        "status": row.get("STATUS"),
        "lat": row.get("LATITUDE"),
        "lng": row.get("LONGITUDE"),
        "url": redfin_url,
        "mls": row.get("MLS#"),
        "soldDate": row.get("SOLD DATE"),
        "saleType": row.get("SALE TYPE"),
    }

    if not redfin_url:
        print("⚠ no URL")
        return enriched

    # Step 2a: Get property IDs
    info = get_initial_info(session, redfin_url)
    if not info:
        print("⚠ no initial info")
        return enriched

    time.sleep(0.5)

    # Step 2b: Get detailed info
    property_id = info["propertyId"]
    listing_id = info.get("listingId")

    below = get_below_the_fold(session, property_id, listing_id)
    if below:
        enriched["tax"] = extract_tax_info(below)
        enriched["schools"] = extract_school_info(below)

    time.sleep(0.5)

    above = get_above_the_fold(session, property_id, listing_id)
    if above:
        enriched["scores"] = extract_walkscores(above)

    print("✓")
    time.sleep(REQUEST_DELAY)

    return enriched


# ═══════════════════════════════════════════════════════════════════════
# Step 3: Convert to CRIBS format
# ═══════════════════════════════════════════════════════════════════════

def to_cribs_format(listing: dict, idx: int) -> dict:
    """Convert an enriched listing to CRIBS home object format."""
    tax = listing.get("tax", {})
    schools = listing.get("schools", [])
    scores = listing.get("scores", {})

    # Find elementary school (PK-5 or K-5)
    elem = None
    for s in schools:
        grades = s.get("grades", "")
        if any(g in grades.lower() for g in ["pk", "k-5", "prek", "k-4", "k-6"]):
            elem = s
            break
    if not elem and schools:
        elem = schools[0]

    school_obj = None
    if elem:
        rating = elem.get("rating")
        tier = "below"
        if rating and rating >= 8:
            tier = "top"
        elif rating and rating >= 5:
            tier = "good"

        school_obj = {
            "schoolName": elem.get("name", ""),
            "district": "SBISD",
            "rating": rating,
            "ratingSource": "GreatSchools",
            "tier": tier,
            "grades": elem.get("grades", ""),
            "enrollment": elem.get("enrollment"),
            "nicheGrade": None,
            "testScores": None,
            "studentTeacherRatio": elem.get("studentTeacherRatio"),
            "notes": "",
            "distance": f"{elem.get('distance', '?')} mi" if elem.get("distance") else None,
        }

    appraisal_obj = None
    if tax.get("appraisalValue"):
        appraisal_obj = {
            "value": tax["appraisalValue"],
            "year": tax.get("appraisalYear", 2025),
            "source": "HCAD",
        }

    cribs = {
        "id": f"r{idx+1:03d}",
        "address": listing.get("address", ""),
        "city": listing.get("city", "Houston"),
        "state": listing.get("state", "TX"),
        "zip": listing.get("zip", ""),
        "lat": listing.get("lat"),
        "lng": listing.get("lng"),
        "price": listing.get("price"),
        "beds": listing.get("beds"),
        "baths": listing.get("baths"),
        "sqft": listing.get("sqft"),
        "lotSize": listing.get("lotSize"),
        "yearBuilt": listing.get("yearBuilt"),
        "dom": listing.get("dom"),
        "ppsf": listing.get("ppsf"),
        "hoa": listing.get("hoa") or 0,
        "propertyType": listing.get("propertyType", "Single Family Residential"),
        "status": listing.get("status", "Active"),
        "url": listing.get("url", ""),
        "viewed": False,
        "favorite": False,
        "notes": "",
        "ratings": {"kitchen": 0, "living": 0, "master": 0, "office": 0, "bedrooms": 0},
        "pool": None,
    }

    if appraisal_obj:
        cribs["appraisal"] = appraisal_obj
    if school_obj:
        cribs["school"] = school_obj

    # Walk scores
    if scores:
        cribs["walkScore"] = scores.get("walkScore")
        cribs["transitScore"] = scores.get("transitScore")
        cribs["bikeScore"] = scores.get("bikeScore")

    return cribs


# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="CRIBS Redfin Stingray Scraper")
    parser.add_argument("--zip", default=",".join(DEFAULT_ZIPS), help="Comma-separated zip codes")
    parser.add_argument("--min-price", type=int, default=900_000)
    parser.add_argument("--max-price", type=int, default=2_100_000)
    parser.add_argument("--min-beds", type=int, default=3)
    parser.add_argument("--min-sqft", type=int, default=2500)
    parser.add_argument("--sold", default=None, help="Sold period: 1mo, 3mo, 6mo, 1yr, 3yr, 5yr")
    parser.add_argument("--csv", default=None, help="Skip search, use existing CSV file")
    parser.add_argument("--enrich", action="store_true", default=True, help="Enrich with detail APIs")
    parser.add_argument("--no-enrich", dest="enrich", action="store_false", help="Skip enrichment")
    parser.add_argument("--limit", type=int, default=None, help="Limit enrichment to N listings")
    parser.add_argument("--output", default="redfin_output", help="Output filename prefix")
    args = parser.parse_args()

    out_dir = Path("/mnt/user-data/outputs")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")

    # ── Step 1: Get listings ──────────────────────────────────────
    if args.csv:
        print(f"\n📂 Loading CSV: {args.csv}")
        df = pd.read_csv(args.csv)
        print(f"   {len(df)} listings loaded\n")
    else:
        zips = [z.strip() for z in args.zip.split(",")]
        is_sold = args.sold is not None

        print(f"\n🏠 CRIBS Redfin Stingray Scraper")
        print(f"   Zips: {', '.join(zips)}")
        print(f"   Price: ${args.min_price:,} – ${args.max_price:,}")
        print(f"   Beds: {args.min_beds}+ | SqFt: {args.min_sqft:,}+")
        print(f"   Mode: {'Sold (' + args.sold + ')' if is_sold else 'Active listings'}")
        print()

        df = search_listings(
            zip_codes=zips,
            min_price=args.min_price,
            max_price=args.max_price,
            min_beds=args.min_beds,
            min_sqft=args.min_sqft,
            sold=is_sold,
            sale_period=args.sold,
        )

        if df.empty:
            sys.exit(1)

    # Save raw CSV
    csv_path = out_dir / f"{args.output}_{timestamp}.csv"
    df.to_csv(csv_path, index=False)
    print(f"\n📄 Raw CSV saved: {csv_path.name} ({len(df)} listings)")

    # ── Step 2: Enrich ────────────────────────────────────────────
    if args.enrich and not df.empty:
        session = requests.Session()
        session.headers.update(HEADERS)

        rows = df.to_dict("records")
        if args.limit:
            rows = rows[:args.limit]

        print(f"\n🔍 Enriching {len(rows)} listings with property details...\n")

        enriched = []
        for i, row in enumerate(rows):
            try:
                result = enrich_listing(session, row, i, len(rows))
                enriched.append(result)
            except KeyboardInterrupt:
                print("\n\n⚠ Interrupted. Saving what we have...\n")
                break
            except Exception as e:
                print(f"✗ Error: {e}")
                enriched.append(row)

        # Save enriched JSON
        json_path = out_dir / f"{args.output}_{timestamp}_enriched.json"
        with open(json_path, "w") as f:
            json.dump(enriched, f, indent=2, default=str)
        print(f"\n📋 Enriched JSON saved: {json_path.name}")

        # ── Step 3: Convert to CRIBS format ──────────────────────
        cribs_homes = [to_cribs_format(e, i) for i, e in enumerate(enriched)]
        cribs_path = out_dir / f"{args.output}_{timestamp}_cribs.json"
        with open(cribs_path, "w") as f:
            json.dump(cribs_homes, f, indent=2, default=str)
        print(f"🏡 CRIBS format saved: {cribs_path.name}")

        # Summary
        print(f"\n{'='*50}")
        print(f"  Total listings: {len(cribs_homes)}")
        with_tax = sum(1 for h in cribs_homes if h.get("appraisal"))
        with_school = sum(1 for h in cribs_homes if h.get("school"))
        print(f"  With tax data:  {with_tax}")
        print(f"  With school:    {with_school}")
        print(f"{'='*50}\n")

    print("Done! ✓\n")


if __name__ == "__main__":
    main()
