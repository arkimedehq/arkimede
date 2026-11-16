"""POST notes: adds a note, emits note.added and notifies the plugin's owner."""
import json
import sys
import uuid
from datetime import datetime, timezone

from plugin_api import call, service

data = json.load(sys.stdin)
cfg = data.get("_config", {})
body = (data.get("route") or {}).get("body") or {}
text = str(body.get("text", "")).strip()[:500]
if not text:
    print(json.dumps({"status": 400, "body": {"error": "text required"}}))
    sys.exit(0)

note = {"id": str(uuid.uuid4()), "text": text, "at": datetime.now(timezone.utc).isoformat(), "by": (data.get("user") or {}).get("name")}
notes = (service(cfg, "storage.get", {"key": "notes"}).get("value") or [])[-199:]
service(cfg, "storage.set", {"key": "notes", "value": notes + [note]})
call(cfg, "events", {"events": [{"id": note["id"], "type": "note.added", "data": {"id": note["id"], "text": text}}]})
service(cfg, "notify", {"title": cfg.get("NOTIFY_TITLE", "New note"), "body": text})
print(json.dumps({"status": 201, "body": note}))
