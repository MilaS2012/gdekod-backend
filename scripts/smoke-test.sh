#!/usr/bin/env bash
# =============================================================================
# smoke-test.sh — HTTP smoke-тест после деплоя в staging/production.
#
# Использование:
#   bash scripts/smoke-test.sh <API_BASE_URL> [HEALTH_TOKEN]
#
# Аргументы:
#   API_BASE_URL   — базовый URL API без trailing slash
#                    Например: https://api.gde-code.ru
#   HEALTH_TOKEN   — Bearer-токен для /health endpoint'ов
#                    (PRIVATE_API_HEALTH_TOKEN или PUBLIC_API_HEALTH_TOKEN)
#                    Опционально: без токена /health-проверки пропускаются
#
# Выход:
#   0 — все проверки прошли
#   1 — хотя бы одна проверка не прошла (с описанием)
#
# Примеры:
#   bash scripts/smoke-test.sh https://api.gde-code.ru "$HEALTH_TOKEN"
#   bash scripts/smoke-test.sh http://localhost:3000
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Аргументы
# ---------------------------------------------------------------------------
API_BASE="${1:-}"
HEALTH_TOKEN="${2:-}"

if [ -z "$API_BASE" ]; then
    echo "Usage: $0 <API_BASE_URL> [HEALTH_TOKEN]"
    echo "Example: $0 https://api.gde-code.ru my-health-token"
    exit 1
fi

# Убираем trailing slash
API_BASE="${API_BASE%/}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
PASS=0
FAIL=0

check() {
    local name="$1"
    local url="$2"
    local expected_status="$3"
    local extra_args="${4:-}"

    local actual_status
    # shellcheck disable=SC2086
    actual_status=$(curl -s -o /dev/null -w "%{http_code}" \
        --connect-timeout 10 \
        --max-time 15 \
        $extra_args \
        "$url" 2>/dev/null || echo "000")

    if [ "$actual_status" = "$expected_status" ]; then
        echo "  ✅  $name → HTTP $actual_status"
        PASS=$((PASS + 1))
    else
        echo "  ❌  $name → ожидали HTTP $expected_status, получили $actual_status"
        echo "       URL: $url"
        FAIL=$((FAIL + 1))
    fi
}

check_json_field() {
    local name="$1"
    local url="$2"
    local field="$3"
    local expected_value="$4"
    local extra_args="${5:-}"

    local body
    # shellcheck disable=SC2086
    body=$(curl -s \
        --connect-timeout 10 \
        --max-time 15 \
        $extra_args \
        "$url" 2>/dev/null || echo "{}")

    # Простой grep для проверки JSON-поля (без jq)
    if echo "$body" | grep -q "\"$field\":\"$expected_value\"" || \
       echo "$body" | grep -q "\"$field\": \"$expected_value\""; then
        echo "  ✅  $name — $field='$expected_value'"
        PASS=$((PASS + 1))
    else
        echo "  ❌  $name — $field != '$expected_value'"
        echo "       URL: $url"
        echo "       Response: $(echo "$body" | head -c 200)"
        FAIL=$((FAIL + 1))
    fi
}

# ---------------------------------------------------------------------------
# Smoke-тесты
# ---------------------------------------------------------------------------

echo ""
echo "🚀 Smoke-тест: $API_BASE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "[ Public API ]"

# GET /api/merchants — список магазинов (публичный)
check \
    "GET /api/merchants" \
    "$API_BASE/api/merchants" \
    "200"

# GET /api/coupons — список промокодов (публичный)
check \
    "GET /api/coupons" \
    "$API_BASE/api/coupons" \
    "200"

# GET /api/merchants/nonexistent — несуществующий → 404
check \
    "GET /api/merchants/nonexistent → 404" \
    "$API_BASE/api/merchants/nonexistent-slug-xyz" \
    "404"

echo ""
echo "[ Private API — Auth ]"

# POST /api/auth/start — с невалидным телефоном → 400
check \
    "POST /api/auth/start (невалидный phone) → 400" \
    "$API_BASE/api/auth/start" \
    "400" \
    "-X POST -H 'Content-Type: application/json' -d '{\"phone\":\"not-a-phone\"}'"

# POST /api/auth/start — с валидным телефоном → 200 otp_sent (mock SMS)
# Используем тестовый номер, который SMS.ru принимает без реальной отправки
check \
    "POST /api/auth/start (валидный phone) → 200" \
    "$API_BASE/api/auth/start" \
    "200" \
    "-X POST -H 'Content-Type: application/json' -d '{\"phone\":\"+79001234567\"}'"

echo ""
echo "[ Private API — Protected ]"

# GET /api/account/profile без JWT → 401
check \
    "GET /api/account/profile (без JWT) → 401" \
    "$API_BASE/api/account/profile" \
    "401"

# GET /api/subscription/status без JWT → 401
check \
    "GET /api/subscription/status (без JWT) → 401" \
    "$API_BASE/api/subscription/status" \
    "401"

echo ""
echo "[ Health endpoints ]"

if [ -n "$HEALTH_TOKEN" ]; then
    # Private /health
    check_json_field \
        "GET /health (private) — service='private'" \
        "$API_BASE/health" \
        "service" \
        "private" \
        "-H 'Authorization: Bearer $HEALTH_TOKEN'"

    # Public /health
    check_json_field \
        "GET /health (public) — status='ok'" \
        "$API_BASE/health" \
        "status" \
        "ok" \
        "-H 'Authorization: Bearer $HEALTH_TOKEN'"
else
    echo "  ⚠️   HEALTH_TOKEN не передан — /health проверки пропущены"
    echo "       Передайте токен: bash scripts/smoke-test.sh <url> <token>"
fi

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS + FAIL))
echo "Результат: $PASS/$TOTAL прошли"

if [ "$FAIL" -gt 0 ]; then
    echo "💥  FAIL — $FAIL проверок не прошли"
    exit 1
else
    echo "✅  Все smoke-тесты прошли"
    exit 0
fi
