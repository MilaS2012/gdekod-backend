-- =============================================================================
-- 016_rollback.sql — откат миграции 016 (seed топ-20 магазинов).
--
-- Удаляем ТОЛЬКО те записи, которые были засеяны миграцией 016.
-- Другие записи (добавленные вручную или другими миграциями) не трогаем.
-- =============================================================================

DELETE FROM public_data.merchants
WHERE domain IN (
    'wildberries.ru',
    'ozon.ru',
    'aliexpress.ru',
    'sbermegamarket.ru',
    'market.yandex.ru',
    'mvideo.ru',
    'eldorado.ru',
    'dns-shop.ru',
    'citilink.ru',
    'lamoda.ru',
    'zara.com',
    'hm.com',
    'adidas.ru',
    'nike.com',
    'sportmaster.ru',
    'leroymerlin.ru',
    'ikea.com',
    'detmir.ru',
    'chitai-gorod.ru',
    'letual.ru'
);

DROP INDEX IF EXISTS idx_merchants_domain;
