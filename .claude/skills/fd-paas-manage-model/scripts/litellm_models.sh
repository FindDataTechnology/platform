#!/usr/bin/env bash
# litellm_models.sh - manage models on the PAAS LiteLLM proxy.
# Bundled with the fd-paas-manage-model skill.
#
# Why this exists: the proxy lives on the LAN (192.168.1.4:4000) and the shell
# exports a global http_proxy whose no_proxy does NOT cover the LAN, so a bare
# `curl http://192.168.1.4:4000/...` silently fails with HTTP 000. Every request
# here passes --noproxy '*' for LAN targets. It also loads the admin key from
# PAAS/.env so the key never lands in shell history. Prefer this over hand-rolled curl.
#
# NOTE: runs under /bin/bash (3.2 on macOS). It deliberately avoids the
# `"$(cmd "arg")"` nested-quote pattern - bash 3.2 mis-parses it and leaks brace
# expansion into python -c. JSON is built with quoted heredocs (<<'PY') instead.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at PAAS/.claude/skills/fd-paas-manage-model/scripts -> 4 levels up to PAAS root.
PAAS_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ENVFILE="${PAAS_ROOT}/.env"

die() { echo "error: $*" >&2; exit 1; }

# True if the URL's host is LAN/private (needs --noproxy). External hosts go
# through the normal (clash) proxy.
is_lan_url() {
  local host
  host=$(printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#[:/].*$##')
  case "$host" in
    localhost|127.*|::1|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
  esac
  return 1
}

# Load LITELLM_BASE_URL / LITELLM_API_KEY from .env unless already in the env.
if [ -z "${LITELLM_BASE_URL:-}" ] || [ -z "${LITELLM_API_KEY:-}" ]; then
  if [ -f "$ENVFILE" ]; then
    while IFS= read -r line; do
      case "$line" in
        LITELLM_BASE_URL=*) LITELLM_BASE_URL="${line#LITELLM_BASE_URL=}" ;;
        LITELLM_API_KEY=*)  LITELLM_API_KEY="${line#LITELLM_API_KEY=}" ;;
      esac
    done < "$ENVFILE"
    LITELLM_BASE_URL="${LITELLM_BASE_URL%\"}"; LITELLM_BASE_URL="${LITELLM_BASE_URL#\"}"
    LITELLM_API_KEY="${LITELLM_API_KEY%\"}";  LITELLM_API_KEY="${LITELLM_API_KEY#\"}"
  fi
fi

: "${LITELLM_BASE_URL:?LITELLM_BASE_URL not set (not in env, not found in $ENVFILE)}"
: "${LITELLM_API_KEY:?LITELLM_API_KEY not set (not in env, not found in $ENVFILE)}"

AUTH=(-H "Authorization: Bearer $LITELLM_API_KEY")
NOPT=()
if is_lan_url "$LITELLM_BASE_URL"; then NOPT=(--noproxy '*'); fi
CURL=(curl -s -m 30 "${NOPT[@]}")

# --- JSON builders: quoted heredoc so the shell never touches braces/quotes.
# Values are passed via the environment, never argv, to dodge bash 3.2 quoting bugs.
json_add() {
  N="$1" UP="$2" API_BASE="$3" API_KEY="$4" python3 <<'PY'
import json, os
print(json.dumps({"model_name": os.environ["N"],
                  "litellm_params": {"model": os.environ["UP"],
                                     "api_base": os.environ["API_BASE"],
                                     "api_key": os.environ["API_KEY"]}}))
PY
}
json_chat() {
  M="$1" P="$2" python3 <<'PY'
import json, os
print(json.dumps({"model": os.environ["M"],
                  "messages": [{"role": "user", "content": os.environ["P"]}],
                  "max_tokens": 64}))
PY
}
json_id() {
  ID="$1" python3 <<'PY'
import json, os
print(json.dumps({"id": os.environ["ID"]}))
PY
}

usage() {
  cat <<EOF
Usage: $0 <command> [args]   (proxy: \$LITELLM_BASE_URL)

  list                          Public model names (GET /v1/models)
  info                          name <TAB> upstream-model <TAB> db-id (GET /model/info)
  add <name> <upstream> <api_base> <api_key>
                                Add a model. <upstream> with no '/' is auto-prefixed
                                'openai/' (OpenAI-compatible). Prints the new model_id.
  delete <model_id>             Delete by db id (POST /model/delete)
  delete-name <model_name>      Look up by public name, then delete
  test <model_name> [prompt]    Chat completion THROUGH the proxy (proves routing)
  validate <api_base> <api_key> [model]
                                Validate an OpenAI-compatible endpoint BEFORE registering:
                                GET /models, plus a tiny /chat/completions if <model> given.

Env: LITELLM_BASE_URL, LITELLM_API_KEY (loaded from $ENVFILE if unset).
EOF
}

