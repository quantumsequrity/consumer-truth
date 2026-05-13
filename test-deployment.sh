#!/bin/bash
#
# Smoke tests for a deployed Alzhal instance.
# Set BASE_URL to your deployed worker URL before running.
#
# Notes on what each test actually checks:
#   1. Home page  — Next.js page served (status 200)
#   2. /api/stats — GET endpoint returns expected stats keys
#   3. /api/analyze/text — POST with string `text` body (NOT an array)
#   4. /api/compare — POST with `product_a` and `product_b` string fields
#   5. /api/feedback — POST with `scan_id` (snake_case) and rating "up"/"down"
#
# A previous version of this script sent payloads that did not match the API
# contracts (e.g. ingredients as an array, rating as a number, camelCase
# scanId, products as an array). Those tests appeared to pass because the
# pass/fail predicate only checked for "success" in the response, which the
# JSON parse swallowed. Fixed: payloads now match the real handlers.

BASE_URL="${BASE_URL:-https://your-worker.workers.dev}"

if [[ "$BASE_URL" == *"your-worker.workers.dev"* ]]; then
  echo "Set BASE_URL=https://your-deployed-worker.workers.dev before running."
  exit 1
fi

# Some endpoints require an Origin header to pass the CSRF check. Use the
# deployed URL itself as the origin for the smoke test calls.
ORIGIN="$BASE_URL"

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "PASS"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

echo "========================================="
echo "ALZHAL DEPLOYMENT SMOKE TEST"
echo "Target: $BASE_URL"
echo "========================================="

# Test 1: Home Page
echo ""
echo "TEST 1: Home Page"
echo "-----------------"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL")
echo "Status Code: $STATUS"
if [ "$STATUS" == "200" ]; then
  pass
else
  fail "expected 200, got $STATUS"
fi

# Test 2: Stats API (GET, no CSRF)
echo ""
echo "TEST 2: Stats API"
echo "-----------------"
STATS=$(curl -s "$BASE_URL/api/stats")
echo "$STATS" | python3 -m json.tool 2>/dev/null | head -10
if echo "$STATS" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'productsChecked' in d else 1)" 2>/dev/null; then
  pass
else
  fail "productsChecked missing from response"
fi

# Test 3: Text Analysis (POST). Field is `text`, string. Includes Origin.
echo ""
echo "TEST 3: Text Analysis API"
echo "-------------------------"
ANALYSIS=$(curl -s -X POST "$BASE_URL/api/analyze/text" \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d '{"text":"water, sugar, salt","language":"English"}')
echo "$ANALYSIS" | python3 -m json.tool 2>/dev/null | head -20
# Success: response contains an `ingredients` array. Failure: an `error` field.
if echo "$ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if isinstance(d.get('ingredients'), list) else 1)" 2>/dev/null; then
  pass
else
  fail "expected an ingredients array in the response"
fi

# Test 4: Compare (POST). Fields are product_a and product_b. Origin required.
echo ""
echo "TEST 4: Compare API"
echo "-------------------"
COMPARE=$(curl -s -X POST "$BASE_URL/api/compare" \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d '{"product_a":"Maggi Noodles","product_b":"Yippee Noodles","language":"English"}')
echo "$COMPARE" | python3 -m json.tool 2>/dev/null | head -15
# Success: response contains product_a and product_b objects.
if echo "$COMPARE" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'product_a' in d and 'product_b' in d else 1)" 2>/dev/null; then
  pass
else
  fail "expected product_a + product_b in the response"
fi

# Test 5: Feedback (POST). scan_id (snake_case), rating "up"/"down".
# We use a sentinel scan_id; the endpoint validates shape, not FK.
echo ""
echo "TEST 5: Feedback API"
echo "--------------------"
FEEDBACK=$(curl -s -X POST "$BASE_URL/api/feedback" \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  -d '{"scan_id":"smoke-test-'$(date +%s)'","rating":"up","comment":"Automated test"}')
echo "$FEEDBACK"
if echo "$FEEDBACK" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('success') else 1)" 2>/dev/null; then
  pass
else
  fail "feedback did not return success:true"
fi

echo ""
echo "========================================="
echo "TESTS COMPLETE — $PASS passed, $FAIL failed"
echo "========================================="
exit $FAIL
