/**
 * ГдеКод — Playwright Checker
 * Проверяет один промокод как живой пользователь.
 * Не хранит никаких ПД пользователей — только данные о промокоде.
 */

const { chromium } = require('playwright');

// Человеческие User-Agent строки (Windows/Chrome)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

// Фразы, означающие что промокод истёк
const EXPIRED_SIGNALS = [
  'промокод недействителен',
  'промокод не найден',
  'истёк срок действия',
  'срок действия истёк',
  'недействительный промокод',
  'купон недействителен',
  'код недействителен',
  'промокод не существует',
  'скидка не применена',
  'promocode is invalid',
  'coupon expired',
  'coupon not found',
  'invalid coupon',
  'promo code expired',
];

// Фразы, означающие что промокод сработал
const SUCCESS_SIGNALS = [
  'скидка применена',
  'промокод применён',
  'промокод активирован',
  'купон применён',
  'скидка',
  'discount applied',
  'coupon applied',
  'promo applied',
  'promocode accepted',
];

/**
 * Случайная пауза — имитация человека
 * @param {number} minMs
 * @param {number} maxMs
 */
async function humanPause(minMs = 1500, maxMs = 3000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Печатаем текст с задержкой 150мс между символами
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} text
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  await page.fill(selector, ''); // очищаем
  for (const char of text) {
    await page.type(selector, char, { delay: 150 });
  }
}

/**
 * Случайный User-Agent из списка
 */
function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Проверяет промокод на сайте магазина
 *
 * @param {Object} coupon
 * @param {string} coupon.id           — ID промокода в нашей БД
 * @param {string} coupon.code         — сам промокод
 * @param {string} coupon.merchant_url — URL сайта магазина
 * @param {string} coupon.merchant_id  — ID магазина
 * @param {Object} coupon.check_config — конфиг для конкретного сайта (селекторы)
 *
 * @returns {Object} result
 * @returns {string} result.coupon_id
 * @returns {string} result.status        — 'active' | 'expired' | 'needs_manual_check'
 * @returns {string} result.checked_at    — ISO timestamp
 * @returns {string|null} result.error    — описание ошибки если needs_manual_check
 */
async function checkCoupon(coupon) {
  const { id, code, merchant_url, check_config } = coupon;
  const checkedAt = new Date().toISOString();

  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    });

    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      viewport: { width: 1366, height: 768 },
      // Инкогнито — без cookies прошлых сессий
      storageState: undefined,
    });

    const page = await context.newPage();

    // Блокируем тяжёлые ресурсы — быстрее и меньше трафика
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,woff,woff2}', route => route.abort());
    await page.route('**/analytics**', route => route.abort());
    await page.route('**/metrika**', route => route.abort());
    await page.route('**/counter**', route => route.abort());

    // Переходим на страницу с корзиной / промокодом
    const targetUrl = check_config.cart_url || merchant_url;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await humanPause(2000, 4000);

    // Если нужно добавить товар в корзину
    if (check_config.add_to_cart_selector) {
      try {
        await page.waitForSelector(check_config.add_to_cart_selector, { timeout: 10000 });
        await page.click(check_config.add_to_cart_selector);
        await humanPause(2000, 3000);
      } catch {
        // Товар уже в корзине или не нужно добавлять
      }
    }

    // Переходим в корзину если нужно
    if (check_config.cart_page_url) {
      await page.goto(check_config.cart_page_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await humanPause(1500, 2500);
    }

    // Ищем поле для промокода
    const promoSelector = check_config.promo_input_selector;
    if (!promoSelector) {
      return {
        coupon_id: id,
        status: 'needs_manual_check',
        checked_at: checkedAt,
        error: 'Нет конфига selectors для этого магазина',
      };
    }

    await page.waitForSelector(promoSelector, { timeout: 15000 });
    await humanPause(500, 1000);

    // Вводим промокод как человек
    await humanType(page, promoSelector, code);
    await humanPause(800, 1500);

    // Нажимаем кнопку применить
    const applySelector = check_config.promo_apply_selector;
    if (applySelector) {
      await page.click(applySelector);
    } else {
      await page.keyboard.press('Enter');
    }

    // Ждём ответа страницы
    await humanPause(2000, 4000);

    // Читаем текст страницы для анализа результата
    const pageText = (await page.textContent('body') || '').toLowerCase();

    // Проверяем на истечение
    const isExpired = EXPIRED_SIGNALS.some(signal => pageText.includes(signal));
    if (isExpired) {
      return {
        coupon_id: id,
        status: 'expired',
        checked_at: checkedAt,
        error: null,
      };
    }

    // Проверяем на успех
    const isSuccess = SUCCESS_SIGNALS.some(signal => pageText.includes(signal));
    if (isSuccess) {
      return {
        coupon_id: id,
        status: 'active',
        checked_at: checkedAt,
        error: null,
      };
    }

    // Неоднозначный результат — нужна ручная проверка
    return {
      coupon_id: id,
      status: 'needs_manual_check',
      checked_at: checkedAt,
      error: 'Не удалось определить результат автоматически',
    };

  } catch (err) {
    // Сайт заблокировал бота или другая ошибка
    const errorMessage = err.message || String(err);

    // НЕ логируем ничего про пользователей — только технические ошибки
    console.error(`[checker] Ошибка при проверке coupon_id=${id}: ${errorMessage}`);

    return {
      coupon_id: id,
      status: 'needs_manual_check',
      checked_at: checkedAt,
      error: errorMessage.substring(0, 200), // обрезаем длинные сообщения
    };

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { checkCoupon };
