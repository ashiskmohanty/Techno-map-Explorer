"""
SAP MS1 live connector for the PS Process Explorer.

Reads custom (Z*/Y*) repository objects straight out of SAP MS1 (client 122)
for the Project-System / Professional-Services development packages and returns
them already normalised into the shape the dashboard consumes.

Connection
----------
Uses the SAP NetWeaver RFC SDK through **pyrfc**. Credentials come from (in
order of precedence):

  1. environment variables  ->  SAP_ASHOST, SAP_SYSNR, SAP_CLIENT,
                                SAP_USER, SAP_PASSWD, SAP_LANG
  2. sap_config.json  next to this file

Keeping the password in an environment variable (rather than the JSON file)
is the recommended, safer option.

What it reads
-------------
* TADIR   - every R3TR repository object in the packages (classes, interfaces,
            function groups, programs, DDIC, ...) with author + creation date.
* TFDIR   - expands each function group into its individual function modules.
* SEOCOMPO- expands each class into its methods (best effort).

Every failure is contained: a problem expanding methods never aborts the
overall refresh, it simply yields fewer rows.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "sap_config.json")

# Development packages that hold the PS / Professional-Services custom code.
DEFAULT_PACKAGES = ["ZPS_PROJ_EXEC", "Z_PROF_SERVICES", "ZCPM"]

# TADIR OBJECT type  ->  dashboard category
OBJECT_CATEGORY = {
    "CLAS": "Class",
    "INTF": "Interface",
    "FUGR": "Function Group",
    "FUNC": "Function Module",
    "PROG": "Program",
    "TABL": "Table Maintenance",
    "VIEW": "Table Maintenance",
    "DTEL": "Data Element",
    "DOMA": "Domain",
    "TTYP": "Table Type",
    "STRU": "Structure",
    "ENQU": "Lock Object",
    "SHLP": "Search Help",
    "TRAN": "Transaction",
    "MSAG": "Message Class",
    "IWSV": "OData Service",
    "IWSG": "OData Service Group",
    "IWMO": "OData Model",
    "IWPR": "OData Project (SEGW)",
    "SIA1": "OData Service",
}

CUSTOM_PREFIXES = ("Z", "Y", "/CPD/", "/1CPMB/")


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def load_config() -> Dict[str, Any]:
    """Merge sap_config.json with SAP_* environment variables (env wins)."""
    cfg: Dict[str, Any] = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except Exception:
            cfg = {}

    env_map = {
        "ashost": "SAP_ASHOST", "sysnr": "SAP_SYSNR", "client": "SAP_CLIENT",
        "user": "SAP_USER", "passwd": "SAP_PASSWD", "lang": "SAP_LANG",
        "saprouter": "SAP_ROUTER", "mshost": "SAP_MSHOST", "msserv": "SAP_MSSERV",
        "group": "SAP_GROUP", "sysid": "SAP_SYSID",
    }
    for key, env in env_map.items():
        val = os.environ.get(env)
        if val:
            cfg[key] = val

    cfg.setdefault("client", "122")
    cfg.setdefault("lang", "EN")
    cfg.setdefault("packages", DEFAULT_PACKAGES)
    return cfg


def save_config(data: Dict[str, Any]) -> None:
    """Persist connection settings to sap_config.json (0600 where supported)."""
    clean = {k: v for k, v in data.items() if v not in (None, "")}
    with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
        json.dump(clean, fh, indent=2)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except Exception:
        pass


def _conn_params(cfg: Dict[str, Any]) -> Dict[str, str]:
    """Only the keys pyrfc.Connection understands."""
    allowed = ("ashost", "sysnr", "client", "user", "passwd", "lang",
               "saprouter", "mshost", "msserv", "group", "sysid", "trace")
    return {k: str(v) for k, v in cfg.items() if k in allowed and v not in (None, "")}


def is_configured(cfg: Optional[Dict[str, Any]] = None) -> bool:
    cfg = cfg or load_config()
    have_host = bool(cfg.get("ashost") or cfg.get("mshost"))
    return have_host and bool(cfg.get("user")) and bool(cfg.get("passwd"))


def pyrfc_available() -> bool:
    try:
        import pyrfc  # noqa: F401
        return True
    except Exception:
        return False


def status() -> Dict[str, Any]:
    """Lightweight status for the UI (never raises, never returns secrets)."""
    cfg = load_config()
    return {
        "pyrfc": pyrfc_available(),
        "configured": is_configured(cfg),
        "ashost": cfg.get("ashost", ""),
        "mshost": cfg.get("mshost", ""),
        "sysnr": cfg.get("sysnr", ""),
        "client": cfg.get("client", "122"),
        "user": cfg.get("user", ""),
        "lang": cfg.get("lang", "EN"),
        "packages": cfg.get("packages", DEFAULT_PACKAGES),
    }


# --------------------------------------------------------------------------- #
# Low-level RFC helpers
# --------------------------------------------------------------------------- #
def _connect(cfg: Dict[str, Any]):
    from pyrfc import Connection  # type: ignore
    return Connection(**_conn_params(cfg))


def _read_table(conn, table: str, fields: List[str],
                where: Optional[List[str]] = None,
                rowcount: int = 0) -> List[Dict[str, str]]:
    """RFC_READ_TABLE wrapper returning a list of {field: value} dicts.

    `where` is a list of already-formatted SQL fragments; long fragments are
    split across the 72-character OPTIONS lines that RFC_READ_TABLE requires.
    """
    options: List[Dict[str, str]] = []
    for frag in (where or []):
        while len(frag) > 72:
            cut = frag.rfind(" ", 0, 72)
            cut = cut if cut > 0 else 72
            options.append({"TEXT": frag[:cut]})
            frag = frag[cut:].lstrip()
        options.append({"TEXT": frag})

    res = conn.call(
        "RFC_READ_TABLE",
        QUERY_TABLE=table,
        DELIMITER="|",
        FIELDS=[{"FIELDNAME": f} for f in fields],
        OPTIONS=options,
        ROWCOUNT=rowcount,
    )
    names = [f["FIELDNAME"] for f in res.get("FIELDS", [])] or fields
    rows = []
    for entry in res.get("DATA", []):
        parts = entry["WA"].split("|")
        rec = {}
        for i, nm in enumerate(names):
            rec[nm] = parts[i].strip() if i < len(parts) else ""
        rows.append(rec)
    return rows


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def test_connection(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Open a session and return system info. Raises nothing - returns status."""
    cfg = cfg or load_config()
    if not pyrfc_available():
        return {"ok": False, "error": "pyrfc is not installed on the server "
                "(pip install pyrfc + SAP NW RFC SDK)."}
    if not is_configured(cfg):
        return {"ok": False, "error": "Connection is not fully configured "
                "(need host, user and password)."}
    try:
        conn = _connect(cfg)
        try:
            info = conn.call("RFC_SYSTEM_INFO").get("RFCSI_EXPORT", {})
        finally:
            conn.close()
        return {
            "ok": True,
            "system": info.get("RFCSYSID", ""),
            "host": info.get("RFCHOST", ""),
            "release": info.get("RFCSAPRL", ""),
            "client": cfg.get("client", ""),
            "user": cfg.get("user", ""),
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def fetch_custom_objects(cfg: Optional[Dict[str, Any]] = None,
                         expand_functions: bool = True,
                         expand_methods: bool = True
                         ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Read every custom object in the configured packages from SAP MS1.

    Returns (objects, meta). `objects` already match the dashboard schema.
    Raises on hard connection errors so the caller can fall back to Excel.
    """
    cfg = cfg or load_config()
    packages = cfg.get("packages") or DEFAULT_PACKAGES

    conn = _connect(cfg)
    objects: List[Dict[str, Any]] = []
    meta: Dict[str, Any] = {"packages": packages, "counts": {}}
    try:
        tadir_fields = ["PGMID", "OBJECT", "OBJ_NAME", "DEVCLASS",
                        "AUTHOR", "CREATED_ON", "DELFLAG"]

        fugr_groups: List[Tuple[str, str, str, str]] = []   # (group, pkg, author, created)
        class_names: List[Tuple[str, str, str, str]] = []   # (class, pkg, author, created)

        for pkg in packages:
            rows = _read_table(conn, "TADIR", tadir_fields,
                               where=[f"DEVCLASS = '{pkg}' AND PGMID = 'R3TR'"])
            for r in rows:
                name = r.get("OBJ_NAME", "")
                obj = r.get("OBJECT", "")
                if not name or not _is_custom(name):
                    continue
                if r.get("DELFLAG", "") in ("X", "x"):
                    continue
                created = _fmt_date(r.get("CREATED_ON", ""))
                author = r.get("AUTHOR", "")
                objects.append(_obj(
                    name=name,
                    category=OBJECT_CATEGORY.get(obj, obj or "Object"),
                    package=r.get("DEVCLASS", pkg),
                    author=author,
                    created=created,
                    source=f"SAP:TADIR/{obj}",
                ))
                if obj == "FUGR":
                    fugr_groups.append((name, pkg, author, created))
                elif obj == "CLAS":
                    class_names.append((name, pkg, author, created))

        # ---- expand function groups -> function modules ------------------- #
        if expand_functions and fugr_groups:
            for group, pkg, author, created in fugr_groups:
                try:
                    fms = _read_table(
                        conn, "TFDIR", ["FUNCNAME", "PNAME"],
                        where=[f"PNAME = 'SAPL{group}'"])
                    for fm in fms:
                        fname = fm.get("FUNCNAME", "")
                        if fname and _is_custom(fname):
                            objects.append(_obj(
                                name=fname, category="Function Module",
                                package=pkg, author=author, created=created,
                                source="SAP:TFDIR", parent=group,
                            ))
                except Exception:
                    continue

        # ---- expand classes -> methods ------------------------------------ #
        if expand_methods and class_names:
            for clas, pkg, author, created in class_names:
                try:
                    comps = _read_table(
                        conn, "SEOCOMPO", ["CLSNAME", "CMPNAME", "CMPTYPE"],
                        where=[f"CLSNAME = '{clas}' AND CMPTYPE = '1'"])
                    for c in comps:
                        m = c.get("CMPNAME", "")
                        if m:
                            objects.append(_obj(
                                name=f"{clas}=>{m}", category="Method",
                                package=pkg, author=author, created=created,
                                source="SAP:SEOCOMPO", parent=clas,
                            ))
                except Exception:
                    continue
    finally:
        try:
            conn.close()
        except Exception:
            pass

    for o in objects:
        meta["counts"][o["category"]] = meta["counts"].get(o["category"], 0) + 1
    meta["total"] = len(objects)
    return objects, meta


# --------------------------------------------------------------------------- #
# Where-used (cross-reference) - optional, live SAP only
# --------------------------------------------------------------------------- #
def where_used(names: List[str],
               cfg: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Return dependency edges {source, target, kind} for the given objects.

    Reads the ABAP global cross-reference table WBCROSSGT (used-object ->
    using-include) so the dashboard can draw a real where-used flow map.
    Best effort: any failure yields fewer edges, never raises for the caller
    if SAP is reachable. Requires an open, configured connection.
    """
    cfg = cfg or load_config()
    if not names or not pyrfc_available() or not is_configured(cfg):
        return []

    wanted = {n.upper() for n in names}
    edges: List[Dict[str, str]] = []
    seen = set()
    conn = _connect(cfg)
    try:
        for name in sorted({n for n in names if n}):
            try:
                rows = _read_table(
                    conn, "WBCROSSGT", ["OTYPE", "NAME", "INCLUDE"],
                    where=[f"NAME = '{name.upper()}'"], rowcount=200)
            except Exception:
                continue
            for r in rows:
                using = (r.get("INCLUDE", "") or "").strip()
                # normalise function-group includes (LSAPLxxx...) to the object
                target = using
                if not target or not target.upper().startswith(("Z", "Y")):
                    continue
                key = (name.upper(), target.upper())
                if key in seen:
                    continue
                seen.add(key)
                edges.append({"source": name, "target": target, "kind": "where-used"})
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return edges


# --------------------------------------------------------------------------- #
# Code / FOX comment search - optional, live SAP only
# --------------------------------------------------------------------------- #
# BW-IP metadata tables (may need per-system adjustment). Best effort: each is
# tried and any failure is ignored, so wrong names never break the search.
FOX_PARAM_TABLE = "RSPLF_SRV_PARAM"      # planning-function parameters (holds FOX lines)
FOX_DIR_TABLE = "RSPLF_FDIR"             # planning-function directory (type / service)
SEQ_STEP_TABLE = "RSPLS_SEQ_STEP"        # planning-sequence steps -> functions

ABAP_CATS = {"Function Module", "Function Group", "Program", "Interface",
             "Table Maintenance", "Method"}
FOX_CATS = {"Planning Function", "Planning Sequence", "Filter",
            "Aggregation Level", "InfoProvider"}


def _scan_comments(lines: List[str], toks: List[str], max_hits: int = 3) -> List[str]:
    """Return up to max_hits comment lines that contain any search token."""
    hits: List[str] = []
    for ln in lines:
        stripped = (ln or "").strip()
        if not stripped:
            continue
        is_comment = stripped.startswith("*") or '"' in ln  # ABAP/FOX comment
        if not is_comment:
            continue
        low = ln.lower()
        if any(t in low for t in toks):
            if stripped.startswith("*"):
                cleaned = stripped.lstrip("* ").strip()
            else:
                cleaned = stripped.split('"', 1)[-1].strip()
            if cleaned:
                hits.append(cleaned[:180])
        if len(hits) >= max_hits:
            break
    return hits


def _read_source(conn, program: str) -> List[str]:
    """Read ABAP source lines for a program/include via RPY_PROGRAM_READ."""
    res = conn.call("RPY_PROGRAM_READ", PROGRAM_NAME=program,
                    WITH_INCLUDELIST=" ", ONLY_SOURCE="X")
    src = res.get("SOURCE_EXTENDED") or res.get("SOURCE") or []
    lines = []
    for row in src:
        lines.append(row.get("LINE", "") if isinstance(row, dict) else str(row))
    return lines


def _read_class_source(conn, clsname: str) -> List[str]:
    """Best-effort read of a global class: class pool + method includes."""
    lines: List[str] = []
    name30 = (clsname.upper() + "=" * 30)[:30]
    candidates = [name30 + "CP", name30 + "CU"]           # class pool / public
    candidates += [name30 + f"CM{n:03d}" for n in range(1, 31)]  # method includes
    for prog in candidates:
        try:
            got = _read_source(conn, prog)
            if got:
                lines.extend(got)
        except Exception:
            continue
    return lines


def _read_fox_source(conn, planfunc: str) -> List[str]:
    """Best-effort read of a planning function's FOX formula lines + exit class.

    Returns FOX source lines (and, if the function is an exit type calling a
    Z/Y class, that class's source too) so comments can be scanned.
    """
    lines: List[str] = []
    exit_classes = set()
    try:
        rows = _read_table(conn, FOX_PARAM_TABLE,
                           ["OBJNM", "PARNM", "SEQNR", "LOW", "HIGH"],
                           where=[f"OBJNM = '{planfunc.upper()}'"], rowcount=5000)
        rows.sort(key=lambda r: (r.get("PARNM", ""), _int(r.get("SEQNR"))))
        for r in rows:
            text = (r.get("LOW", "") or "") + (r.get("HIGH", "") or "")
            if text.strip():
                lines.append(text)
            val = (r.get("LOW", "") or "").strip().upper()
            if val.startswith(("ZCL", "YCL", "ZIF", "YIF")):
                exit_classes.add(val)
    except Exception:
        pass
    for cls in exit_classes:
        try:
            lines.extend(_read_class_source(conn, cls))
        except Exception:
            continue
    return lines


def _planseq_functions(conn, seqname: str) -> List[str]:
    """Return the planning functions referenced by a planning sequence."""
    try:
        rows = _read_table(conn, SEQ_STEP_TABLE, ["SEQNM", "OBJNM", "POSIT"],
                           where=[f"SEQNM = '{seqname.upper()}'"], rowcount=500)
        return [r.get("OBJNM", "").strip() for r in rows if r.get("OBJNM", "").strip()]
    except Exception:
        return []


def search_object_comments(objects: List[Dict[str, str]], tokens: List[str],
                           cfg: Optional[Dict[str, Any]] = None,
                           max_hits: int = 3) -> Dict[str, List[str]]:
    """Scan ABAP source / FOX formulas / related classes for the search tokens.

    `objects` is a list of {"name", "category"}. Routing:
      * ABAP objects        -> RPY_PROGRAM_READ source
      * Planning Function   -> FOX formula (+ exit class) source
      * Planning Sequence   -> FOX of each contained planning function
      * Class / Method      -> class pool + method includes
    Returns { object_name: [matching comment lines...] }. Live SAP only.
    """
    cfg = cfg or load_config()
    toks = [t.lower() for t in (tokens or []) if t]
    if not objects or not toks or not pyrfc_available() or not is_configured(cfg):
        return {}

    out: Dict[str, List[str]] = {}
    conn = _connect(cfg)
    try:
        for obj in objects:
            name = (obj.get("name") or "").strip()
            cat = obj.get("category") or ""
            if not name:
                continue
            lines: List[str] = []
            try:
                if cat == "Planning Function" or cat in FOX_CATS and cat != "Planning Sequence":
                    lines = _read_fox_source(conn, name)
                elif cat == "Planning Sequence":
                    for fn in _planseq_functions(conn, name):
                        lines.extend(_read_fox_source(conn, fn))
                elif cat in ("Class", "Method"):
                    base = name.split("=>")[0]
                    lines = _read_class_source(conn, base)
                else:  # ABAP program / FM / etc.
                    lines = _read_source(conn, name)
            except Exception:
                lines = []
            hits = _scan_comments(lines, toks, max_hits)
            if hits:
                out[name] = hits
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return out


def search_code_comments(names: List[str], tokens: List[str],
                         cfg: Optional[Dict[str, Any]] = None,
                         max_hits: int = 3) -> Dict[str, List[str]]:
    """Backward-compatible wrapper: treats every name as an ABAP program."""
    objs = [{"name": n, "category": "Function Module"} for n in (names or [])]
    return search_object_comments(objs, tokens, cfg, max_hits)


def _int(v):
    try:
        return int(str(v).strip() or 0)
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
# OData / Gateway service discovery - optional, live SAP only
# --------------------------------------------------------------------------- #
# Gateway service-catalog tables (frontend/embedded gateway). Best effort.
IWFND_REG_TABLE = "/IWFND/I_MED_SRH"     # service registry (hub)
IWFND_REG_FIELDS = ["TECHNICAL_NAME", "EXTERNAL_NAME", "SERVICE_VERSION", "DESCRIPTION"]


def find_odata_services(keyword: str = "", packages: Optional[List[str]] = None,
                        cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Discover custom OData services in SAP MS1.

    Combines two sources (best effort, either may be empty):
      * TADIR  - IWSV/IWSG service objects in the PS/PSVC/ZCPM packages
      * /IWFND/I_MED_SRH - the activated Gateway service registry (keyword search)

    Returns {"services": [{name, type, description, package, source}], "source"}.
    Requires a configured, reachable SAP session.
    """
    cfg = cfg or load_config()
    if not pyrfc_available() or not is_configured(cfg):
        return {"services": [], "source": "offline"}
    packages = packages or cfg.get("packages") or DEFAULT_PACKAGES
    kw = (keyword or "").strip().upper()

    services = []
    seen = set()
    conn = _connect(cfg)
    try:
        # 1) repository OData objects in the custom packages
        for pkg in packages:
            try:
                rows = _read_table(conn, "TADIR",
                                   ["OBJECT", "OBJ_NAME", "DEVCLASS", "AUTHOR"],
                                   where=[f"DEVCLASS = '{pkg}' AND PGMID = 'R3TR' "
                                          f"AND ( OBJECT = 'IWSV' OR OBJECT = 'IWSG' "
                                          f"OR OBJECT = 'IWMO' OR OBJECT = 'IWPR' )"])
            except Exception:
                continue
            for r in rows:
                nm = r.get("OBJ_NAME", "").strip()
                if not nm or nm.upper() in seen:
                    continue
                if kw and kw not in nm.upper():
                    continue
                seen.add(nm.upper())
                services.append({
                    "name": nm,
                    "type": OBJECT_CATEGORY.get(r.get("OBJECT", ""), "OData Service"),
                    "description": "", "package": r.get("DEVCLASS", pkg),
                    "author": r.get("AUTHOR", ""), "source": "TADIR",
                })

        # 2) activated services in the Gateway registry (keyword match)
        try:
            where = []
            if kw:
                where = [f"TECHNICAL_NAME LIKE '%{kw}%'"]
            rows = _read_table(conn, IWFND_REG_TABLE, IWFND_REG_FIELDS,
                               where=where, rowcount=200)
            for r in rows:
                nm = (r.get("TECHNICAL_NAME") or r.get("EXTERNAL_NAME") or "").strip()
                if not nm or nm.upper() in seen:
                    continue
                if not _is_custom(nm) and kw and kw not in nm.upper():
                    continue
                seen.add(nm.upper())
                services.append({
                    "name": nm, "type": "OData Service (registered)",
                    "description": r.get("DESCRIPTION", ""),
                    "version": r.get("SERVICE_VERSION", ""),
                    "package": "", "source": IWFND_REG_TABLE,
                })
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return {"services": services, "source": "live" if services else "empty"}


# --------------------------------------------------------------------------- #
# small utils
# --------------------------------------------------------------------------- #
def _is_custom(name: str) -> bool:
    return (name or "").upper().lstrip().startswith(CUSTOM_PREFIXES)


def _fmt_date(yyyymmdd: str) -> str:
    d = (yyyymmdd or "").strip()
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d


def _obj(name: str, category: str, package: str, author: str,
         created: str, source: str, parent: str = "") -> Dict[str, Any]:
    return {
        "name": name,
        "domain": "ABAP",
        "category": category,
        "process": "Unassigned",
        "package": package,
        "author": author,
        "created": created,
        "description": "",
        "validity": "",
        "technical": parent,
        "source": source,
        "custom": True,
    }
