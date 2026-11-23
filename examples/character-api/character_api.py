"""Dependency-free client: python character_api.py GET /v1/character/summary.

Supply --body-file change.json for explicit writes. Requests are never retried.
"""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


class LocalOnlyRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def config_path():
    if sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ["LOCALAPPDATA"])
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return base / "TabletopVR/character-bridge/v2/http.json"


def request(method, path, body=None):
    config = config_path()
    api = json.loads(config.read_text(encoding="utf-8"))
    address = urlparse(api["url"])
    if address.scheme != "http" or address.hostname != "127.0.0.1" or address.username or address.password:
        raise ValueError("Invalid localhost API address")
    if not path.startswith("/v1/") and path != "/openapi.json":
        raise ValueError("Use /v1/... or /openapi.json")
    payload = None if body is None else json.dumps(body).encode("utf-8")
    call = Request(api["url"] + path, data=payload, method=method,
                   headers={"Authorization": "Bearer " + api["token"], "Content-Type": "application/json"})
    try:
        with build_opener(ProxyHandler({}), LocalOnlyRedirects()).open(call, timeout=75) as response:
            return json.load(response)
    except HTTPError as error:
        return json.load(error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", nargs="?", default="GET", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    parser.add_argument("path", nargs="?", default="/v1/status")
    parser.add_argument("--body-file", type=Path)
    args = parser.parse_args()
    try:
        body = json.loads(args.body_file.read_text(encoding="utf-8")) if args.body_file else None
        result = request(args.method, args.path, body)
    except (OSError, URLError, ValueError, KeyError):
        result = {"error": "api_unavailable"}
        if args.method != "GET":
            result.update(state="unknown", reason="Do not retry automatically; read current state first.")
    print(json.dumps(result, indent=2))
    return 1 if "error" in result or result.get("state") in ("unknown", "conflict", "rejected") else 0


if __name__ == "__main__":
    sys.exit(main())
