/**
 * ГдеКод — одиночный тест проверки промокода
 *
 * Запуск:
 *   node test/single-check.js merchants/wildberries.json TESTPROMO
 *
 * Не обращается к Yandex API. Просто запускает Playwright и печатает результат.
 * Полезно при разработке селекторов нового магазина.
 */

const fs = require('fs');
const path = require('path');
const { checkCoupon } = require('../checker');

async function main() {
  const configPath = process.argv[2];
  const code       = process.argv[3];

  if (!configPath || !code) {
    console.error('Использование: node test/single-check.js <merchant-config.json> <promo-code>');
    process.exit(1);
  }

  const fullPath = path.resolve(configPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Файл не найден: ${fullPath}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));

  const coupon = {
    id:           'test-' + Date.now(),
    code:         code,
    merchant_id:  config.merchant_id,
    merchant_url: config.cart_url,
    check_config: config,
  };

  console.log(`\n→ Проверяем код "${code}" на ${config.name}\n`);

  const startedAt = Date.now();
  const result = await checkCoupon(coupon);
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n─── Результат ───');
  console.log(`Статус:       ${result.status}`);
  console.log(`Проверено:    ${result.checked_at}`);
  console.log(`Длительность: ${durationSec} сек`);
  if (result.error) console.log(`Ошибка:       ${result.error}`);
  console.log('─────────────────\n');
}

main().catch(err => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
