"""GET notes: the notes, newest first (as a route answer, or as a tool result)."""
import json
import sys

from plugin_api import service

data = json.load(sys.stdin)
cfg = data.get("_config", {})
notes = service(cfg, "storage.get", {"key": "notes"}).get("value") or []
print(json.dumps({"status": 200, "body": {"notes": list(reversed(notes))}} if "route" in data else {"notes": list(reversed(notes))}))
