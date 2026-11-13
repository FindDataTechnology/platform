#!/usr/bin/env python3
"""Purge old tags from TCR personal edition (hkccr yizuo/platform).

Keeps `main` + the N newest sha-* tags; deletes the rest by digest.
Reads TCR_USER/TCR_PASS from the environment (tcr-relay env on cheap-3).
"""
import json
import os
import sys
import urllib.request
import urllib.error
import base64

REG = "https://hkccr.ccs.tencentyun.com"
REPO = "yizuo/platform"
KEEP = {"main", "sha-a678e74", "sha-4cede32", "sha-352d662"}
KEEP_NEWEST = 5

auth = base64.b64encode(
    (os.environ["TCR_USER"] + ":" + os.environ["TCR_PASS"]).encode()
).decode()


def token():
    req = urllib.request.Request(
        REG + "/service/token?service=token-service&scope=repository:" + REPO + ":pull,push,delete",
        headers={"Authorization": "Basic " + auth},
    )
    return json.load(urllib.request.urlopen(req))["token"]


def api(path, method="GET", tok=None, accept=None):
    headers = {}
    if tok:
        headers["Authorization"] = "Bearer " + tok
    else:
        headers["Authorization"] = "Basic " + auth
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(REG + path, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def main():
    tok = token()
    status, body, _ = api("/v2/" + REPO + "/tags/list", tok=tok)
    tags = sorted(json.loads(body)["tags"])
    print("total tags:", len(tags))

    sha_tags = sorted([t for t in tags if t.startswith("sha-")])
    keep = set(KEEP) | set(sha_tags[-KEEP_NEWEST:])
    victims = [t for t in tags if t not in keep]
    print("keeping:", sorted(keep))
    print("deleting:", len(victims), "oldest tags")

    ok = fail = 0
    for t in victims:
        s, b, h = api(
            "/v2/" + REPO + "/manifests/" + t,
            tok=tok,
            accept="application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        )
        digest = h.get("Docker-Content-Digest") if h else None
        if not digest:
            fail += 1
            continue
        s2, _, _ = api("/v2/" + REPO + "/manifests/" + digest, method="DELETE", tok=tok)
        if s2 in (200, 202, 204):
            ok += 1
        else:
            fail += 1
            print("  delete failed", t, s2)
    print("deleted ok=%d fail=%d" % (ok, fail))

    s, body, _ = api("/v2/" + REPO + "/tags/list", tok=tok)
    print("tags now:", len(json.loads(body)["tags"]))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
