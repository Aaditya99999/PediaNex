from __future__ import annotations

import json
import sys
from pathlib import Path

KID_DIR = Path(__file__).resolve().parents[1]
if str(KID_DIR) not in sys.path:
    sys.path.insert(0, str(KID_DIR))

from chart_plotting import ChartPlotError, generate_chart_package


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        response = generate_chart_package(payload)
    except ChartPlotError as exc:
        json.dump({"error": str(exc)}, sys.stdout)
        return 1

    json.dump(response, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
