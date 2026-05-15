import sys
from pathlib import Path

ADAPTER_ROOT = Path(__file__).resolve().parents[1]
PYTHON_ADAPTER_ROOT = ADAPTER_ROOT.parent / "python"
for root in (PYTHON_ADAPTER_ROOT, ADAPTER_ROOT):
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
