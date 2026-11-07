"""Write the API schema to docs/openapi.json. Run with the API project's Python."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from taskwell.main import app  # noqa: E402

path = ROOT / "docs" / "openapi.json"
path.write_text(json.dumps(app.openapi(), indent=2) + "\n")
print(f"Wrote {path}")
