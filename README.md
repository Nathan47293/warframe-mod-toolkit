# Warframe Mod Toolkit

A local web app that fetches live price data from [warframe.market](https://warframe.market) to help you make smarter mod trading decisions.

![Dark themed UI with sortable, filterable mod data](https://img.shields.io/badge/warframe-mod%20toolkit-00e5ff?style=flat-square)

## Tools

### Mod Flipper
Find the most profitable Rank 10 mods to flip (buy at R0, rank up, sell at R10). Ranks mods using an **Opportunity Score** that balances profit with trade volume.

### Endo Dissolve
Calculate the endo-per-plat efficiency of buying R10 mods and dissolving them for endo. Classifies mods by rarity tier (Primed/Archon, Galv/Gold, Silver, Bronze) with accurate endo return values.

## Features

- **Live data** from warframe.market's API (fetches ~350 rank-10 mods)
- **Two analysis tools** in a sidebar-navigated UI
- **Sortable columns** with three-state cycling (descending → ascending → unsorted)
- **Filterable** by mod name, type, and various metrics per tab
- **Smart pricing**: uses SMA when available, falls back to weighted avg, then cheapest live listing
- **24-hour caching** via localStorage — instant load on revisit, manual refresh anytime
- **Rate limit handling** with exponential backoff retry on 429 responses
- **Dark gaming aesthetic** UI

## Formulas

| Metric | Formula |
|--------|---------|
| **Flip Profit** | Sell SMA (R10) − Buy SMA (R0) |
| **Opportunity Score** | Flip Profit × ln(R10 Volume + 1) |
| **Endo per Plat** | Endo Return ÷ R10 Price |

### Endo Dissolve Values (R10)

| Tier | Endo |
|------|------|
| Primed / Archon | 30,710 |
| Galvanized / Gold | 23,033 |
| Silver | 15,355 |
| Bronze | 7,678 |

## Quick Start

1. Make sure [Python 3](https://www.python.org/downloads/) is installed
2. Double-click `run_flipper.bat` (or run `python server.py` from a terminal)
3. The app opens automatically at `http://localhost:8777`
4. Click **Fetch Data** in the sidebar — both tabs populate from a single fetch (~2-3 min)

## Files

| File | Description |
|------|-------------|
| `run_flipper.bat` | Windows launcher — double-click to start |
| `server.py` | Local Python server that proxies warframe.market API |
| `warframe_mod_flipper.html` | The app UI (HTML/CSS/JS) |

## Requirements

- Python 3.6+ (no pip packages needed — uses only built-in libraries)
- A web browser

## Color Coding

### Mod Flipper
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Flip Profit | ≥80p | ≥60p | <60p |
| Opp Score | ≥300 | ≥250 | <250 |

### Endo Dissolve
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Endo/Plat | ≥500 | ≥300 | <300 |
