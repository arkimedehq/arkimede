#!/usr/bin/env bash
#
# smoke-scoping.sh — API smoke test for the personal|team|org scoping.
#
# Covers: §1 personal · §2 org · §3 team-creation authorization · §4 team visibility
#         §5 team management · §7 data sources · §10 per-id security.
# Does NOT cover §6 (skills): requires ZIP upload + async install → manual test.
#
# Creates throwaway users/teams/resources and DELETES them at the end (cleanup trap).
# Dependencies: curl, node (no jq).
#
# Usage:
#   ADMIN_EMAIL=info@rstonline.it ADMIN_PASSWORD='...' ./scripts/smoke-scoping.sh
# Optional variables:
#   BASE_URL   (default http://localhost:3000/api)
#
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SFX="$$_$RANDOM"   # unique suffix for names/emails

if [ -z "$ADMIN_EMAIL" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: set ADMIN_EMAIL and ADMIN_PASSWORD (credentials of an existing admin)." >&2
  echo "Example: ADMIN_EMAIL=info@rstonline.it ADMIN_PASSWORD='secret' $0" >&2
  exit 2
fi
command -v node >/dev/null || { echo "ERROR: node is required in PATH" >&2; exit 2; }

# ── JSON helper: reads stdin, evaluates an expression over `o` (parsed) ─────────
jget() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);let r=eval(process.argv[1]);process.stdout.write(r===undefined||r===null?"":String(r))}catch(e){process.stdout.write("")}})' "$1"
}

# ── API call: populates $CODE and $BODY ──────────────────────────────────────
CODE=""; BODY=""
api() { # METHOD PATH TOKEN [JSON]
  local method="$1" path="$2" token="$3" data="${4:-}"
  local args=(-s -X "$method" "$BASE_URL$path")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$data" ]; then args+=(-H "Content-Type: application/json" -d "$data"); fi
  local resp; resp=$(curl -w $'\n%{http_code}' "${args[@]}")
  CODE="${resp##*$'\n'}"
  BODY="${resp%$'\n'*}"
}

# ── assertions ────────────────────────────────────────────────────────────────
PASS=0; FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1  [HTTP=$CODE BODY=$(echo "$BODY" | head -c 200)]"; FAIL=$((FAIL+1)); }
expect_code() { # CSV_CODES desc
  case ",$1," in (*,"$CODE",*) ok "$2 (HTTP $CODE)";; (*) bad "$2 (expected $1)";; esac
}
# check that a name is present in a list (array of resources in the current BODY)
has_name() { echo "$BODY" | jget "o.some(x=>x.name==='$1')"; }
list_tools()   { api GET /custom-tools  "$1"; }
list_ds()      { api GET /data-sources  "$1"; }
expect_visible() { [ "$(has_name "$2")" = "true" ] && ok "$3" || bad "$3"; }
expect_hidden()  { [ "$(has_name "$2")" = "true" ] && bad "$3" || ok "$3"; }

# ── login & user creation ─────────────────────────────────────────────────────
login() { # email password  → echo token
  api POST /auth/login "" "{\"email\":\"$1\",\"password\":\"$2\"}"
  echo "$BODY" | jget 'o.access_token'
}
PWD_DEF="smoke_pw_123"
declare -a CREATED_USERS=()
# NB: ALWAYS call in command substitution `X=$(create_user ...)`; the append to the
# CREATED_USERS array must be done in the PARENT (see §0), because inside `$()` it
# would run in a subshell and be lost.
create_user() { # name email role → echo id  (as admin)
  api POST /admin/users "$ADMIN" "{\"name\":\"$1\",\"email\":\"$2\",\"password\":\"$PWD_DEF\",\"role\":\"$3\"}"
  echo "$BODY" | jget 'o.id'
}

# ── cleanup ────────────────────────────────────────────────────────────────────
declare -a CLEAN_TOOLS=()   # "id|token"
declare -a CLEAN_DS=()      # "id|token"
TEAM_ID=""
cleanup() {
  echo; echo "── cleanup ──"
  for e in "${CLEAN_TOOLS[@]:-}"; do [ -z "$e" ] && continue; api DELETE "/custom-tools/${e%%|*}" "${e##*|}"; done
  for e in "${CLEAN_DS[@]:-}";    do [ -z "$e" ] && continue; api DELETE "/data-sources/${e%%|*}" "${e##*|}"; done
  [ -n "$TEAM_ID" ] && { api DELETE "/teams/$TEAM_ID" "$ADMIN"; echo "  team $TEAM_ID → HTTP $CODE"; }
  for id in "${CREATED_USERS[@]:-}"; do
    [ -z "$id" ] && continue
    api DELETE "/admin/users/$id" "$ADMIN"
    echo "  user $id → HTTP $CODE"
  done
  # verify that no test users are left
  api GET "/admin/users?search=example.test&pageSize=100" "$ADMIN"
  local left; left=$(echo "$BODY" | jget 'o.total')
  if [ "$left" = "0" ]; then echo "  ✅ no leftover test users"; else echo "  ⚠️  example.test leftovers: $left (check)"; fi
  echo "cleanup completed."
}
trap cleanup EXIT

