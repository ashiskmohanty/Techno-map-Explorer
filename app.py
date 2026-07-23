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
        data = json.load(fh)
    return _apply_edits(_merge_manual(data))


# --------------------------------------------------------------------------- #
# Manually-added objects (persisted, merged into the served repository)
# --------------------------------------------------------------------------- #
MANUAL_FILE = os.environ.get("PSPE_MANUAL_FILE") or os.path.join(HERE, "manual_objects.json")


def _load_manual():
    try:
        with open(MANUAL_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh) or []
    except Exception:
        return []


def _save_manual(items):
    tmp = f"{MANUAL_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, MANUAL_FILE)


def _merge_manual(data):
    """Fold manually-added objects into a freshly loaded data dict."""
    manual = _load_manual()
    if not manual:
        return data
    have = {o.get("name", "").upper() for o in data.get("objects", [])}
    added = False
    for m in manual:
        if m.get("name", "").upper() in have:
            continue
        data.setdefault("objects", []).append({**m, "custom": True})
        have.add(m.get("name", "").upper())
        added = True
    if added:
        data["processAreas"] = _recount_process_areas(data["objects"])
        data["stats"] = build_data.build_stats(data["objects"], {})
        data["manualCount"] = len(manual)
    return data


# --------------------------------------------------------------------------- #
# Admin edits (Category / Process area / Primary area) + audit trail
# --------------------------------------------------------------------------- #
EDITS_FILE = os.environ.get("PSPE_EDITS_FILE") or os.path.join(HERE, "object_edits.json")
AUDIT_FILE = os.environ.get("PSPE_AUDIT_FILE") or os.path.join(HERE, "audit_log.jsonl")


