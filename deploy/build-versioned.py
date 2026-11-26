"""Build exactly the Git tree named by the operator, independent of working files."""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile

commit = subprocess.check_output(["git", "rev-parse", "--verify", sys.argv[1] + "^{commit}"], text=True).strip()
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    archive = root / "sources.tar"
    subprocess.run(["git", "archive", "-o", str(archive), commit], check=True)
    with tarfile.open(archive) as files:
        files.extractall(root, filter="data")
    archive.unlink()
    path = root / "src/build-identity.json"
    identity = json.loads(path.read_text())
    identity.update(commit=commit, builtAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    path.write_text(json.dumps(identity))
    ca = os.environ.get("TRADINGSIM_BUILD_CA")
    trust = ["--secret", "id=build-ca,src=" + ca] if ca else []
    subprocess.run(["docker", "build", *trust, "--label", "org.opencontainers.image.revision=" + commit,
                    "-f", str(root / "deploy/Dockerfile"), "-t", "tradingsim:" + commit[:12], str(root)], check=True)
    subprocess.run(["docker","image","inspect","--format","{{.Id}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}","tradingsim:" + commit[:12]],check=True)
