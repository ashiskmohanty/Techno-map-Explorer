"""
SDK-free live connection to SAP MS1 over HTTPS (OData / ICF).

This is an alternative to the pyrfc/RFC path that needs **no SAP NW RFC SDK**
and works on any Python (incl. 3.14). It talks to the SAP Gateway using the
standard OData catalog service, so it can:

  * test the connection / login
  * list the activated OData services (answering "which OData service …")

Only the Python standard library is used (urllib), so there are no extra
dependencies. Credentials come from the same config as sap_connect
(sap_config.json or SAP_* env vars) plus an HTTP base URL:

    "httpbase": "https://ms1host.corp:44300"      (or SAP_HTTP_BASE)
    optional: "httpverify": false                 (or SAP_HTTP_INSECURE=1) for
              self-signed certs — disables TLS verification (use with care).
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

import sap_connect

_TIMEOUT = 15
CATALOG = "/sap/opu/odata/iwfnd/catalogservice;v=2/ServiceCollection"
CATALOG_ROOT = "/sap/opu/odata/iwfnd/catalogservice;v=2/"


def _cfg(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = dict(cfg or sap_connect.load_config())
    if os.environ.get("SAP_HTTP_BASE"):
        cfg["httpbase"] = os.environ["SAP_HTTP_BASE"]
    if os.environ.get("SAP_HTTP_INSECURE"):
        cfg["httpverify"] = os.environ["SAP_HTTP_INSECURE"] not in ("1", "true", "True")
    return cfg


def is_configured(cfg: Optional[Dict[str, Any]] = None) -> bool:
    cfg = _cfg(cfg)
    return bool(cfg.get("httpbase") and cfg.get("user") and cfg.get("passwd"))


def status(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = _cfg(cfg)
    return {"http_configured": is_configured(cfg),
            "httpbase": cfg.get("httpbase", ""),
            "client": cfg.get("client", "122")}


def _ssl_ctx(cfg):
    if cfg.get("httpverify") is False:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def _get(cfg, path, params=None, accept="application/json") -> Dict[str, Any]:
    base = cfg["httpbase"].rstrip("/")
    q = dict(params or {})
    q.setdefault("sap-client", cfg.get("client", "122"))
    url = base + path + ("?" + urllib.parse.urlencode(q) if q else "")
    token = base64.b64encode(f"{cfg['user']}:{cfg['passwd']}".encode()).decode()
    req = urllib.request.Request(url, headers={
        "Authorization": f"Basic {token}",
        "Accept": accept,
    })
    with urllib.request.urlopen(req, timeout=_TIMEOUT, context=_ssl_ctx(cfg)) as resp:
        raw = resp.read().decode("utf-8", "replace")
        code = resp.getcode()
    if "json" in accept:
        try:
            return {"code": code, "data": json.loads(raw)}
        except ValueError:
            return {"code": code, "data": {"_raw": raw[:500]}}
    return {"code": code, "raw": raw}


def test_connection(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = _cfg(cfg)
    if not is_configured(cfg):
        return {"ok": False, "error": "HTTP connection not configured "
                "(need httpbase, user and password)."}
    try:
        res = _get(cfg, CATALOG_ROOT, {"$format": "json"})
        return {"ok": True, "code": res["code"],
                "endpoint": cfg["httpbase"], "client": cfg.get("client", "122"),
                "user": cfg.get("user", "")}
    except urllib.error.HTTPError as e:
        msg = "authentication failed (401)" if e.code == 401 else f"HTTP {e.code}"
        return {"ok": False, "error": msg}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def list_odata_services(keyword: str = "",
                        cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """List activated OData services from the Gateway catalog (keyword filter)."""
    cfg = _cfg(cfg)
    if not is_configured(cfg):
        return {"services": [], "source": "http-offline"}
    kw = (keyword or "").strip().lower()
    try:
        res = _get(cfg, CATALOG, {"$format": "json"})
        results = (((res.get("data") or {}).get("d") or {}).get("results")) or []
        services = []
        for r in results:
            name = r.get("TechnicalServiceName") or r.get("ID") or r.get("Title") or ""
            desc = r.get("Description") or r.get("Title") or ""
            blob = f"{name} {desc}".lower()
            if kw and kw not in blob:
                continue
            services.append({
                "name": name,
                "type": "OData Service",
                "description": desc,
                "version": r.get("TechnicalServiceVersion", ""),
                "url": r.get("ServiceUrl", "") or r.get("MetadataUrl", ""),
                "author": r.get("Author", ""),
                "source": "IWFND catalog",
            })
        return {"services": services, "source": "live" if services else "empty",
                "total": len(results)}
    except urllib.error.HTTPError as e:
        return {"services": [], "source": "error", "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"services": [], "source": "error", "error": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------- #
# ADT repository search (Z/Y objects) over HTTP - no SDK
# --------------------------------------------------------------------------- #
ADT_SEARCH = "/sap/bc/adt/repository/informationsystem/search"

# ADT type code (before '/')  ->  friendly category
ADT_TYPE = {
    "FUGR": "Function Module", "FUNC": "Function Module", "CLAS": "Class",
    "INTF": "Interface", "PROG": "Program", "TABL": "Table Maintenance",
    "DDLS": "CDS View", "DTEL": "Data Element", "DOMA": "Domain",
    "IWSV": "OData Service", "IWSG": "OData Service Group", "IWMO": "OData Model",
}


def _attr(el, local):
    """Return an ADT namespaced attribute by its local name."""
    for k, v in el.attrib.items():
        if k.split("}")[-1] == local:
            return v
    return ""


def adt_search(query: str, cfg: Optional[Dict[str, Any]] = None,
               max_results: int = 40) -> List[Dict[str, str]]:
    """Live quick-search of the ABAP/BW repository via ADT REST (no SDK).

    Matches object names (wildcard appended). Returns normalised objects.
    """
    cfg = _cfg(cfg)
    q = (query or "").strip()
    if not is_configured(cfg) or not q:
        return []
    if not q.endswith("*"):
        q = q + "*"
    import xml.etree.ElementTree as ET
    try:
        res = _get(cfg, ADT_SEARCH,
                   {"operation": "quickSearch", "query": q, "maxResults": max_results},
                   accept="application/xml")
        root = ET.fromstring(res.get("raw", "") or "<e/>")
    except Exception:
        return []
    out, seen = [], set()
    for el in root.iter():
        name = _attr(el, "name")
        if not name:
            continue
        typ = _attr(el, "type")            # e.g. FUGR/FF, CLAS/OC
        if not typ and not name.upper().startswith(("Z", "Y")):
            continue
        key = name.upper()
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "name": name,
            "type": ADT_TYPE.get((typ or "").split("/")[0], (typ or "Object")),
            "adt_type": typ,
            "uri": _attr(el, "uri"),
            "description": _attr(el, "description"),
            "package": _attr(el, "packageName"),
            "source": "SAP ADT",
        })
    return out


# --------------------------------------------------------------------------- #
# ADT where-used (usageReferences) over HTTP - no SDK
# --------------------------------------------------------------------------- #
import http.cookiejar as _cookiejar

USAGE_REFS = "/sap/bc/adt/repository/informationsystem/usageReferences"
_WU_BODY = ('<?xml version="1.0" encoding="UTF-8"?>'
            '<usagereferences:usageReferenceRequest '
            'xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">'
            '<usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>')


def _opener(cfg):
    handlers = [urllib.request.HTTPCookieProcessor(_cookiejar.CookieJar())]
    ctx = _ssl_ctx(cfg)
    if ctx:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def _auth_header(cfg):
    tok = base64.b64encode(f"{cfg['user']}:{cfg['passwd']}".encode()).decode()
    return {"Authorization": f"Basic {tok}"}


def _fetch_csrf(cfg, opener):
    base = cfg["httpbase"].rstrip("/")
    url = base + ADT_SEARCH + "?operation=quickSearch&query=Z*&maxResults=1&sap-client=" + cfg.get("client", "122")
    h = _auth_header(cfg); h.update({"Accept": "application/xml", "X-CSRF-Token": "Fetch"})
    req = urllib.request.Request(url, headers=h)
    with opener.open(req, timeout=_TIMEOUT) as r:
        return r.headers.get("x-csrf-token") or r.headers.get("X-CSRF-Token") or ""


def where_used(name: str, cfg: Optional[Dict[str, Any]] = None,
               max_refs: int = 25) -> List[Dict[str, str]]:
    """Live ADT where-used list for a Z/Y object over HTTP (no SDK).

    Returns dependency edges [{source, target, kind, type}] where `target` is a
    custom object that references `source`. Best effort; empty on any problem.
    """
    cfg = _cfg(cfg)
    base = (name or "").split("=>")[0].strip()
    if not is_configured(cfg) or not base:
        return []
    # 1) resolve the object's ADT uri (exact-name match preferred)
    hits = adt_search(base, cfg, max_results=8)
    obj = next((h for h in hits if h["name"].upper() == base.upper() and h.get("uri")), None)
    if not obj:
        return []
    import xml.etree.ElementTree as ET
    try:
        opener = _opener(cfg)
        csrf = _fetch_csrf(cfg, opener)
        url = (cfg["httpbase"].rstrip("/") + USAGE_REFS
               + "?uri=" + urllib.parse.quote(obj["uri"], safe="")
               + "&sap-client=" + cfg.get("client", "122"))
        h = _auth_header(cfg)
        h.update({
            "X-CSRF-Token": csrf,
            "Content-Type": "application/vnd.sap.adt.repository.usagereferences.request.v1+xml",
            "Accept": "application/vnd.sap.adt.repository.usagereferences.result.v1+xml",
        })
        req = urllib.request.Request(url, data=_WU_BODY.encode(), headers=h, method="POST")
        with opener.open(req, timeout=_TIMEOUT) as r:
            xml = r.read().decode("utf-8", "replace")
        root = ET.fromstring(xml)
    except Exception:
        return []

    edges, seen = [], set()
    for el in root.iter():
        if not el.tag.endswith("adtObject"):
            continue
        rn = _attr(el, "name")
        rt = _attr(el, "type")
        if not rn or rt.startswith("DEVC"):          # skip package nodes
            continue
        if rn.upper() == base.upper():
            continue
        if not rn.upper().startswith(("Z", "Y")):    # custom only
            continue
        if rn.upper() in seen:
            continue
        seen.add(rn.upper())
        edges.append({"source": base, "target": rn, "kind": "where-used",
                      "type": ADT_TYPE.get((rt or "").split("/")[0], rt or "Object")})
        if len(edges) >= max_refs:
            break
    return edges



def live_search(query: str, names: Optional[List[str]] = None,
                cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Combined live search over HTTP, restricted to the PS custom packages.

    Only returns objects that are BOTH:
      * in one of the configured development packages
        (ZPS_PROJ_EXEC / Z_PROF_SERVICES / ZCPM), and
      * in the custom namespace (name starts with Z or Y).
    Ranked by how well the query terms match the name/description.
    `names` = specific object names (top local matches) to confirm live.
    """
    cfg = _cfg(cfg)
    if not is_configured(cfg):
        return {"objects": [], "services": [], "source": "http-offline"}

    allowed = {p.strip().upper() for p in
               (cfg.get("packages") or ["ZPS_PROJ_EXEC", "Z_PROF_SERVICES", "ZCPM"])}
    terms = [t.lower() for t in (query or "").replace("/", " ").split() if len(t) >= 3]
    keep, seen = {}, set()

    def consider(o):
        nm = o.get("name", "")
        if not nm:
            return
        key = nm.upper()
        if key in seen:
            return
        # must be Z/Y namespace AND in one of the allowed packages
        if not key.lstrip().startswith(("Z", "Y")):
            return
        if (o.get("package") or "").strip().upper() not in allowed:
            return
        seen.add(key)
        blob = (nm + " " + (o.get("description") or "")).lower()
        o["_score"] = sum(1 for t in terms if t in blob)
        keep[key] = o

    # 1) confirm the specific top local matches (exact custom names)
    for nm in (names or [])[:3]:
        base = (nm or "").split("=>")[0]
        if not base.upper().startswith(("Z", "Y")):
            continue
        try:
            for o in adt_search(base, cfg, max_results=10):
                if base.upper() in o["name"].upper():
                    consider(o)
        except Exception:
            continue

    # 2) custom-namespace keyword search (few calls, custom-focused)
    for term in sorted(set(terms), key=len, reverse=True)[:3]:
        try:
            for o in adt_search(f"Z*{term}*", cfg, max_results=50):
                consider(o)
        except Exception:
            continue

    objects = sorted(keep.values(), key=lambda o: (-o.get("_score", 0), o["name"]))
    for o in objects:
        o.pop("_score", None)

    return {"objects": objects[:20], "services": [],
            "packages": sorted(allowed),
            "source": "live" if objects else "empty"}