# ── payload helpers ─────────────────────────────────────────────────────────────
tool_payload() { # name scope [teamId]
  local team=""; [ -n "${3:-}" ] && team=",\"teamId\":\"$3\""
  printf '{"name":"%s","description":"smoke","executorType":"http","executorConfig":{"url":"https://example.com","method":"GET"},"parameters":[],"scope":"%s"%s}' "$1" "$2" "$team"
}
ds_payload() { # name scope [teamId]
  local team=""; [ -n "${3:-}" ] && team=",\"teamId\":\"$3\""
  printf '{"name":"%s","connectionString":"postgresql://u:p@localhost:5432/db","scope":"%s"%s}' "$1" "$2" "$team"
}

echo "== Scoping smoke test — $BASE_URL =="

# ── §0 setup ────────────────────────────────────────────────────────────────────
echo; echo "§0 Setup"
ADMIN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
[ -n "$ADMIN" ] || { echo "Admin login failed. Check credentials/URL." >&2; exit 1; }
ok "admin login"

B_ID=$(create_user "Smoke B" "smoke_b_$SFX@example.test" user); [ -n "$B_ID" ] && CREATED_USERS+=("$B_ID")
C_ID=$(create_user "Smoke C" "smoke_c_$SFX@example.test" user); [ -n "$C_ID" ] && CREATED_USERS+=("$C_ID")
D_ID=$(create_user "Smoke D" "smoke_d_$SFX@example.test" user); [ -n "$D_ID" ] && CREATED_USERS+=("$D_ID")
[ -n "$B_ID" ] && [ -n "$C_ID" ] && [ -n "$D_ID" ] && ok "created users B/C/D" || { bad "user creation"; exit 1; }

TB=$(login "smoke_b_$SFX@example.test" "$PWD_DEF")
TC=$(login "smoke_c_$SFX@example.test" "$PWD_DEF")
TD=$(login "smoke_d_$SFX@example.test" "$PWD_DEF")
[ -n "$TB" ] && [ -n "$TC" ] && [ -n "$TD" ] && ok "login B/C/D" || bad "login B/C/D"

api POST /teams "$ADMIN" "{\"name\":\"Smoke Sales $SFX\",\"color\":\"#3366ff\"}"
TEAM_ID=$(echo "$BODY" | jget 'o.id')
[ -n "$TEAM_ID" ] && ok "team created" || { bad "team created"; exit 1; }
api POST "/teams/$TEAM_ID/members" "$ADMIN" "{\"userId\":\"$B_ID\",\"role\":\"owner\"}";  expect_code 201 "B owner of the team"
api POST "/teams/$TEAM_ID/members" "$ADMIN" "{\"userId\":\"$C_ID\",\"role\":\"member\"}"; expect_code 201 "C member of the team"

# ── §1 personal ───────────────────────────────────────────────────────────────────
echo; echo "§1 Personal scope"
api POST /custom-tools "$TB" "$(tool_payload "t_personal_$SFX" personal)"; expect_code 201 "B creates t_personal"
TP_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_TOOLS+=("$TP_ID|$TB")
list_tools "$TB"; expect_visible "$TB" "t_personal_$SFX" "B sees its own personal"
list_tools "$TC"; expect_hidden  "$TC" "t_personal_$SFX" "C does not see B's personal"
list_tools "$TD"; expect_hidden  "$TD" "t_personal_$SFX" "D does not see B's personal"

# ── §2 org ────────────────────────────────────────────────────────────────────────
echo; echo "§2 Org scope"
api POST /custom-tools "$TB" "$(tool_payload "t_org_b_$SFX" org)"; expect_code 403 "B (non admin) CANNOT create org"
api POST /custom-tools "$ADMIN" "$(tool_payload "t_org_$SFX" org)"; expect_code 201 "A creates t_org"
TORG_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_TOOLS+=("$TORG_ID|$ADMIN")
list_tools "$TB"; expect_visible "$TB" "t_org_$SFX" "B sees org"
list_tools "$TC"; expect_visible "$TC" "t_org_$SFX" "C sees org"
list_tools "$TD"; expect_visible "$TD" "t_org_$SFX" "D sees org"
api PUT "/custom-tools/$TORG_ID" "$TB" '{"description":"hack"}'; expect_code 403 "B cannot modify org"
api POST /custom-tools "$ADMIN" "$(tool_payload "t_org_$SFX" org)"; expect_code 409 "duplicate org name rejected"