cmd_list() {
  "${CURL[@]}" "$LITELLM_BASE_URL/v1/models" "${AUTH[@]}" \
    | python3 -c "import json,sys; [print(m['id']) for m in json.load(sys.stdin).get('data',[])]"
}

cmd_info() {
  "${CURL[@]}" "$LITELLM_BASE_URL/model/info" "${AUTH[@]}" \
    | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    lp=m.get('litellm_params',{}) or {}
    mid=(m.get('model_info',{}) or {}).get('id','')
    print(str(m.get('model_name'))+'\t'+str(lp.get('model'))+'\t'+str(mid))
"
}

cmd_add() {
  [ $# -ge 4 ] || die "add needs: <name> <upstream> <api_base> <api_key>"
  local name="$1" upstream="$2" api_base="$3" api_key="$4"
  case "$upstream" in
    */*) ;;                 # already prefixed (openai/, anthropic/, azure/, bedrock/...)
    *)  upstream="openai/$upstream" ;;  # default: OpenAI-compatible
  esac
  echo "adding: name=$name model=$upstream api_base=$api_base" >&2
  local body
  body=$(json_add "$name" "$upstream" "$api_base" "$api_key")
  "${CURL[@]}" -X POST "$LITELLM_BASE_URL/model/new" \
    "${AUTH[@]}" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('model_id') or json.dumps(d))"
}

cmd_delete() {
  [ $# -ge 1 ] || die "delete needs: <model_id>"
  local body
  body=$(json_id "$1")
  "${CURL[@]}" -X POST "$LITELLM_BASE_URL/model/delete" \
    "${AUTH[@]}" -H "Content-Type: application/json" -d "$body"
  echo
}

cmd_delete_name() {
  [ $# -ge 1 ] || die "delete-name needs: <model_name>"
  local name="$1" id
  "${CURL[@]}" "$LITELLM_BASE_URL/model/info" "${AUTH[@]}" -o /tmp/_llm_info.json
  id=$(NAME="$name" python3 <<'PY'
import json, os
for m in json.load(open("/tmp/_llm_info.json")).get("data", []):
    if m.get("model_name") == os.environ["NAME"]:
        print((m.get("model_info") or {}).get("id", "")); break
PY
)
  [ -n "$id" ] || die "no model named '$name' on the proxy"
  echo "deleting $name ($id)" >&2
  cmd_delete "$id"
}

cmd_test() {
  [ $# -ge 1 ] || die "test needs: <model_name> [prompt]"
  local name="$1" prompt="${2:-Reply with exactly: ok}" body
  body=$(json_chat "$name" "$prompt")
  "${CURL[@]}" -X POST "$LITELLM_BASE_URL/v1/chat/completions" \
    "${AUTH[@]}" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d: print('ERROR:',json.dumps(d['error'])[:500]); sys.exit(1)
m=d.get('choices',[{}])[0].get('message',{})
print('content:',repr(m.get('content'))[:200])
if m.get('reasoning_content'): print('reasoning:',repr(m.get('reasoning_content'))[:120])
print('usage:',d.get('usage',{}))
"
}

cmd_validate() {
  [ $# -ge 2 ] || die "validate needs: <api_base> <api_key> [model]"
  local api_base="$1" api_key="$2" model="${3:-}"
  local vnopt=()
  if is_lan_url "$api_base"; then vnopt=(--noproxy '*'); fi
  echo "== GET $api_base/models =="
  curl -s -m 30 "${vnopt[@]}" -o /tmp/_vm.json -w "HTTP %{http_code}\n" \
    "$api_base/models" -H "Authorization: Bearer $api_key"
  if [ -n "$model" ]; then
    echo "== chat $model =="
    local body
    body=$(M="$model" python3 <<'PY'
import json, os
print(json.dumps({"model": os.environ["M"],
                  "messages": [{"role":"user","content":"Reply with exactly: ok"}],
                  "max_tokens": 64}))
PY
)
    curl -s -m 30 "${vnopt[@]}" -X POST "$api_base/chat/completions" \
      -H "Authorization: Bearer $api_key" -H "Content-Type: application/json" \
      -d "$body" -o /tmp/_vc.json -w "HTTP %{http_code}\n"
    head -c 300 /tmp/_vc.json; echo
  fi
}

[ $# -ge 1 ] || { usage; exit 1; }
case "$1" in
  list)         shift; cmd_list "$@" ;;
  info)         shift; cmd_info "$@" ;;
  add)          shift; cmd_add "$@" ;;
  delete)       shift; cmd_delete "$@" ;;
  delete-name)  shift; cmd_delete_name "$@" ;;
  test)         shift; cmd_test "$@" ;;
  validate)     shift; cmd_validate "$@" ;;
  -h|--help|help) usage ;;
  *) die "unknown command: $1 (try: $0 help)" ;;
esac
