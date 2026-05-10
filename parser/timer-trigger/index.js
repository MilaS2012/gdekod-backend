/**
 * ГдеКод — Azure Functions Timer Trigger
 * Три отдельные функции для трёх tier + urgent.
 *
 * Деплой: azure-function/ как отдельный проект в gdekod-backend
 *
 * CRON расписания см. ниже в каждом app.timer().
 * (UTC, Москва = UTC+3)
 *   Tier 1: каждые 3 часа
 *   Tier 2: каждые 8 часов
 *   Tier 3: раз в сутки
 *   Urgent: каждые 5 минут
 */

const { app } = require('@azure/functions');
const { execFile } = require('child_process');
const path = require('path');

const SCHEDULER_PATH = path.join(__dirname, '..', 'scheduler.js');

/**
 * Запускаем scheduler как дочерний процесс с нужным tier
 * Это даёт изоляцию — падение парсера не роняет Functions host
 */
function runScheduler(tier, context) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PARSER_TIER: String(tier),
    };

    context.log(`[timer-trigger] Запуск scheduler tier=${tier}`);

    const child = execFile('node', [SCHEDULER_PATH], { env, timeout: 25 * 60 * 1000 }, (err, stdout, stderr) => {
      if (stdout) context.log(stdout);
      if (stderr) context.warn(stderr);
      if (err) {
        context.error(`[timer-trigger] Ошибка tier=${tier}: ${err.message}`);
        reject(err);
      } else {
        context.log(`[timer-trigger] Tier ${tier} завершён успешно`);
        resolve();
      }
    });
  });
}

// ——————————————————————————
// Tier 1 — каждые 3 часа
// ——————————————————————————
app.timer('parser-tier1', {
  schedule: '0 0 0,3,6,9,12,15,18,21 * * *', // UTC (московское -3ч)
  handler: async (myTimer, context) => {
    context.log('[tier1] Timer trigger fired');
    try {
      await runScheduler(1, context);
    } catch (err) {
      context.error('[tier1] Завершился с ошибкой:', err.message);
      // Не кидаем дальше — Function должна завершиться без retry для парсера
    }
  },
});

// ——————————————————————————
// Tier 2 — каждые 8 часов
// ——————————————————————————
app.timer('parser-tier2', {
  schedule: '0 0 1,9,17 * * *',
  handler: async (myTimer, context) => {
    context.log('[tier2] Timer trigger fired');
    try {
      await runScheduler(2, context);
    } catch (err) {
      context.error('[tier2] Завершился с ошибкой:', err.message);
    }
  },
});

// ——————————————————————————
// Tier 3 — раз в сутки
// ——————————————————————————
app.timer('parser-tier3', {
  schedule: '0 0 2 * * *', // 05:00 МСК
  handler: async (myTimer, context) => {
    context.log('[tier3] Timer trigger fired');
    try {
      await runScheduler(3, context);
    } catch (err) {
      context.error('[tier3] Завершился с ошибкой:', err.message);
    }
  },
});

// ——————————————————————————
// Urgent — каждые 5 минут
// ——————————————————————————
app.timer('parser-urgent', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    // Тихий запуск — не логируем каждые 5 минут если нечего делать
    const env = { ...process.env, PARSER_TIER: 'urgent' };

    const { execFile } = require('child_process');
    await new Promise((resolve) => {
      execFile('node', [SCHEDULER_PATH], { env, timeout: 4 * 60 * 1000 }, (err, stdout) => {
        if (err) context.warn(`[urgent] Ошибка: ${err.message}`);
        else if (stdout.includes('Срочная')) context.log(stdout);
        resolve();
      });
    });
  },
});