# ── §3 team-creation authorization ─────────────────────────────────────────────────
echo; echo "§3 Team-scoped creation"
api POST /custom-tools "$TB" "$(tool_payload "t_team_$SFX" team "$TEAM_ID")"; expect_code 201 "B (owner) creates t_team"
TT_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_TOOLS+=("$TT_ID|$TB")
api POST /custom-tools "$TC" "$(tool_payload "t_team_c_$SFX" team "$TEAM_ID")"; expect_code 403 "C (member) does NOT create team"
api POST /custom-tools "$TD" "$(tool_payload "t_team_d_$SFX" team "$TEAM_ID")"; expect_code 403 "D (external) does NOT create team"
api POST /custom-tools "$ADMIN" "$(tool_payload "t_team_a_$SFX" team "$TEAM_ID")"; expect_code 201 "A (admin) creates team"
TTA_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_TOOLS+=("$TTA_ID|$ADMIN")

# ── §4 team visibility ─────────────────────────────────────────────────────────────
echo; echo "§4 Team-scoped visibility"
list_tools "$TC"; expect_visible "$TC" "t_team_$SFX" "C (member) sees t_team"
list_tools "$TD"; expect_hidden  "$TD" "t_team_$SFX" "D (external) does NOT see t_team"
# LIST visibility is per-membership: A (admin) is NOT a member of the team,
# so t_team does NOT appear in its list. Per-id MANAGEMENT stays allowed (see §5).
list_tools "$ADMIN"; expect_hidden "$ADMIN" "t_team_$SFX" "A (admin, non member) does not have t_team in list"

# ── §5 team management ──────────────────────────────────────────────────────────────
echo; echo "§5 Team-scoped management"
api PUT "/custom-tools/$TT_ID" "$TB" '{"description":"updated by owner"}'; expect_code 200 "B (owner) modifies t_team"
api PUT "/custom-tools/$TT_ID" "$TC" '{"description":"hack"}'; expect_code 403 "C (member) does NOT modify t_team"
api PUT "/custom-tools/$TT_ID" "$ADMIN" '{"description":"updated by admin"}'; expect_code 200 "A (admin) modifies t_team"

# ── §7 data sources ────────────────────────────────────────────────────────────────
echo; echo "§7 Data sources"
api POST /data-sources "$TB" "$(ds_payload "ds_team_$SFX" team "$TEAM_ID")"; expect_code 201 "B creates team data source"
DST_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_DS+=("$DST_ID|$TB")
list_ds "$TC"; expect_visible "$TC" "ds_team_$SFX" "C sees team data source"
list_ds "$TD"; expect_hidden  "$TD" "ds_team_$SFX" "D does not see team data source"
api POST /data-sources "$ADMIN" "$(ds_payload "ds_org_$SFX" org)"; expect_code 201 "A creates org data source"
DSO_ID=$(echo "$BODY" | jget 'o.id'); CLEAN_DS+=("$DSO_ID|$ADMIN")
list_ds "$TD"; expect_visible "$TD" "ds_org_$SFX" "D sees org data source"
api POST /data-sources "$TC" "$(ds_payload "ds_team_c_$SFX" team "$TEAM_ID")"; expect_code 403 "C (member) does NOT create team data source"

# ── §10 per-id security (API bypass) ───────────────────────────────────────────────
echo; echo "§10 Per-id security"
api GET   "/custom-tools/$TT_ID" "$TD"; expect_code 404 "D GET t_team per-id denied"
api PUT   "/custom-tools/$TT_ID" "$TC" '{"description":"hack"}'; expect_code 403 "C PUT t_team per-id denied"
api PATCH "/custom-tools/$TT_ID/toggle" "$TD" ""; expect_code "403,404" "D toggle t_team per-id denied"
api GET   "/data-sources/$DST_ID" "$TD"; expect_code 404 "D GET team data source per-id denied"

# ── §9 dynamic membership ────────────────────────────────────────────────────────────
echo; echo "§9 Dynamic membership"
api DELETE "/teams/$TEAM_ID/members/$C_ID" "$ADMIN"; expect_code 204 "A removes C from the team"
list_tools "$TC"; expect_hidden "$TC" "t_team_$SFX" "C removed no longer sees t_team"
api POST "/teams/$TEAM_ID/members" "$ADMIN" "{\"userId\":\"$C_ID\",\"role\":\"member\"}"; expect_code 201 "A re-adds C"
list_tools "$TC"; expect_visible "$TC" "t_team_$SFX" "C re-added sees t_team again"

# ── summary ───────────────────────────────────────────────────────────────────────────
echo; echo "════════════════════════════════"
echo "Result: $PASS passed, $FAIL failed"
echo "════════════════════════════════"
[ "$FAIL" -eq 0 ]
