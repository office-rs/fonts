"""Tests for tools/verify.py — spec 6.5 integrity gate.

Run with the pinned interpreter:
  C:/Users/flw/AppData/Local/Python/pythoncore-3.14-64/python.exe -m pytest tools/ -q
"""
import json, subprocess, sys, tempfile
from pathlib import Path
REPO = Path(__file__).resolve().parent.parent

def test_verify_passes_on_fresh_slice(tmp_path):
    out = tmp_path / "d"
    subprocess.run([sys.executable, str(REPO / "tools/slice.py"),
                    "--input", str(REPO / "sources/NotoSans-Regular.ttf"),
                    "--key", "notosans", "--is-latin", "--out", str(out)], check=True)
    r = subprocess.run([sys.executable, str(REPO / "tools/verify.py"), str(out / "manifest.json"),
                        "--sources", str(REPO / "sources")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr

def test_verify_catches_corrupt_sha(tmp_path):
    out = tmp_path / "d"
    subprocess.run([sys.executable, str(REPO / "tools/slice.py"),
                    "--input", str(REPO / "sources/NotoSans-Regular.ttf"),
                    "--key", "notosans", "--is-latin", "--out", str(out)], check=True)
    m = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    m["families"]["notosans"]["whole"]["sha256"] = "0" * 64
    (out / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    r = subprocess.run([sys.executable, str(REPO / "tools/verify.py"), str(out / "manifest.json")], capture_output=True, text=True)
    assert r.returncode != 0
