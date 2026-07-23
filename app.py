"""
PS Process Explorer  -  local web server & SAP MS1 refresh backend.

Endpoints
---------
GET  /                -> dashboard (index.html)
GET  /api/data        -> current data.json (rebuilds from Excel if missing)
GET  /api/sap/status  -> is pyrfc installed / is a connection configured
POST /api/sap/config  -> save SAP MS1 connection settings (from the UI)
POST /api/sap/test    -> open a live session and return system info
POST /api/refresh     -> refresh the custom-object repository:
                          1. try a live SAP MS1 RFC read (sap_connect.py)
                          2. otherwise rebuild from the Excel exports

Run:  python app.py         then open  http://127.0.0.1:5000

Live SAP MS1 connection
-----------------------
Configure it from the dashboard (⚙ SAP Connection) or copy
`sap_config.example.json` to `sap_config.json`. Credentials may also be set
via SAP_ASHOST / SAP_SYSNR / SAP_CLIENT / SAP_USER / SAP_PASSWD environment
variables (recommended for the password). Requires `pip install pyrfc` and
the SAP NetWeaver RFC SDK. Without it the Refresh button re-reads the latest
Excel exports. See sap_connect.py for the read logic.
"""
from __future__ import annotations

import json
import os

from flask import Flask, jsonify, request, send_from_directory

import build_data
import sap_connect

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=HERE, static_url_path="")


@app.after_request
def _no_cache(resp):
    """Stop the browser serving a stale index.html / app.js / data.json."""
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


# --------------------------------------------------------------------------- #
def load_or_build():
    path = os.path.join(HERE, "data.json")
    if not os.path.exists(path):
        build_data.build()
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #
# Live SAP MS1 read
# --------------------------------------------------------------------------- #
def _recount_process_areas(objects):
    """Rebuild the processAreas aggregation from a merged object list."""
    abap_cats = ("Function Module", "Class", "Interface", "Table Maintenance",
                 "Function Group", "Method", "Program")
    bw_cats = ("BEx Query", "Planning Sequence", "Planning Function",
               "InfoProvider", "Aggregation Level", "Filter", "InfoObject")
    areas = {}
    for o in objects:
        pa = o.get("process") or "Unassigned"
        areas.setdefault(pa, {})
        areas[pa][o["category"]] = areas[pa].get(o["category"], 0) + 1
    out = []
    for name, counts in sorted(areas.items()):
        out.append({
            "name": name,
            "total": sum(counts.values()),
            "counts": counts,
            "abap": sum(v for k, v in counts.items() if k in abap_cats),
            "bw": sum(v for k, v in counts.items() if k in bw_cats),
        })
    return out


def sap_refresh():
    """Return (data, source) reading custom objects live from SAP MS1.

    Raises on connection failure so the caller can fall back to Excel.
    Returns (None, reason) when SAP is simply not available/configured.
    """
    if not sap_connect.pyrfc_available():
        return None, "pyrfc not installed"
    cfg = sap_connect.load_config()
    if not sap_connect.is_configured(cfg):
        return None, "not configured"

    live_objects, meta = sap_connect.fetch_custom_objects(cfg)

    # keep BW + process-area assignments from the last Excel build, overlay
    # authoritative author / created / package / source from SAP by name.
    base = load_or_build()
    live_by_name = {o["name"].upper(): o for o in live_objects}
    merged = []
    seen = set()
    for o in base["objects"]:
        key = o["name"].upper()
        if o["domain"] == "ABAP" and key in live_by_name:
            live = live_by_name[key]
            o = {**o,
                 "author": live["author"] or o.get("author", ""),
                 "created": live["created"] or o.get("created", ""),
                 "package": live["package"] or o.get("package", ""),
                 "source": live["source"]}
            seen.add(key)
        merged.append(o)
    for key, live in live_by_name.items():
        if key not in seen:
            merged.append(live)

    base["objects"] = merged
    base["processAreas"] = _recount_process_areas(merged)
    base["source"] = "live"
    base["environment"] = f"SAP MS1 / {cfg.get('client', '122')} (live)"
    base["stats"] = build_data.build_stats(merged, {})
    base["sap"] = meta
    return base, "SAP MS1 (RFC)"


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/api/data")
def api_data():
    return jsonify(load_or_build())


