// Vercel Serverless Function — fetches latest 30-year fixed mortgage rate
// from Freddie Mac's Primary Mortgage Market Survey (PMMS) data via FRED.
// No API key required for this approach.

export default async function handler(req, res) {
  // Cache response for 12 hours
  res.setHeader("Cache-Control", "s-maxage=43200, stale-while-revalidate=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Try Freddie Mac PMMS CSV first (official source, no auth needed)
    const csvUrl = "https://www.freddiemac.com/pmms/docs/PMMS_history.csv";
    const csvRes = await fetch(csvUrl, {
      headers: { "User-Agent": "CRIBS-App/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (csvRes.ok) {
      const text = await csvRes.text();
      const lines = text.trim().split("\n");

      // CSV format: Date, 30-yr rate, 30-yr points, 15-yr rate, 15-yr points, ...
      // Find the last non-empty line with data
      for (let i = lines.length - 1; i > 0; i--) {
        const cols = lines[i].split(",");
        if (cols.length >= 2) {
          const rate = parseFloat(cols[1]);
          const date = cols[0]?.trim();
          if (!isNaN(rate) && rate > 0 && rate < 20) {
            return res.status(200).json({
              rate,
              source: "Freddie Mac PMMS",
              asOf: date,
            });
          }
        }
      }
    }
  } catch (e) {
    // Freddie Mac CSV failed, try backup
  }

  try {
    // Backup: Scrape current rate from Freddie Mac PMMS page
    const pageRes = await fetch("https://www.freddiemac.com/pmms", {
      headers: { "User-Agent": "CRIBS-App/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (pageRes.ok) {
      const html = await pageRes.text();
      // Look for the 30-year rate in the page — typically in a pattern like "6.76%" near "30-Yr"
      const match = html.match(/30-Year[^]*?(\d+\.\d+)%/i)
        || html.match(/(\d+\.\d+)%[^]*?30-Year/i)
        || html.match(/"thirtyYearFixed"[^}]*?"rate"\s*:\s*"?(\d+\.?\d*)/i)
        || html.match(/30-yr[^]*?(\d\.\d{1,2})%/i);

      if (match) {
        const rate = parseFloat(match[1]);
        if (rate > 2 && rate < 15) {
          return res.status(200).json({
            rate,
            source: "Freddie Mac PMMS",
            asOf: new Date().toISOString().split("T")[0],
          });
        }
      }
    }
  } catch (e) {
    // Page scrape failed too
  }

  // Final fallback
  return res.status(200).json({
    rate: null,
    source: null,
    asOf: null,
    error: "Could not fetch live rate",
  });
}
