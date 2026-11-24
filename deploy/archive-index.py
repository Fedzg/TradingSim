"""Index a stopped or offline state copy into a separate immutable backup directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
src, dest = args.source.resolve(), args.destination.resolve()
if not src.is_dir() or dest.is_relative_to(src) or src.is_relative_to(dest):
    parser.error("Use independent directories and a consistent offline source.")
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def inventory(root):
    files = sorted(root.rglob("*"))
    if any(f.is_symlink() for f in files):
        raise ValueError("Unexpected symbolic link")
    return {str(f.relative_to(root)): digest(f) for f in files if f.is_file()}
original = inventory(src)
if dest.exists():
    manifest = json.loads((dest/"manifest.json").read_text())
    if original != manifest["files"] or inventory(dest/"backup") != original:
        raise ValueError("Backup or source differs")
else:
    with tempfile.TemporaryDirectory(dir=dest.parent) as temp:
        stage = Path(temp)/"archive"
        stage.mkdir(mode=0o700)
        backup = stage/"backup"
        shutil.copytree(src, backup)
        if original != inventory(backup) or original != inventory(src):
            raise ValueError("Inconsistent copy")
        records = []
        for f in sorted((backup/"outbox").glob("*.json")):
            row = json.loads(f.read_text())
            records.append(dict(file=f.name, generated=row.get("queuedAt"), kind=row.get("kind"),
                producer=(row.get("producer") or {}).get("commit") or "LEGACY — UNKNOWN",
                status=row.get("deliveryStatus") or ("DELIVERED" if row.get("delivered") else "DELIVERY_UNKNOWN")))
        (stage/"manifest.json").write_text(json.dumps(dict(indexSchema=1, files=original, notifications=records), indent=2))
        os.rename(stage, dest)
print(f"{len(original)} files verified")
