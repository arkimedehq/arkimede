"""Calls to Arkimede's plugin API (internal/plugins) with the plugin's token."""
import json
import os
import urllib.request


def call(cfg, path, body):
    url = os.environ.get("BACKEND_INTERNAL_URL", "http://localhost:3000").rstrip("/") + "/internal/plugins/" + path
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-plugin-token": cfg.get("PLUGIN_TOKEN", "")},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode("utf-8") or "null")


def service(cfg, name, body):
    return call(cfg, "services/" + name, body)
