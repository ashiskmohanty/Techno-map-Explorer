# PS Process Explorer — Techno-Map Explorer

An interactive dashboard that maps **SAP Project System (PS) / Professional Services** business processes to their underlying **custom ABAP and BW-IP (BW Integrated Planning) objects**, with dependency/flow maps, a searchable custom-object catalogue, a natural-language **Object Finder** assistant, and an optional **live SAP MS1** connection.

> ⚠️ This repository is **code-only**. The SAP business data (object catalogue, descriptions, authors) and credentials are intentionally **not** committed. Generate the dashboard data locally from your own Excel exports (see [Getting started](#getting-started)).

---

## Features

- **PS Process tiles (2-level drill-down)** — Level-1 process areas (Project Set up → Planning → Forecast → Execution → Closure → Reporting → Livesite) ordered from a mapping file, each drilling into its Level-2 sub-processes and then the technical objects.
- **Object hierarchy** — ABAP (Function Module → Class → Method) and BW-IP (Planning Sequence → Planning Function → Filter/FOX formula) trees per process.
- **Dependency & Flow Map** — clean hierarchical (dagre) graph across ABAP & BW objects with **zoom in/out/fit/reset**, hover-to-isolate, and hidden isolated nodes to reduce clutter. Pulls real **where-used** cross-references when SAP is connected.
- **Custom Objects catalogue** — sortable table of every Z*/Y* object with per-column wildcard (`*`) filters, global search, and **Excel export**.
- **Object Finder assistant** — ask in plain English ("which FM deletes cube data?"); it ranks objects by matching your words against descriptions, names, technical details and category, and (when live) scans **ABAP/FOX code comments** in SAP MS1.
- **Live SAP MS1 connection** — configure from the UI (⚙) and **Refresh** the custom-object repository straight from SAP via RFC.

---

## Architecture

| File | Purpose |
|------|---------|
| `index.html` | Dashboard UI (tabs, tiles, graphs, catalogue, assistant). |
| `app.js` | Front-end logic: tiles, drill-down, Cytoscape graphs, table, assistant ranking, SAP calls. |
| `app.py` | Flask server + JSON API (`/api/data`, `/api/refresh`, `/api/sap/*`, `/api/assistant/code`). |
| `build_data.py` | ETL: reads the source Excel workbooks → normalised `data.json` / `data.js`. |
| `sap_connect.py` | SAP MS1 connector (pyrfc): read custom objects, where-used, code comments. |
| `export_process_tiles.py` | Exports the visible process tiles to `Process_Tiles.xlsx`. |
| `requirements.txt` | Python dependencies. |
| `sap_config.example.json` | Template for the (git-ignored) `sap_config.json`. |

### Data sources (kept local)
- `Latest PE Objects - Unused code.xlsx` — custom ABAP objects
- `SAP PSPE - BWIP Object Analysis.xlsx` — custom BW-IP objects
- `BPML V1.0.xlsx` — Business Process Master List (L1/L2/L3)
- `Process_Tiles - Mapping with L1 process.xlsx` — L2 → L1 tile mapping + display order

---

## Getting started

### 1. Install dependencies
```powershell
pip install -r requirements.txt
```

### 2. Provide the source Excel workbooks
Place the four Excel files listed above next to the scripts (these are git-ignored).

### 3. Build the dashboard data
```powershell
python build_data.py
```
This produces `data.json` (served) and `data.js` (used when opening `index.html` directly via `file://`).

### 4. Run the server
```powershell
python app.py
```
Open http://127.0.0.1:5000

---

## Live SAP MS1 connection (optional)

The **Refresh from SAP MS1** button and the code-comment search require a live RFC connection.

1. Install the SAP NetWeaver RFC SDK, then `pip install pyrfc`.
2. Configure connection details in the dashboard (**⚙ SAP Connection**), or copy `sap_config.example.json` → `sap_config.json`.
3. For shared setups, prefer environment variables over storing the password:
   `SAP_ASHOST`, `SAP_SYSNR`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWD`, `SAP_LANG`.

It reads custom (Z*/Y*) objects from the development packages **`ZPS_PROJ_EXEC`**, **`Z_PROF_SERVICES`**, **`ZCPM`** (client 122) via `TADIR`, expands function groups → function modules and classes → methods, and reads where-used (`WBCROSSGT`) and ABAP source comments (`RPY_PROGRAM_READ`).

`sap_config.json` is **git-ignored** and never committed.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/data` | Current dashboard data. |
| GET | `/api/sap/status` | Whether pyrfc is installed / connection configured. |
| POST | `/api/sap/config` | Save SAP connection settings. |
| POST | `/api/sap/test` | Test the SAP connection. |
| POST | `/api/refresh` | Refresh the repository (live SAP, else rebuild from Excel). |
| POST | `/api/sap/whereused` | Live where-used dependency edges. |
| POST | `/api/assistant/code` | Live ABAP/FOX code-comment search for the assistant. |

---

## Security notes

- Credentials (`sap_config.json`) and all SAP business data (`*.xlsx`, `data.json`, `data.js`) are excluded via `.gitignore`.
- Prefer the `SAP_PASSWD` environment variable over storing the password on disk.
- The bundled Flask server is for local/development use; put it behind a production WSGI server if hosting.

---

## Tech stack

Python · Flask · openpyxl / xlrd · pyrfc (optional) · Cytoscape.js + dagre · Chart.js · SheetJS (xlsx).
