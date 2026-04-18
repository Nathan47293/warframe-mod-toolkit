# Warframe Toolkit

A zero-dependency local web app that fetches live price data from [warframe.market](https://warframe.market) to help you make smarter mod and arcane trading decisions in Warframe.

## Tools

### Mod Flipper
Find the most profitable Rank 10 mods to flip (buy at R0, rank up with endo, sell at R10). Classifies mods into 6 types: Archon, Galvanized, Primed, Gold, Silver, and Bronze. Each mod shows flip profit, endo cost to rank up, plat per 1k endo (true ROI on your endo investment), and a composite **Value Score** that ranks mods by trading efficiency. Includes per-mod **Sim R0** input and a global **Endo/Plat** cost basis to simulate exact profit from a hypothetical buy order.

### Endo Dissolve
Calculate the endo-per-plat efficiency of buying R10 mods and dissolving them for endo. Classifies mods by rarity tier (Primed/Archon, Galv/Gold, Silver, Bronze) with accurate endo return values. Includes per-mod **Sim Price** input to calculate what endo/plat you'd get at a hypothetical buy price.

### Vosfor Dissolve
Calculate the vosfor-per-plat efficiency of buying arcanes and dissolving them. Shows two rows per arcane (R0 and max rank) with hardcoded vosfor values for 100+ tradeable arcanes across 5 rarity tiers (Legendary, Rare, Uncommon, Common, Tektolyst). Includes per-arcane **Sim Price** input.

### Arcane Packs
Expected plat value calculator for 9 vosfor-purchasable arcane collection packs (200 vosfor each). Features:
- **Dissolve Threshold** — arcanes with max rank price below the threshold get dissolved for vosfor recycling
- **Min Volume** — arcanes below this 48hr trade volume are treated as illiquid and dissolved
- **Vosfor/Plat cost basis** — defaults to median of top 5 vosfor dissolve entries; used to calculate pack cost in plat and ROI
- **Geometric series recycling** — dissolving cheap arcanes returns vosfor to buy more packs; Total EV = Direct Plat ÷ (1 − recycled vosfor ÷ 200)
- **ROI** — (EV − Pack Cost) ÷ Pack Cost × 100
- Per-arcane breakdown with rarity-grouped drop rates, max rank prices, volumes, unit prices, and vosfor values

## Formulas

| Metric | Formula |
|--------|---------|
| **Flip Profit** | Sell SMA (R10) − Buy SMA (R0) |
| **Plat/1k Endo** | Flip Profit ÷ Endo Cost × 1000 |
| **Value Score** | 0.6 × Plat/1k Endo percentile rank + 0.4 × min(Volume ÷ 48, 1) × 100 |
| **Sim Profit** | R10 Sell Price − Sim R0 Price − (Endo Cost ÷ Endo/Plat) |
| **Endo/Plat** | Endo Return ÷ R10 Price |
| **Vosfor/Plat** | Vosfor Return ÷ Arcane Price |
| **Pack Direct EV** | Σ (drop chance × unit plat value) × 3 arcanes per pack |
| **Pack Total EV** | Direct EV ÷ (1 − recycled vosfor ÷ 200) |
| **Pack ROI** | (Total EV − Pack Cost) ÷ Pack Cost × 100 |

### Value Score Design

The Value Score ranks mods by combining endo efficiency with market liquidity:

- **Plat/1k Endo (60%)** — percentile ranked against all mods. Captures true ROI on endo investment, normalizing across rarity tiers so a Silver mod using 20,460 endo is fairly compared against a Primed mod using 40,920 endo.
- **Volume (40%)** — raw linear score capped at 48 trades per 48 hours (1 trade/hr average). Anything above 48 volume scores identically, so high-liquidity mods don't drown out high-efficiency ones. This is intentionally NOT percentile ranked to avoid cliff effects near common volume clusters.

### Endo Values

| Tier | Endo to R10 | Dissolve Return (R10) |
|------|-------------|----------------------|
| Primed / Archon | 40,920 | 30,710 |
| Galvanized / Gold | 30,690 | 23,033 |
| Silver | 20,460 | 15,355 |
| Bronze | 10,230 | 7,678 |

### Vosfor Values

Each arcane has a base vosfor value at R0. Max rank multiplier is ×21 for R5 arcanes and ×10 for R3 arcanes.

### Arcane Collections

9 collections available for 200 vosfor each: Ostron, Solaris, Necralisk, Duviri, Eidolon, Cavia, Hollvania, Holdfast, and Steel. Each has rarity-grouped arcane contents with empirically verified drop rates (Ostron and Solaris use corrected rates that differ from official drop tables).

## Architecture

**Zero dependencies.** The entire app is a single HTML file (~1,600 lines) with inline CSS and vanilla JavaScript, plus a tiny Python proxy server. No npm, no frameworks, no build step.

- `warframe_toolkit.html` — the complete app (UI + logic)
- `server.py` — Python CORS proxy (~80 lines, standard library only)
- `run_toolkit.bat` — Windows launcher

### Data Flow

1. Browser requests `/api/v2/items` → Python proxy forwards to warframe.market → returns full item catalog
2. Browser filters to ~132 rank-10 mods + ~160 arcanes
3. Parallel fetch of `/api/v1/items/{slug}/statistics` for each item (3 workers, 500ms stagger)
4. 48-hour closed trade stats parsed: SMA preferred, fallback to weighted avg or avg price
5. Results cached in localStorage (24-hour freshness), auto-fetches if stale

### Rate Limiting

- 3 concurrent workers with 500ms delay between requests
- Exponential backoff on HTTP 429: 2s → 4s → 8s, up to 3 retries
- Errors counted but non-blocking — partial data is still rendered

## Quick Start

1. Make sure [Python 3](https://www.python.org/downloads/) is installed
2. Double-click `run_toolkit.bat` (or run `python server.py` from a terminal)
3. The app opens automatically at `http://localhost:8777`
4. Click **Fetch Data** in the sidebar — all tabs populate from a single fetch (~2-3 min)

## Color Coding

### Mod Flipper
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Flip Profit | ≥80p | ≥60p | <60p |
| Value Score | ≥75 | ≥50 | <50 |

### Endo Dissolve
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Endo/Plat | ≥500 | ≥300 | <300 |

### Vosfor Dissolve
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Vosfor/Plat | ≥15 | ≥8 | <8 |

### Arcane Packs
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Pack EV | ≥10p | ≥5p | <5p |
| ROI | ≥200% | ≥50% | <50% |
| Volume | ≥20 | ≥5 | <5 |

## Requirements

- Python 3.6+ (no pip packages needed)
- A web browser