@app.route("/api/sap/status")
def api_sap_status():
    """Connection readiness for the UI (no secrets returned)."""
    return jsonify(sap_connect.status())


@app.route("/api/sap/config", methods=["POST"])
def api_sap_config():
    """Persist SAP connection settings entered from the dashboard."""
    payload = request.get_json(silent=True) or {}
    allowed = ("ashost", "sysnr", "client", "user", "passwd", "lang",
               "saprouter", "mshost", "msserv", "group", "sysid", "packages")
    cfg = sap_connect.load_config()
    for k in allowed:
        if k in payload and payload[k] not in (None, ""):
            cfg[k] = payload[k]
    # drop password from the stored file if the user cleared it intentionally
    sap_connect.save_config(cfg)
    return jsonify({"status": "ok", "sap": sap_connect.status()})


@app.route("/api/sap/test", methods=["POST"])
def api_sap_test():
    """Open a live session and report system info."""
    payload = request.get_json(silent=True) or {}
    cfg = sap_connect.load_config()
    for k in ("ashost", "sysnr", "client", "user", "passwd", "lang",
              "saprouter", "mshost", "msserv", "group", "sysid"):
        if payload.get(k):
            cfg[k] = payload[k]
    return jsonify(sap_connect.test_connection(cfg))


@app.route("/api/sap/whereused", methods=["POST"])
def api_sap_whereused():
    """Return live where-used dependency edges for a set of object names.

    Only works when SAP is configured + reachable; otherwise returns [].
    """
    payload = request.get_json(silent=True) or {}
    names = payload.get("names") or []
    if not names:
        return jsonify({"edges": [], "source": "none"})
    try:
        edges = sap_connect.where_used(names)
        return jsonify({"edges": edges, "source": "live" if edges else "empty"})
    except Exception as e:  # unreachable / not installed -> graceful empty
        app.logger.warning("where_used failed: %s", e)
        return jsonify({"edges": [], "source": "error", "error": str(e)})


@app.route("/api/assistant/code", methods=["POST"])
def api_assistant_code():
    """Scan ABAP/FOX code comments in SAP MS1 for the question terms.

    Live SAP only; returns {} when not connected so the assistant still works
    from object descriptions alone.
    """
    payload = request.get_json(silent=True) or {}
    names = payload.get("names") or []
    question = payload.get("question") or ""
    tokens = [t for t in _words(question) if len(t) >= 3]
    if not names or not tokens:
        return jsonify({"matches": {}, "source": "none"})
    try:
        matches = sap_connect.search_code_comments(names, tokens)
        return jsonify({"matches": matches, "source": "live" if matches else "empty"})
    except Exception as e:
        app.logger.warning("code comment search failed: %s", e)
        return jsonify({"matches": {}, "source": "error", "error": str(e)})


def _words(text):
    import re as _re
    return [w.lower() for w in _re.split(r"[^A-Za-z0-9/_]+", text or "") if w]


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    # 1. try live SAP MS1
    note = None
    try:
        data, reason = sap_refresh()
        if data is not None:
            return jsonify({"status": "ok", "source": reason, "data": data})
        note = {
            "pyrfc not installed": "pyrfc/SAP RFC SDK not installed on the server.",
            "not configured": "SAP MS1 connection is not configured yet.",
        }.get(reason, reason)
    except Exception as e:  # RFC / network / auth problems -> fall back
        app.logger.warning("SAP refresh failed: %s", e)
        note = f"Live SAP read failed: {type(e).__name__}: {e}"

    # 2. rebuild from Excel exports
    data = build_data.build()
    return jsonify({
        "status": "ok",
        "source": "Excel exports (offline)",
        "message": (note or "Live SAP connection unavailable") +
                    " Rebuilt from the Excel exports.",
        "data": data,
    })


if __name__ == "__main__":
    if not os.path.exists(os.path.join(HERE, "data.json")):
        build_data.build()
    print("PS Process Explorer  ->  http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
