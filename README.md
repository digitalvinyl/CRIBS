# CRIBS — Home Search & Analysis

Smart home search and analysis tool for Houston real estate. Built with React + Tailwind CSS.

## Features

- **52 active listings** in Spring Branch / Memorial area with enriched data
- **Financial modeling** — mortgage calculator, tax breakdown, insurance estimates
- **Value scoring** — algorithmic ranking by $/sqft, appraisal gap, lot size, school rating
- **Offer analysis** — comp-based pricing with aggressive/competitive/strong tiers
- **School ratings** — GreatSchools data with tier badges and tooltips
- **Flood zone mapping** — FEMA zone classification with insurance impact
- **Crime data** — neighborhood safety grades and stats
- **Side-by-side compare** — pick any two homes for detailed comparison
- **Dark mode** — auto-detects system preference with manual toggle
- **CSV import** — drag & drop Redfin CSV to add new listings
- **Data persistence** — all changes saved to localStorage automatically

## Quick Start

```bash
npm install
npm run dev
```

Opens at `http://localhost:3000`.

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your repo
3. Framework: **Vite** (auto-detected)
4. Click **Deploy**

That's it. Live in ~60 seconds.

## Tech Stack

- React 18 (Vite)
- Tailwind CSS 3
- Zero external API dependencies — all data is embedded + localStorage

## Project Structure

```
cribs-app/
├── index.html          # Entry HTML
├── package.json        # Dependencies
├── vite.config.js      # Vite configuration
├── tailwind.config.js  # Tailwind configuration
├── postcss.config.js   # PostCSS for Tailwind
└── src/
    ├── main.jsx        # React mount point
    ├── index.css       # Tailwind directives
    └── App.jsx         # CRIBS application (single-file)
```
