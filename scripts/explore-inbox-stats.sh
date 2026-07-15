#!/usr/bin/env bash
# Explore Missive inbox/assignment data available without Business Analytics.
# Usage: MISSIVE_API_TOKEN=... ./scripts/explore-inbox-stats.sh
set -euo pipefail

TOKEN="${MISSIVE_API_TOKEN:-${MISSIVE_API_KEY:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "Set MISSIVE_API_TOKEN or MISSIVE_API_KEY"
  exit 1
fi

BASE="https://public.missiveapp.com/v1"
auth=(-H "Authorization: Bearer ${TOKEN}")

api() {
  local path="$1"
  shift
  curl -sS "${auth[@]}" "${BASE}${path}" "$@"
}

echo "=== ORGANIZATIONS ==="
api /organizations | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f\"  {o['id']}  {o['name']}\") for o in d.get('organizations',[])]"

ORG_ID=$(api /organizations | python3 -c "import sys,json; o=json.load(sys.stdin).get('organizations',[]); print(o[0]['id'] if o else '')")

echo
echo "=== TEAMS (org ${ORG_ID}) ==="
api "/teams?organization=${ORG_ID}&limit=50" | python3 -c "
import sys, json
for t in json.load(sys.stdin).get('teams', []):
    print(f\"  {t['id']}  {t['name']}\")
"

TEAM_ID=$(api "/teams?organization=${ORG_ID}&limit=50" | python3 -c "
import sys, json
teams = json.load(sys.stdin).get('teams', [])
# Prefer a team with visible team_inbox traffic; fall back to first.
print(teams[0]['id'] if teams else '')
")
TEAM_NAME=$(api "/teams?organization=${ORG_ID}&limit=50" | python3 -c "
import sys, json
teams = json.load(sys.stdin).get('teams', [])
print(teams[0]['name'] if teams else '')
")

echo
echo "=== USERS (org ${ORG_ID}) ==="
api "/users?organization=${ORG_ID}&limit=50" | python3 -c "import sys,json; [print(f\"  {u['id']}  {u.get('name','')}  {u.get('email','')}\") for u in json.load(sys.stdin).get('users',[])]"

sample() {
  local label="$1"
  local query="$2"
  echo
  echo "=== ${label} ==="
  api "/conversations?${query}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
convs = data.get('conversations', [])
print(f'  returned: {len(convs)}')
if convs:
    c = convs[0]
    print(f'  sample keys: {sorted(c.keys())}')
    print(f'  subject: {c.get(\"latest_message_subject\") or c.get(\"subject\")}')
    print(f'  assignees: {[a.get(\"email\") for a in c.get(\"assignees\", [])]}')
    print(f'  assignee_emails: {c.get(\"assignee_emails\")}')
    print(f'  closed: {c.get(\"closed\")}')
    users = c.get('users') or []
    if users:
        u = users[0]
        print(f'  users[0]: assigned={u.get(\"assigned\")} unassigned={u.get(\"unassigned\")} closed={u.get(\"closed\")}')
"
}

sample "personal inbox (inbox=true)" "inbox=true&limit=10"
sample "personal assigned (assigned=true)" "assigned=true&limit=10"
sample "team inbox (${TEAM_NAME})" "team_inbox=${TEAM_ID}&limit=10"
sample "team all (${TEAM_NAME})" "team_all=${TEAM_ID}&limit=10"

echo
echo "=== TEAM INBOX COUNTS (first page only) ==="
export MISSIVE_API_TOKEN="$TOKEN"
api "/teams?organization=${ORG_ID}&limit=50" | python3 -c "
import sys, json, urllib.request, os

TOKEN = os.environ.get('MISSIVE_API_TOKEN') or os.environ.get('MISSIVE_API_KEY')
BASE = 'https://public.missiveapp.com/v1'

def count(query):
    req = urllib.request.Request(f'{BASE}/conversations?{query}&limit=50', headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return len(json.load(resp).get('conversations', []))

for t in json.load(sys.stdin).get('teams', []):
    tid = t['id']
    inbox_n = count(f'team_inbox={tid}')
    all_n = count(f'team_all={tid}')
    closed_n = count(f'team_closed={tid}')
    print(f\"  {t['name']}: team_inbox={inbox_n} team_all={all_n} team_closed={closed_n}\")
"

echo
echo "=== AGGREGATE: ${TEAM_NAME} team_all (up to 3 pages x 50) ==="
export MISSIVE_API_TOKEN="$TOKEN"
export TEAM_ID
python3 -c "
import sys, json, urllib.request, os

TOKEN = os.environ.get('MISSIVE_API_TOKEN') or os.environ.get('MISSIVE_API_KEY')
BASE = 'https://public.missiveapp.com/v1'
TEAM_ID = os.environ['TEAM_ID']

def fetch(until=None):
    q = f'team_all={TEAM_ID}&limit=50'
    if until:
        q += f'&until={until}'
    req = urllib.request.Request(f'{BASE}/conversations?{q}', headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp).get('conversations', [])

total = unassigned = 0
by_assignee = {}
until = None
pages = 0
while pages < 3:
    convs = fetch(until)
    if not convs:
        break
    for c in convs:
        total += 1
        assignees = c.get('assignees') or []
        if not assignees:
            unassigned += 1
        else:
            for a in assignees:
                email = a.get('email') or a.get('id')
                by_assignee[email] = by_assignee.get(email, 0) + 1
    pages += 1
    if len(convs) < 50:
        break
    until = str(convs[-1].get('last_activity_at'))

print(json.dumps({
    'team_id': TEAM_ID,
    'view': 'team_all',
    'pages_fetched': pages,
    'conversations_counted': total,
    'unassigned': unassigned,
    'by_assignee': by_assignee,
    'truncated': pages == 3 and len(convs) == 50,
}, indent=2))
"

echo
echo "=== AGGREGATE: organization view (up to 3 pages x 50) ==="
export ORG_ID
export MISSIVE_API_TOKEN="$TOKEN"
python3 -c "
import sys, json, urllib.request, os

TOKEN = os.environ.get('MISSIVE_API_TOKEN') or os.environ.get('MISSIVE_API_KEY')
BASE = 'https://public.missiveapp.com/v1'
ORG_ID = os.environ['ORG_ID']

def fetch(until=None):
    q = f'organization={ORG_ID}&limit=50'
    if until:
        q += f'&until={until}'
    req = urllib.request.Request(f'{BASE}/conversations?{q}', headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp).get('conversations', [])

total = unassigned = 0
by_assignee = {}
by_team = {}
until = None
pages = 0
while pages < 3:
    convs = fetch(until)
    if not convs:
        break
    for c in convs:
        total += 1
        team = (c.get('team') or {}).get('name') or 'no_team'
        by_team[team] = by_team.get(team, 0) + 1
        assignees = c.get('assignees') or []
        if not assignees:
            unassigned += 1
        else:
            for a in assignees:
                email = a.get('email') or a.get('id')
                by_assignee[email] = by_assignee.get(email, 0) + 1
    pages += 1
    if len(convs) < 50:
        break
    until = str(convs[-1].get('last_activity_at'))

print(json.dumps({
    'organization_id': ORG_ID,
    'view': 'organization',
    'pages_fetched': pages,
    'conversations_counted': total,
    'unassigned': unassigned,
    'by_assignee': by_assignee,
    'by_team': by_team,
    'truncated': pages == 3 and len(convs) == 50,
}, indent=2))
"

echo
echo "=== HOT LABEL FLAGS: ${TEAM_NAME} (open + label %hot%) ==="
export TEAM_NAME
python3 -c "
import json, os, re, urllib.request
from datetime import datetime, timezone

TOKEN = os.environ.get('MISSIVE_API_TOKEN') or os.environ.get('MISSIVE_API_KEY')
ORG_ID = os.environ['ORG_ID']
TEAM_NAME = os.environ.get('TEAM_NAME', 'Maazah')
BASE = 'https://public.missiveapp.com/v1'
HOT = re.compile(r'hot', re.I)

def api(path):
    req = urllib.request.Request(f'{BASE}{path}', headers={'Authorization': f'Bearer {TOKEN}'})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)

def labels_of(c):
    v = c.get('shared_label_names')
    if not v: return []
    return v if isinstance(v, list) else [v]

def is_closed(c):
    if c.get('closed_at'): return True
    users = c.get('users') or []
    return bool(users) and all(u.get('closed') for u in users)

teams = api(f'/teams?organization={ORG_ID}&limit=50').get('teams', [])
team = next((t for t in teams if TEAM_NAME.lower() in t['name'].lower()), None)
if not team:
    print(json.dumps({'error': f'team not found: {TEAM_NAME}'}))
    raise SystemExit(1)

tid = team['id']
convs, until, pages = [], None, 0
while pages < 20:
    q = f'team_all={tid}&limit=50'
    if until: q += f'&until={until}'
    batch = api(f'/conversations?{q}').get('conversations', [])
    if not batch: break
    convs.extend(batch)
    pages += 1
    if len(batch) < 50: break
    until = str(batch[-1].get('last_activity_at'))

def ts(v):
    return datetime.fromtimestamp(int(v), tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC') if v else None

hot_open = []
for c in convs:
    hl = [l for l in labels_of(c) if HOT.search(l)]
    if not hl or is_closed(c):
        continue
    snoozed = [u.get('email') for u in (c.get('users') or []) if u.get('snoozed')]
    hot_open.append({
        'subject': c.get('latest_message_subject') or c.get('subject'),
        'hot_labels': hl,
        'assignees': c.get('assignee_emails') or '',
        'snoozed_by': snoozed,
        'last_activity': ts(c.get('last_activity_at')),
    })

print(json.dumps({
    'team': team['name'],
    'open_conversations_scanned': len(convs),
    'open_hot_count': len(hot_open),
    'open_hot_snoozed_count': sum(1 for h in hot_open if h['snoozed_by']),
    'flags': hot_open,
}, indent=2))
"
