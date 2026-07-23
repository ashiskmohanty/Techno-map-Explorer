"""
Production entry point for PS Process Explorer.

Serves the Flask app with waitress (a pure-Python WSGI server that works on
Windows and any Python version) bound to all network interfaces so other users
on the network can reach it. Because everyone connects to this single instance,
the training store (corrections), feedback, and usage metrics are shared
automatically.

Run:
    pip install -r requirements.txt
    python serve.py

Configuration (environment variables)
--------------------------------------
    PSPE_HOST        interface to bind (default 0.0.0.0 = all)
    PSPE_PORT        port (default 5000)
    PSPE_ADMIN_KEY   admin key for the metrics tab (set this so only you hold it)

    # shared stores (optional - default to files next to the app, which are
    # already shared since everyone hits this one instance):
    PSPE_CORR_FILE   path to the shared corrections/training store
    PSPE_FB_FILE     path to the shared feedback store
    PSPE_USAGE_FILE  path to the shared usage log

    # SAP MS1 (so the one instance connects for everyone):
    SAP_HTTP_BASE, SAP_CLIENT, SAP_USER, SAP_PASSWD   (HTTP/OData, no SDK)
    or SAP_ASHOST/SAP_SYSNR/... with pyrfc for RFC.
"""
import os

import app as flask_app
import build_data

if __name__ == "__main__":
    if not os.path.exists(os.path.join(flask_app.HERE, "data.json")):
        build_data.build()
    try:
        flask_app._ensure_admin_key()   # prints the admin unlock URL on first run
    except Exception:
        pass

    host = os.environ.get("PSPE_HOST", "0.0.0.0")
    port = int(os.environ.get("PSPE_PORT")
               or os.environ.get("PORT")            # Azure App Service / Heroku
               or os.environ.get("WEBSITES_PORT")   # Azure Web App
               or 5000)
    try:
        from waitress import serve
    except ImportError:
        raise SystemExit("waitress is required: pip install waitress")

    print(f"PS Process Explorer (production)  ->  http://{host}:{port}")
    serve(flask_app.app, host=host, port=port, threads=8)
