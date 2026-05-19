#!/usr/bin/env bash
# =============================================================================
# check-no-mock-in-prod.sh — Защита от попадания незавершённых заглушек в prod.
#
# Запускается в CI (deploy-staging.yml) перед деплоем.
#
# Два уровня проверок:
#
#   HARD-FAIL (exit 1) — незавершённые заглушки, которые нельзя деплоить:
#     - 'STUB_TODO'   — явная метка незавершённого кода (появляется когда
#                       разработчик намеренно оставил заглушку на будущее,
#                       например payment_url = 'STUB_TODO_STAGE_7').
#
#   WARN (exit 0) — паттерны с runtime-защитой, о которых нужно знать:
#     - 'operator_mock'  — staging-only провайдер, защищён assertNoMockInProduction()
#                          в billing-config.js (импортируется при старте функции).
#     - 'sendMock'       — fallback SMS-мок когда SMS_RU_API_ID не задан.
#                          На production ключ придёт из Lockbox.
#     - 'PROVIDER_MOCK'  — константа в sms-provider.js / email-provider.js.
#
# Исключения из всех проверок:
#   test/, node_modules/, *.md, *.sh, migrations/, .github/
#
# Выход:
#   0 — нет STUB_TODO в коде (возможны WARN-паттерны, о них пишем)
#   1 — найден STUB_TODO → деплой прерван
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREP_COMMON=(
    --include="*.js"
    --exclude-dir="test"
    --exclude-dir="node_modules"
    --exclude-dir="migrations"
    --exclude-dir=".github"
)

echo "🔍 check-no-mock-in-prod: $REPO_ROOT"
echo ""

# ---------------------------------------------------------------------------
# HARD-FAIL: STUB_TODO — незавершённые заглушки
# ---------------------------------------------------------------------------
echo "[ HARD-FAIL: STUB_TODO ]"

STUB_MATCHES=$(grep -r "${GREP_COMMON[@]}" -l "STUB_TODO" "$REPO_ROOT" 2>/dev/null || true)

HARD_FAIL=0
if [ -n "$STUB_MATCHES" ]; then
    echo "❌  Найдено 'STUB_TODO' — незавершённые заглушки должны быть реализованы"
    echo "    до деплоя в production:"
    while IFS= read -r file; do
        rel="${file#$REPO_ROOT/}"
        echo "    $rel"
        grep -n "STUB_TODO" "$file" | head -5 | sed 's/^/       /'
    done <<< "$STUB_MATCHES"
    HARD_FAIL=1
else
    echo "✅  Нет STUB_TODO"
fi

echo ""

# ---------------------------------------------------------------------------
# WARN: runtime-защищённые паттерны
# ---------------------------------------------------------------------------
echo "[ WARN: runtime-защищённые mock-паттерны ]"
echo "   (Эти паттерны допустимы — защищены assertNoMockInProduction()"
echo "    или отсутствием SMS_RU_API_ID в Lockbox)"
echo ""

WARN_PATTERNS=(
    "operator_mock:защищён billing-config.assertNoMockInProduction()"
    "sendMock:fallback, не активен если SMS_RU_API_ID задан в Lockbox"
    "PROVIDER_MOCK:константа в lib, не выходит в response"
)

for entry in "${WARN_PATTERNS[@]}"; do
    pattern="${entry%%:*}"
    note="${entry#*:}"

    MATCHES=$(grep -r "${GREP_COMMON[@]}" -l "$pattern" "$REPO_ROOT" 2>/dev/null || true)
    if [ -n "$MATCHES" ]; then
        COUNT=$(grep -r "${GREP_COMMON[@]}" -c "$pattern" "$REPO_ROOT" 2>/dev/null | \
                grep -v ":0$" | awk -F: '{sum+=$2} END{print sum}')
        echo "  ⚠️   '$pattern' — $COUNT вхождений (WARN, не блокирует)"
        echo "       $note"
        while IFS= read -r file; do
            echo "       ${file#$REPO_ROOT/}"
        done <<< "$MATCHES"
        echo ""
    fi
done

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$HARD_FAIL" -eq 1 ]; then
    echo "💥  FAIL: STUB_TODO найдено — деплой прерван."
    echo "    Реализуйте все заглушки или оберните в feature-flag."
    exit 1
else
    echo "✅  Нет критических блокеров. WARN-паттерны защищены runtime."
    exit 0
fi
