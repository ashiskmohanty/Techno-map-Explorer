# PS Process Explorer — Techno-Map Explorer

An interactive dashboard that maps **SAP Project System (PS) / Professional Services** business processes to their underlying **custom ABAP and BW-IP (BW Integrated Planning) objects**, with dependency/flow maps, a searchable custom-object catalogue, a natural-language **Object Finder** assistant, and an optional **live SAP MS1** connection.

> ⚠️ This repository is **code-only**. The SAP business data (object catalogue, descriptions, authors) and credentials are intentionally **not** committed. Generate the dashboard data locally from your own Excel exports (see [Getting started](#getting-started)).

---

## Features

- **PS Process tiles (2-level drill-down)** — Level-1 process areas (Project Set up → Planning → Forecast → Execution → Closure → Reporting → Livesite) ordered from a mapping file, each drilling into its Level-2 sub-processes and then the technical objects.
- **Object hierarchy** — ABAP (Function Module → Class → Method) and BW-IP (Planning Sequence → Planning Function → Filter/FOX formula) trees per process.
- **Dependency & Flow Map** — clean hierarchical (dagre) graph across ABAP & BW objects with **zoom in/out/fit/reset**, hover-to-isolate, and hidden isolated nodes to reduce clutter. Pulls real **where-used** cross-references when SAP is connected.
- **Custom Objects catalogue** — sortable table of every Z*/Y* object with per-column wildcard (`*`) filters, global search, and **Excel export**.
- **Object Finder assistant** — ask in plain English ("which FM deletes cube data?"); it ranks objects by matching your words against descriptions, names, technical details and category, computes an **absolute accuracy** and only surfaces matches **above 80%**, and (when live) scans **ABAP/FOX code comments** in SAP MS1.
- **Live SAP MS1 search toggle** — a switch in the assistant: off = local catalogue only; on = also queries SAP MS1 in real time (Z*/Y* objects in the PS packages only).
- **Assistant training** — correct a wrong answer inline ("✎ Teach the correct object"); future similar questions surface your verified answer first. Includes a 📚 manager (select / select-all / batch delete) and an optional **central store** shared across the team.
- **Two ways to connect to SAP MS1** — full **RFC** (via `pyrfc` + SAP NW RFC SDK) or **SDK-free HTTPS/OData** (works on any Python; connection test, ADT repository search, OData service discovery). A header dot shows a **verified-live** connection (green only when SAP actually responds).
- **Live SAP MS1 connection** — configure from the UI (⚙) and **Refresh** the custom-object repository straight from SAP.

---

## Architecture

| File | Purpose |
|------|---------|
| `index.html` | Dashboard UI (tabs, tiles, graphs, catalogue, assistant). |
| `app.js` | Front-end logic: tiles, drill-down, Cytoscape graphs, table, assistant ranking, SAP calls. |
| `app.py` | Flask server + JSON API (`/api/data`, `/api/refresh`, `/api/sap/*`, `/api/assistant/*`). |
| `build_data.py` | ETL: reads the source Excel workbooks → normalised `data.json` / `data.js`. |
| `sap_connect.py` | SAP MS1 **RFC** connector (pyrfc): read custom objects, where-used, FOX/code comments, OData objects. |
| `sap_http.py` | SAP MS1 **HTTPS/OData** connector (no SDK): connection test, ADT repository search, OData catalog. |
| `llm.py` | Optional LLM bridge (Azure OpenAI / OpenAI) for understanding generic questions. |
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

The **Refresh from SAP MS1**, the live assistant search, and the code-comment scan need a live connection. There are **two ways** to connect:

### Option A — RFC (full object reads)
1. Install the SAP NetWeaver RFC SDK, then `pip install pyrfc` (needs a Python version with a pyrfc wheel, e.g. 3.11/3.12).
2. Configure in the dashboard (**⚙ SAP Connection**), or copy `sap_config.example.json` → `sap_config.json`.
3. Prefer environment variables over storing the password:
   `SAP_ASHOST`, `SAP_SYSNR`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWD`, `SAP_LANG`.

Reads Z*/Y* objects from the packages **`ZPS_PROJ_EXEC`**, **`Z_PROF_SERVICES`**, **`ZCPM`** via `TADIR`, expands function groups → function modules and classes → methods, and reads where-used (`WBCROSSGT`) and source comments (`RPY_PROGRAM_READ`).

### Option B — HTTPS/OData (no SDK, any Python)
Use this when `pyrfc` can't be installed. In **⚙ SAP Connection**, fill the **MS1 Web base URL** (e.g. `https://host:44300`) plus user/password, then **Test connection**. It uses the SAP Gateway/ADT REST services (`/sap/bc/adt/...`, `/sap/opu/odata/iwfnd/catalogservice`). Env vars: `SAP_HTTP_BASE`, and `SAP_HTTP_INSECURE=1` to skip TLS verification for self-signed certs.

The assistant's live search is restricted to **Z/Y objects in the three development packages** only. `sap_config.json` is **git-ignored** and never committed.

---

## Assistant training & team sharing

When an answer is wrong, click **"✎ Not right? Teach the correct object"**, enter the correct object (+ optional note) and Save. The correction is stored and surfaces first for similar future questions. Manage entries via the 📚 icon (select, select-all, delete).

**Central store for teams** — by default corrections live in a local `corrections.json`. Point every user's app at one shared file so the whole team benefits from each other's teachings:

```powershell
setx PSPE_CORR_FILE "\\yourserver\share\pspe\corrections.json"
```

Writes are atomic and cross-process locked (SMB-safe), and each entry records its author + timestamp. The manager shows a **● shared / ● local** badge. For heavy multi-user load, host a single shared instance of the app, or back the store with a database.

### Optional LLM (generic-question understanding)
Set either Azure OpenAI (`AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`) or OpenAI (`OPENAI_API_KEY`, optional `OPENAI_MODEL`) env vars. The LLM only classifies intent and extracts keywords — object matching stays grounded in the real repository. Without a key, local intent rules are used.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/data` | Current dashboard data. |
| GET | `/api/sap/status` | Connection readiness (RFC + HTTP). |
| POST | `/api/sap/config` | Save SAP connection settings. |
| POST | `/api/sap/test` | Test the SAP connection (RFC or HTTP). |
| POST | `/api/refresh` | Refresh the repository (live SAP, else rebuild from Excel). |
| POST | `/api/sap/whereused` | Live where-used dependency edges. |
| POST | `/api/sap/odata` | Discover custom OData services. |
| POST | `/api/assistant/sapsearch` | Live SAP MS1 search (Z/Y in PS packages). |
| POST | `/api/assistant/code` | Live ABAP/FOX code-comment search. |
| GET/POST | `/api/assistant/llm` | LLM status / interpret a message. |
| GET | `/api/assistant/teachings` | List taught corrections. |
| POST | `/api/assistant/teach` | Add a correction. |
| POST | `/api/assistant/teach/delete` | Batch-delete corrections. |

---

## Security notes

- Credentials (`sap_config.json`), the corrections store (`corrections.json`), and all SAP business data (`*.xlsx`, `data.json`, `data.js`) are excluded via `.gitignore`.
- Prefer the `SAP_PASSWD` environment variable over storing the password on disk; use `SAP_HTTP_INSECURE` only when a self-signed cert requires it.
- The bundled Flask server is for local/development use; put it behind a production WSGI server if hosting for a team.

---

## Tech stack

Python · Flask · openpyxl / xlrd · pyrfc (optional, RFC) · urllib (SDK-free HTTPS/OData & LLM) · Cytoscape.js + dagre · Chart.js · SheetJS (xlsx).
