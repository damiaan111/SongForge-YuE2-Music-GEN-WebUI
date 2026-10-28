"""Run setup either as an installed module or straight from the checkout.

``python -m songforge.setup`` works once the backend environment exists.
``python app/backend/songforge/setup/__main__.py`` works before it does, which
is the case that matters: setup must run on a machine where nothing has been
installed yet.
"""
from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    # .../app/backend/songforge/setup/__main__.py -> app/backend on sys.path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from songforge.setup.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
