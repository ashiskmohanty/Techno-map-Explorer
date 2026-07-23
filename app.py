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
import sap_http
import llm

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
    st = sap_connect.status()
    st.update(sap_http.status())          # add SDK-free HTTP/OData readiness
    return jsonify(st)


@app.route("/api/sap/config", methods=["POST"])
def api_sap_config():
    """Persist SAP connection settings entered from the dashboard."""
    payload = request.get_json(silent=True) or {}
    allowed = ("ashost", "sysnr", "client", "user", "passwd", "lang",
               "saprouter", "mshost", "msserv", "group", "sysid", "packages",
               "httpbase", "httpverify")
    cfg = sap_connect.load_config()
    for k in allowed:
        if k in payload and payload[k] not in (None, ""):
            cfg[k] = payload[k]
    # drop password from the stored file if the user cleared it intentionally
    sap_connect.save_config(cfg)
    st = sap_connect.status()
    st.update(sap_http.status())
    return jsonify({"status": "ok", "sap": st})


@app.route("/api/sap/test", methods=["POST"])
def api_sap_test():
    """Open a live session and report system info."""
    payload = request.get_json(silent=True) or {}
    cfg = sap_connect.load_config()
    for k in ("ashost", "sysnr", "client", "user", "passwd", "lang",
              "saprouter", "mshost", "msserv", "group", "sysid",
              "httpbase", "httpverify"):
        if payload.get(k):
            cfg[k] = payload[k]
    # prefer RFC when available, else fall back to the SDK-free HTTP path
    if sap_connect.pyrfc_available() and sap_connect.is_configured(cfg):
        return jsonify(sap_connect.test_connection(cfg))
    if sap_http.is_configured(cfg):
        return jsonify(sap_http.test_connection(cfg))
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
    from object descriptions alone. Accepts either a list of names or a list of
    {name, category} objects so FOX formulas and classes are read correctly.
    """
    payload = request.get_json(silent=True) or {}
    objects = payload.get("objects")
    if not objects:
        objects = [{"name": n, "category": "Function Module"}
                   for n in (payload.get("names") or [])]
    question = payload.get("question") or ""
    tokens = [t for t in _words(question) if len(t) >= 3]
    if not objects or not tokens:
        return jsonify({"matches": {}, "source": "none"})
    try:
        matches = sap_connect.search_object_comments(objects, tokens)
        return jsonify({"matches": matches, "source": "live" if matches else "empty"})
    except Exception as e:
        app.logger.warning("code comment search failed: %s", e)
        return jsonify({"matches": {}, "source": "error", "error": str(e)})


def _words(text):
    import re as _re
    return [w.lower() for w in _re.split(r"[^A-Za-z0-9/_]+", text or "") if w]


# --------------------------------------------------------------------------- #
# Assistant training / corrections store
# --------------------------------------------------------------------------- #
# Central store: set PSPE_CORR_FILE to a shared path (e.g. a network drive
# \\server\share\pspe\corrections.json) so every user's app reads/writes the
# same "assistant database" and everyone benefits from each other's teachings.
CORR_FILE = os.environ.get("PSPE_CORR_FILE") or os.path.join(HERE, "corrections.json")
_STOP = {"the", "a", "an", "is", "are", "to", "of", "for", "and", "or", "in",
         "on", "at", "which", "what", "where", "who", "how", "do", "does", "did",
         "can", "i", "me", "my", "we", "you", "it", "that", "this", "from", "as",
         "show", "tell", "find", "give", "share", "list", "get", "need", "want",
         "please", "object", "objects", "sap", "use", "used", "using", "with"}


def _corr_is_shared():
    return bool(os.environ.get("PSPE_CORR_FILE"))


class _FileLock:
    """Best-effort cross-process lock via an exclusive .lock file (SMB-safe)."""
    def __init__(self, target):
        self.lock = target + ".lock"

    def __enter__(self):
        import time as _t
        try:
            os.makedirs(os.path.dirname(self.lock) or ".", exist_ok=True)
        except Exception:
            pass
        for _ in range(100):                       # ~5s max
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.close(fd)
                return self
            except FileExistsError:
                _t.sleep(0.05)
            except OSError:
                return self                        # can't lock (e.g. perms) -> proceed
        return self                                # proceed anyway (stale lock)

    def __exit__(self, *exc):
        try:
            os.remove(self.lock)
        except Exception:
            pass


def _load_corrections():
    try:
        with open(CORR_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh) or []
    except Exception:
        return []


def _save_corrections(items):
    """Atomic write so concurrent readers never see a half-written file."""
    try:
        os.makedirs(os.path.dirname(CORR_FILE) or ".", exist_ok=True)
    except Exception:
        pass
    tmp = f"{CORR_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, CORR_FILE)


def _keywords(text):
    return sorted({w for w in _words(text) if len(w) >= 3 and w not in _STOP})


@app.route("/api/assistant/teachings")
def api_assistant_teachings():
    return jsonify({"teachings": _load_corrections(), "shared": _corr_is_shared()})


@app.route("/api/assistant/teach", methods=["POST"])
def api_assistant_teach():
    """Record a user correction: for <question>, the right object is <object>."""
    import time as _time
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()
    obj = (payload.get("object") or "").strip()
    if not question or not obj:
        return jsonify({"ok": False, "error": "question and object are required"}), 400
    entry = {
        "id": str(int(_time.time() * 1000)),
        "question": question,
        "keywords": _keywords(question),
        "object": obj,
        "type": (payload.get("type") or "").strip(),
        "note": (payload.get("note") or "").strip(),
        "author": (payload.get("author") or "").strip(),
        "ts": _time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with _FileLock(CORR_FILE):
        items = _load_corrections()
        # replace an existing teaching with identical keywords + object
        items = [i for i in items if i.get("keywords") != entry["keywords"]
                 or i.get("object", "").upper() != obj.upper()]
        items.insert(0, entry)
        _save_corrections(items[:1000])
    return jsonify({"ok": True, "teaching": entry, "shared": _corr_is_shared()})


@app.route("/api/assistant/teach/<tid>", methods=["DELETE"])
def api_assistant_unteach(tid):
    with _FileLock(CORR_FILE):
        items = [i for i in _load_corrections() if i.get("id") != tid]
        _save_corrections(items)
    return jsonify({"ok": True})


@app.route("/api/assistant/teach/delete", methods=["POST"])
def api_assistant_teach_delete():
    """Delete multiple taught entries by id (or all when 'all' is true)."""
    payload = request.get_json(silent=True) or {}
    with _FileLock(CORR_FILE):
        if payload.get("all"):
            _save_corrections([])
            return jsonify({"ok": True, "teachings": []})
        ids = set(payload.get("ids") or [])
        items = [i for i in _load_corrections() if i.get("id") not in ids]
        _save_corrections(items)
    return jsonify({"ok": True, "teachings": items})


# --------------------------------------------------------------------------- #
# Assistant result feedback (thumbs down = demote, cross = hide)
# --------------------------------------------------------------------------- #
FB_FILE = os.environ.get("PSPE_FB_FILE") or os.path.join(
    os.path.dirname(CORR_FILE), "feedback.json")


def _load_feedback():
    try:
        with open(FB_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh) or []
    except Exception:
        return []


def _save_feedback(items):
    try:
        os.makedirs(os.path.dirname(FB_FILE) or ".", exist_ok=True)
    except Exception:
        pass
    tmp = f"{FB_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, FB_FILE)


@app.route("/api/assistant/feedback")
def api_assistant_feedback_list():
    return jsonify({"feedback": _load_feedback()})


@app.route("/api/assistant/feedback", methods=["POST"])
def api_assistant_feedback():
    """Record per-answer feedback.

    action = 'down'  -> demote these objects for similar questions
    action = 'hide'  -> never show these objects for similar questions
    action = 'up'    -> clear any prior negative feedback for these objects
    """
    import time as _time
    payload = request.get_json(silent=True) or {}
    kws = _keywords(payload.get("question") or "")
    objs = [str(o).strip() for o in (payload.get("objects") or []) if str(o).strip()]
    action = (payload.get("action") or "").lower()
    if not kws or not objs or action not in ("up", "down", "hide"):
        return jsonify({"ok": False, "error": "question, objects and a valid action are required"}), 400

    def same(f, obj):
        return f.get("keywords") == kws and f.get("object", "").upper() == obj.upper()

    with _FileLock(FB_FILE):
        items = _load_feedback()
        for obj in objs:
            items = [f for f in items if not same(f, obj)]      # replace prior
            if action in ("down", "hide"):
                items.insert(0, {
                    "id": str(int(_time.time() * 1000)) + obj[:4],
                    "keywords": kws, "object": obj, "action": action,
                    "author": (payload.get("author") or "").strip(),
                    "ts": _time.strftime("%Y-%m-%d %H:%M:%S"),
                })
        _save_feedback(items[:3000])
    return jsonify({"ok": True, "feedback": items})


@app.route("/api/assistant/llm", methods=["GET"])
def api_assistant_llm_status():
    """Report whether an LLM is configured for generic-question understanding."""
    return jsonify(llm.status())


@app.route("/api/assistant/llm", methods=["POST"])
def api_assistant_llm():
    """Interpret a free-form message into an action + search keywords via LLM.

    Returns {available:false} when no LLM is configured so the front-end uses
    its local intent rules instead.
    """
    payload = request.get_json(silent=True) or {}
    message = payload.get("message") or ""
    if not llm.available():
        return jsonify({"available": False})
    result = llm.interpret(message)
    if result is None:
        return jsonify({"available": True, "ok": False})
    result["available"] = True
    result["ok"] = True
    return jsonify(result)


@app.route("/api/sap/odata", methods=["POST"])
def api_sap_odata():
    """Discover custom OData / Gateway services in SAP MS1 (live only)."""
    payload = request.get_json(silent=True) or {}
    keyword = payload.get("keyword") or ""
    try:
        # 1) RFC repository discovery (IWSV/IWSG in packages) when available
        if sap_connect.pyrfc_available() and sap_connect.is_configured():
            res = sap_connect.find_odata_services(keyword)
            if res.get("services"):
                return jsonify(res)
        # 2) SDK-free HTTP catalog (activated Gateway services)
        if sap_http.is_configured():
            return jsonify(sap_http.list_odata_services(keyword))
        return jsonify({"services": [], "source": "offline"})
    except Exception as e:
        app.logger.warning("odata discovery failed: %s", e)
        return jsonify({"services": [], "source": "error", "error": str(e)})


@app.route("/api/assistant/sapsearch", methods=["POST"])
def api_assistant_sapsearch():
    """Live search of SAP MS1 for the assistant.

    Uses the HTTP/ADT path (no SDK) when configured; also returns matching
    OData services. Returns empty when no live connection is available.
    """
    payload = request.get_json(silent=True) or {}
    query = payload.get("query") or ""
    names = payload.get("names") or []
    try:
        if sap_http.is_configured():
            return jsonify(sap_http.live_search(query, names))
        return jsonify({"objects": [], "services": [], "source": "offline"})
    except Exception as e:
        app.logger.warning("sap live search failed: %s", e)
        return jsonify({"objects": [], "services": [], "source": "error", "error": str(e)})


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
