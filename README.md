# Godrej Park Retreat - DG Dashboard

A zero-backend V1 dashboard for DG fuel and running-hours monitoring.

## Architecture

- Frontend: HTML5 + CSS3 + Vanilla JavaScript
- Charts: Apache ECharts
- Data sync: Python + GitHub Actions
- Source: Google Drive / Google Sheet
- Published data: JSON
- Hosting: GitHub Pages

## DG configuration

- Yard 1: DG1, DG2, DG3 — Towers A-E
- Yard 2: DG4, DG5, DG6 — Towers F-H
- External tank: 1000 L per yard
- Warning threshold: 30%
- Critical threshold: 20%

## Repository setup

Recommended GitHub Pages configuration:

1. Settings → Pages
2. Source: GitHub Actions

The workflow `.github/workflows/deploy.yml` publishes the `site/` directory.

## Google Sheet access

The source Google Sheet is public, so no Google service account or credential
is required.

The sync reads the public XLSX export of the spreadsheet.

## Daily sync

`.github/workflows/sync-data.yml` checks the source around the daily update window and publishes new data when today's readings are available.

The workflow can also be started manually.

## Important

The exact source workbook layout is intentionally not hard-coded into the dashboard. The parser is isolated in `scripts/sync_sheet.py` and `config/column_mapping.json` so the source format can be adjusted without changing the UI.

No sample DG readings are committed. Until the first successful sync, the dashboard shows a clear "No data synced yet" state.


## Current source-sheet layout

The importer currently understands the monthly workbook layout:

- Worksheet names such as `JUL 26`, `Aug 26`, `Sep 26` provide month/year.
- First column contains day numbers.
- Six DGs are grouped into four columns each:
  `Running Hours`, `Diesel Balance %`, `Diesel Balance Actuals`, `Fuel Added`.
- DG1, DG2, DG3 are Yard 1; DG4, DG5, DG6 are Yard 2.


### External tanks
The DG worksheet does not contain external-tank readings. The dashboard therefore shows the explicitly supplied last-known values: Yard 1 = 625 L / 1000 L and Yard 2 = 650 L / 1000 L, dated 17-Jul-2026. These are not treated as DG-sheet current readings.