def _load_edits():
    try:
        with open(EDITS_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def _save_edits(edits):
    tmp = f"{EDITS_FILE}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(edits, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, EDITS_FILE)


def _apply_edits(data):
    """Overlay admin edits (category / process / l1) onto the served objects."""
    edits = _load_edits()
    if not edits:
        return data
    changed = False
    for o in data.get("objects", []):
        e = edits.get(o.get("name", "").upper())
        if not e:
            continue
        for f in ("category", "process", "l1"):
            if e.get(f):
                o[f] = e[f]
        o["edited"] = True
        changed = True
    if changed:
        data["processAreas"] = _recount_process_areas(data["objects"])
        data["stats"] = build_data.build_stats(data["objects"], {})
    return data


def _audit(action, **fields):
    """Append an audit-trail record (JSONL, append-only) with a timestamp."""
    import time as _time
    try:
        os.makedirs(os.path.dirname(AUDIT_FILE) or ".", exist_ok=True)
        rec = {"ts": _time.strftime("%Y-%m-%d %H:%M:%S"), "action": action}
        rec.update({k: v for k, v in fields.items() if v is not None})
        with open(AUDIT_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _load_audit(limit=500):
    try:
        with open(AUDIT_FILE, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
    except Exception:
        return []
    out = []
    for ln in lines:
        ln = ln.strip()
        if ln:
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
    return out



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
        # RFC path when the SDK is available
        if sap_connect.pyrfc_available() and sap_connect.is_configured():
            edges = sap_connect.where_used(names)
            return jsonify({"edges": edges, "source": "live" if edges else "empty"})
        # SDK-free HTTP/ADT where-used (usageReferences)
        if sap_http.is_configured():
            edges, seen = [], set()
            for nm in names[:15]:
                for e in sap_http.where_used(nm):
                    key = (e["source"], e["target"])
                    if key not in seen:
                        seen.add(key)
                        edges.append(e)
            return jsonify({"edges": edges, "source": "live" if edges else "empty"})
        return jsonify({"edges": [], "source": "offline"})
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
    _track("teach", author=entry.get("author"))
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
    _track("feedback", action=action, n=len(objs),
           author=(payload.get("author") or "").strip())
    return jsonify({"ok": True, "feedback": items})


# --------------------------------------------------------------------------- #
# Usage tracking + Admin metrics (admin-only)
# --------------------------------------------------------------------------- #
import secrets as _secrets

USAGE_FILE = os.environ.get("PSPE_USAGE_FILE") or os.path.join(
    os.path.dirname(CORR_FILE), "usage.jsonl")
ADMIN_CFG = os.path.join(HERE, "admin_config.json")


def _admin_key():
    """Effective admin key: env var wins, else a persisted random key."""
    k = os.environ.get("PSPE_ADMIN_KEY")
    if k:
        return k
    try:
        with open(ADMIN_CFG, "r", encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("admin_key") or ""
    except Exception:
        return ""


def _ensure_admin_key():
    """Create a random admin key on first run and print the unlock URL."""
    if os.environ.get("PSPE_ADMIN_KEY") or _admin_key():
        return _admin_key()
    key = _secrets.token_urlsafe(10)
    try:
        with open(ADMIN_CFG, "w", encoding="utf-8") as fh:
            json.dump({"admin_key": key}, fh, indent=1)
        os.chmod(ADMIN_CFG, 0o600)
    except Exception:
        pass
    print("\n  ADMIN metrics unlock (keep private):")
    print(f"    http://127.0.0.1:5000/?admin={key}\n")
    return key


def _track(ev_type, **fields):
    """Append a usage event (JSONL, append-only, best effort)."""
    import time as _time
    try:
        os.makedirs(os.path.dirname(USAGE_FILE) or ".", exist_ok=True)
        rec = {"ts": _time.strftime("%Y-%m-%d %H:%M:%S"), "type": ev_type}
        rec.update({k: v for k, v in fields.items() if v is not None})
        with open(USAGE_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _iso_week(ts):
    """'YYYY-MM-DD ...' -> 'YYYY-Wnn' ISO week label."""
    try:
        import datetime as _dt
        d = _dt.datetime.strptime((ts or "")[:10], "%Y-%m-%d").date()
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}"
    except Exception:
        return ""


def _load_usage(limit=50000):
    try:
        with open(USAGE_FILE, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
    except Exception:
        return []
    out = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            pass
    return out


def _is_admin(req):
    key = req.args.get("key") or req.headers.get("X-Admin-Key") or ""
    admin = _admin_key()
    return bool(admin) and key == admin


@app.route("/api/track", methods=["POST"])
def api_track():
    """Record a front-end usage event (query, tab view, drawer, export…)."""
    p = request.get_json(silent=True) or {}
    t = (p.get("type") or "").strip()
    if not t:
        return jsonify({"ok": False}), 400
    allow = {"q", "view", "proc", "matched", "topAcc", "user", "live", "source"}
    _track(t, **{k: p.get(k) for k in allow if k in p})
    return jsonify({"ok": True})


@app.route("/api/objects/manual")
def api_objects_manual_list():
    return jsonify({"objects": _load_manual()})


@app.route("/api/objects/add", methods=["POST"])
def api_objects_add():
    """Add a custom object to the local repository so it shows under a tile."""
    import time as _time
    p = request.get_json(silent=True) or {}
    name = (p.get("name") or "").strip()
    process = (p.get("process") or "").strip()
    domain = (p.get("domain") or "").strip().upper()
    category = (p.get("category") or "").strip()
    if not name or not process:
        return jsonify({"ok": False, "error": "name and process (sub-area) are required"}), 400
    if domain not in ("ABAP", "BW"):
        domain = "BW" if category in (
            "BEx Query", "Planning Sequence", "Planning Function", "Filter",
            "InfoProvider", "Aggregation Level", "InfoObject") else "ABAP"
    entry = {
        "name": name,
        "domain": domain,
        "category": category or ("Function Module" if domain == "ABAP" else "BEx Query"),
        "process": process,
        "l1": (p.get("l1") or "").strip(),
        "package": (p.get("package") or "").strip(),
        "author": (p.get("author") or "").strip(),
        "created": _time.strftime("%Y-%m-%d"),
        "description": (p.get("description") or "").strip(),
        "validity": "",
        "technical": "",
        "source": "manual",
        "custom": True,
    }
    with _FileLock(MANUAL_FILE):
        items = _load_manual()
        if any(i.get("name", "").upper() == name.upper() for i in items):
            return jsonify({"ok": False, "error": f"{name} is already in the local repository."}), 409
        items.insert(0, entry)
        _save_manual(items)
    _track("object_add", proc=process, user=(p.get("author") or ""))
    return jsonify({"ok": True, "object": entry})


@app.route("/api/objects/manual/<path:name>", methods=["DELETE"])
def api_objects_delete(name):
    with _FileLock(MANUAL_FILE):
        items = [i for i in _load_manual() if i.get("name", "").upper() != name.upper()]
        _save_manual(items)
    return jsonify({"ok": True})


@app.route("/api/objects/edit", methods=["POST"])
def api_objects_edit():
    """Admin-only: update an object's Category / Process area / Primary area and
    record the change in the audit-trail log with a timestamp."""
    if not _is_admin(request):
        return jsonify({"ok": False, "error": "Admin key required."}), 403
    import time as _time
    p = request.get_json(silent=True) or {}
    name = (p.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "name is required"}), 400

    data = load_or_build()
    cur = next((o for o in data["objects"] if o["name"].upper() == name.upper()), None)
    if not cur:
        return jsonify({"ok": False, "error": f"{name} not found."}), 404

    # before-image: prefer the client's displayed values (incl. computed L1),
    # fall back to what the server currently holds.
    cb = p.get("before") or {}
    before = {
        "category": cb.get("category", cur.get("category", "")),
        "process": cb.get("process", cur.get("process", "")),
        "l1": cb.get("l1", cur.get("l1") or ""),
    }
    after = {
        "category": (p.get("category") or before["category"]).strip(),
        "process": (p.get("process") or before["process"]).strip(),
        "l1": (p.get("l1") or before["l1"]).strip(),
    }
    by = (p.get("by") or "admin").strip()

    with _FileLock(EDITS_FILE):
        edits = _load_edits()
        edits[name.upper()] = {**after, "at": _time.strftime("%Y-%m-%d %H:%M:%S"), "by": by}
        _save_edits(edits)

    # audit trail (only the fields that actually changed)
    changes = {f: {"from": before[f], "to": after[f]} for f in after if before[f] != after[f]}
    _audit("object_edit", object=name, by=by, changes=changes,
           before=before, after=after)
    _track("object_edit", obj=name, user=by)

    fresh = load_or_build()
    return jsonify({"ok": True, "before": before, "after": after,
                    "changes": changes, "data": fresh})


@app.route("/api/admin/audit")
def api_admin_audit():
    """Admin-only: recent audit-trail entries (most recent first)."""
    if not _is_admin(request):
        return jsonify({"ok": False, "error": "Admin key required."}), 403
    return jsonify({"ok": True, "entries": list(reversed(_load_audit()))})


# --------------------------------------------------------------------------- #
# Rebuild the platform from freshly uploaded source Excel workbooks (admin)
# --------------------------------------------------------------------------- #
REBUILD_SLOTS = {
    "abap": build_data.ABAP_FILE,   # Latest PE Objects - Unused code.xlsx
    "bw": build_data.BW_FILE,       # SAP PSPE - BWIP Object Analysis.xlsx
    "bpml": build_data.BPML_FILE,   # Process tiles / BPML mapping workbook
}
REBUILD_LABELS = {
    "abap": "ABAP objects + Process-area mapping",
    "bw": "BW-IP objects + Process-area mapping",
    "bpml": "Process tiles / L1 process mapping",
}


@app.route("/api/rebuild/status")
def api_rebuild_status():
    """Admin-only: which source workbooks exist and their timestamps."""
    if not _is_admin(request):
        return jsonify({"ok": False, "error": "Admin key required."}), 403
    import time as _t
    files = {}
    for slot, fname in REBUILD_SLOTS.items():
        p = os.path.join(HERE, fname)
        ex = os.path.exists(p)
        files[slot] = {
            "slot": slot,
            "label": REBUILD_LABELS.get(slot, slot),
            "name": fname,
            "exists": ex,
            "modified": (_t.strftime("%Y-%m-%d %H:%M:%S", _t.localtime(os.path.getmtime(p)))
                         if ex else None),
            "bytes": os.path.getsize(p) if ex else 0,
        }
    return jsonify({"ok": True, "files": files, "packages": list(build_data.PACKAGES)})


@app.route("/api/rebuild", methods=["POST"])
def api_rebuild():
    """Admin-only: save uploaded workbook(s), then rebuild data.json/data.js,
    overwriting the existing generated data. Backs up what it replaces."""
    if not _is_admin(request):
        return jsonify({"ok": False, "error": "Admin key required."}), 403
    import re as _re, shutil as _sh, time as _t

    saved = {}
    for slot, fname in REBUILD_SLOTS.items():
        f = request.files.get(slot)
        if not f or not f.filename:
            continue
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in (".xlsx", ".xls"):
            return jsonify({"ok": False,
                            "error": f"{slot}: only .xlsx / .xls files are allowed."}), 400
        dest = os.path.join(HERE, fname)          # canonical name (no traversal)
        if os.path.exists(dest):
            try:
                _sh.copy2(dest, dest + ".bak")
            except Exception:
                pass
        f.save(dest)
        saved[slot] = {"saved_as": fname, "uploaded": f.filename,
                       "bytes": os.path.getsize(dest)}

    packages = None
    pk = (request.form.get("packages") or "").strip()
    if pk:
        packages = [p.strip() for p in _re.split(r"[,\s]+", pk) if p.strip()]

    if not saved and not packages:
        return jsonify({"ok": False,
                        "error": "Upload at least one Excel file, or provide packages."}), 400

    dj = os.path.join(HERE, "data.json")
    if os.path.exists(dj):
        try:
            _sh.copy2(dj, dj + "." + _t.strftime("%Y%m%d_%H%M%S") + ".bak")
        except Exception:
            pass

    try:
        build_data.build(packages=packages)
    except Exception as e:
        app.logger.exception("rebuild failed")
        return jsonify({"ok": False,
                        "error": f"Rebuild failed: {type(e).__name__}: {e}"}), 500

    data = load_or_build()                        # overlays manual + admin edits
    by = (request.form.get("by") or request.headers.get("X-Admin-User") or "admin")
    _audit("rebuild", by=by,
           files={k: v["uploaded"] for k, v in saved.items()},
           packages=packages, objects=len(data.get("objects", [])))
    _track("rebuild", user=by)
    return jsonify({
        "ok": True,
        "saved": saved,
        "summary": {
            "objects": len(data.get("objects", [])),
            "processAreas": len(data.get("processAreas", [])),
            "generated": data.get("generated"),
            "packages": data.get("packages"),
        },
        "data": data,
    })


@app.route("/api/admin/status")
def api_admin_status():
    """Whether the caller is the admin (holds the key). No secrets leaked."""
    return jsonify({"admin": _is_admin(request)})


@app.route("/api/admin/metrics")
def api_admin_metrics():
    """Aggregated usage metrics — admin key required."""
    if not _is_admin(request):
        return jsonify({"error": "unauthorized"}), 401
    from collections import Counter
    ev = _load_usage()
    q = [e for e in ev if e.get("type") == "query"]
    tabs = Counter(e.get("view") for e in ev if e.get("type") == "tab" and e.get("view"))
    fb = Counter(e.get("action") for e in ev if e.get("type") == "feedback" and e.get("action"))
    users = sorted({e.get("user") for e in ev if e.get("user")})
    day = Counter((e.get("ts") or "")[:10] for e in q if e.get("ts"))
    qtext = Counter((e.get("q") or "").strip() for e in q if (e.get("q") or "").strip())
    matched = sum(1 for e in q if e.get("matched"))
    live = sum(1 for e in ev if e.get("type") == "live_search")
    teach = _load_corrections()
    authors = Counter((t.get("author") or "unknown") for t in teach)
    data = load_or_build()
    stats = data.get("stats", {})
    counts = Counter(e.get("type") for e in ev)

    # ---- footfall: clicks per ISO week ----
    interactive = {"query", "tab", "drawer", "export", "feedback",
                   "live_search", "refresh", "click", "visit"}
    week = Counter()
    for e in ev:
        if e.get("type") not in interactive:
            continue
        n = e.get("n") or 1
        wk = _iso_week(e.get("ts"))
        if wk:
            week[wk] += n
    weeks_sorted = sorted(week.items())
    total_clicks = sum(week.values())
    avg_clicks_week = round(total_clicks / len(week)) if week else 0

    return jsonify({
        "kpis": {
            "queries": len(q),
            "unique_questions": len(qtext),
            "match_rate": round(matched / len(q) * 100) if q else 0,
            "avg_clicks_per_week": avg_clicks_week,
            "live_searches": live,
            "drawer_opens": counts.get("drawer", 0),
            "exports": counts.get("export", 0),
            "refreshes": counts.get("refresh", 0),
            "teachings": len(teach),
            "feedback_total": sum(fb.values()),
            "unique_users": len(users),
            "active_days": len(day),
            "total_events": len(ev),
        },
        "queries_per_day": [{"day": d, "n": n} for d, n in sorted(day.items())][-21:],
        "clicks_per_week": [{"week": w, "n": n} for w, n in weeks_sorted][-12:],
        "top_questions": qtext.most_common(10),
        "tab_views": dict(tabs),
        "feedback": {"up": fb.get("up", 0), "down": fb.get("down", 0), "hide": fb.get("hide", 0)},
        "top_teachers": authors.most_common(8),
        "users": users,
        "repo": {
            "objects": stats.get("total", 0),
            "custom": stats.get("custom", 0),
            "byDomain": stats.get("byDomain", {}),
            "processAreas": len(data.get("processAreas", [])),
        },
        "generated": data.get("generated", ""),
    })


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
    _track("live_search")
    try:
        if sap_http.is_configured():
            return jsonify(sap_http.live_search(query, names))
        return jsonify({"objects": [], "services": [], "source": "offline"})
    except Exception as e:
        app.logger.warning("sap live search failed: %s", e)
        return jsonify({"objects": [], "services": [], "source": "error", "error": str(e)})


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    _track("refresh")
    # 1. try live SAP MS1 over RFC (needs pyrfc + SAP NW RFC SDK)
    note = None
    try:
        data, reason = sap_refresh()
        if data is not None:
            try:
                _persist_live(data, "RFC")
            except Exception as e:
                app.logger.warning("live snapshot save failed: %s", e)
            return jsonify({"status": "ok", "source": reason, "data": data})
        note = {
            "pyrfc not installed": "pyrfc/SAP RFC SDK not installed on the server.",
            "not configured": "SAP MS1 connection is not configured yet.",
        }.get(reason, reason)
    except Exception as e:  # RFC / network / auth problems -> fall back
        app.logger.warning("SAP refresh failed: %s", e)
        note = f"Live SAP read failed: {type(e).__name__}: {e}"

    # 2. try live SAP MS1 over HTTP / ADT (no SDK required, works on any Python)
    try:
        data, hmsg = _refresh_via_http()
        if data is not None:
            return jsonify({"status": "ok", "source": "live",
                            "message": hmsg, "data": data})
        note = hmsg or note
    except Exception as e:
        app.logger.warning("HTTP refresh failed: %s", e)
        note = f"Live HTTP read failed: {type(e).__name__}: {e}"

    # 3. rebuild from Excel exports
    data = build_data.build()
    return jsonify({
        "status": "ok",
        "source": "Excel exports (offline)",
        "message": (note or "Live SAP connection unavailable") +
                    " Rebuilt from the Excel exports.",
        "data": data,
    })


# --------------------------------------------------------------------------- #
# Live refresh over HTTP/ADT + persisted Excel snapshot
# --------------------------------------------------------------------------- #
LIVE_XLSX = os.environ.get("PSPE_LIVE_XLSX") or os.path.join(HERE, "sap_live_objects.xlsx")
EXPORTS_DIR = os.path.join(HERE, "exports")


def _refresh_via_http():
    """Fetch all custom objects live over ADT (no SDK), merge with the existing
    BW / process-area assignments, persist a timestamped Excel snapshot + the
    served data.json, and return (data, message). Returns (None, reason) when a
    live read is not possible so the caller can fall back to Excel."""
    if not sap_http.is_configured():
        return None, "SAP MS1 HTTP endpoint is not configured."
    base = load_or_build()
    # known ABAP name prefixes -> targeted, package-scoped live discovery
    prefixes = sorted({o["name"][:5].upper()
                       for o in base["objects"]
                       if o.get("domain") == "ABAP" and len(o.get("name", "")) >= 5})
    live = sap_http.fetch_all(prefixes=prefixes)
    if not live:
        return None, "SAP MS1 returned no live objects (ADT search empty)."

    by_name = {o["name"].upper(): o for o in base["objects"]}
    added = updated = 0
    for lv in live:
        key = lv["name"].upper()
        cur = by_name.get(key)
        if cur:
            # overlay authoritative live metadata onto the existing entry, but
            # keep it flagged as a local-file object (it lives in data.json).
            cur["package"] = lv.get("package") or cur.get("package", "")
            cur["description"] = cur.get("description") or lv.get("description", "")
            if lv.get("category") and cur.get("domain") == "ABAP":
                cur["category"] = lv["category"]
            cur["live"] = True
            updated += 1
        else:
            base["objects"].append({**lv, "process": "Unmapped (SAP MS1)", "custom": True})
            by_name[key] = base["objects"][-1]
            added += 1

    ts = __import__("time").strftime("%Y-%m-%d %H:%M:%S")
    base["processAreas"] = _recount_process_areas(base["objects"])
    base["stats"] = build_data.build_stats(base["objects"], {})
    base["source"] = "live"
    base["generated"] = ts
    base["liveRefresh"] = {
        "at": ts, "abap_live": len(live), "added": added, "updated": updated,
    }

    xlsx = _persist_live(base, "ADT")
    base["liveRefresh"]["excel"] = os.path.basename(xlsx) if xlsx else ""
    msg = (f"Live SAP MS1: {len(live)} ABAP objects fetched "
           f"({added} new, {updated} updated). "
           f"Snapshot saved to {os.path.basename(xlsx) if xlsx else 'Excel'}.")
    return base, msg


def _persist_live(data, how):
    """Persist a refreshed dataset: write data.json / data.js (so the dashboard
    keeps using it later) and a timestamped Excel workbook of all objects."""
    # served JSON + JS fallback
    with open(os.path.join(HERE, "data.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    with open(os.path.join(HERE, "data.js"), "w", encoding="utf-8") as fh:
        fh.write("window.__PSPE_DATA__ = ")
        json.dump(data, fh, ensure_ascii=False)
        fh.write(";\n")
    # Excel snapshot with timestamp
    return _export_live_xlsx(data, how)


def _export_live_xlsx(data, how):
    """Write all object details to a local Excel workbook (stable name + a
    timestamped copy under exports/). Returns the stable file path."""
    try:
        from openpyxl import Workbook
    except Exception:
        return ""
    import time as _t
    ts = _t.strftime("%Y-%m-%d %H:%M:%S")
    stamp = _t.strftime("%Y%m%d_%H%M%S")
    objects = data.get("objects", [])

    wb = Workbook()
    ws = wb.active
    ws.title = "Objects"
    cols = ["Name", "Domain", "Category", "Process Area", "L1", "Package",
            "Author", "Created", "Description", "Validity", "Technical",
            "Source", "Snapshot"]
    ws.append(cols)
    for o in objects:
        ws.append([
            o.get("name", ""), o.get("domain", ""), o.get("category", ""),
            o.get("process", ""), o.get("l1", ""), o.get("package", ""),
            o.get("author", ""), o.get("created", ""), o.get("description", ""),
            o.get("validity", ""), o.get("technical", ""), o.get("source", ""),
            ts,
        ])
    meta = wb.create_sheet("Snapshot")
    lr = data.get("liveRefresh", {}) or {}
    meta.append(["Generated", ts])
    meta.append(["Method", how])
    meta.append(["Environment", data.get("environment", "SAP MS1 / 122")])
    meta.append(["Total objects", len(objects)])
    meta.append(["ABAP objects", sum(1 for o in objects if o.get("domain") == "ABAP")])
    meta.append(["BW objects", sum(1 for o in objects if o.get("domain") == "BW")])
    meta.append(["Live ABAP fetched", lr.get("abap_live", "")])
    meta.append(["New this refresh", lr.get("added", "")])
    meta.append(["Updated this refresh", lr.get("updated", "")])

    wb.save(LIVE_XLSX)
    try:
        os.makedirs(EXPORTS_DIR, exist_ok=True)
        wb.save(os.path.join(EXPORTS_DIR, f"sap_objects_{stamp}.xlsx"))
    except Exception:
        pass
    return LIVE_XLSX


@app.route("/api/refresh/status")
def api_refresh_status():
    """Last live-refresh metadata + Excel snapshot info for the dashboard."""
    info = {"excel": None, "generated": None, "liveRefresh": None}
    try:
        with open(os.path.join(HERE, "data.json"), "r", encoding="utf-8") as fh:
            d = json.load(fh)
        info["generated"] = d.get("generated")
        info["liveRefresh"] = d.get("liveRefresh")
    except Exception:
        pass
    if os.path.exists(LIVE_XLSX):
        import time as _t
        info["excel"] = {
            "name": os.path.basename(LIVE_XLSX),
            "modified": _t.strftime("%Y-%m-%d %H:%M:%S",
                                    _t.localtime(os.path.getmtime(LIVE_XLSX))),
            "bytes": os.path.getsize(LIVE_XLSX),
        }
    return jsonify(info)


@app.route("/api/refresh/export")
def api_refresh_export():
    """Download the most recent live Excel snapshot."""
    if not os.path.exists(LIVE_XLSX):
        return jsonify({"ok": False, "error": "No live snapshot yet."}), 404
    return send_from_directory(HERE, os.path.basename(LIVE_XLSX), as_attachment=True)



if __name__ == "__main__":
    if not os.path.exists(os.path.join(HERE, "data.json")):
        build_data.build()
    _ensure_admin_key()
    print("PS Process Explorer  ->  http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
