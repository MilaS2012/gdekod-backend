-- =============================================================================
-- 016_top_merchants_seed.sql
--
-- Наполняем public_data.merchants топ-20 популярных магазинов.
-- Логотипы — плейсхолдеры; реальные файлы загружаются в Yandex Object Storage
-- по инструкции docs/MERCHANT_LOGOS_GUIDE.md.
--
-- Идемпотентность: ON CONFLICT (domain) DO NOTHING.
-- Для работы ON CONFLICT нужен UNIQUE-индекс на domain — создаём его здесь.
-- =============================================================================

-- Уникальность domain (ключ идемпотентности для INSERT ON CONFLICT).
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_domain
    ON public_data.merchants (domain);

-- Топ-20 магазинов (плейсхолдеры logo_url; заменить реальными URL после загрузки).
INSERT INTO public_data.merchants (name, domain, logo_url, category, is_active)
VALUES
    ('Wildberries',       'wildberries.ru',       'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/wildberries.png',       'marketplace',  true),
    ('Ozon',              'ozon.ru',               'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/ozon.png',               'marketplace',  true),
    ('AliExpress',        'aliexpress.ru',         'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/aliexpress.png',         'marketplace',  true),
    ('СберМегаМаркет',    'sbermegamarket.ru',     'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/sbermegamarket.png',     'marketplace',  true),
    ('Яндекс Маркет',     'market.yandex.ru',     'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/yandex-market.png',      'marketplace',  true),
    ('М.Видео',           'mvideo.ru',             'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/mvideo.png',             'electronics',  true),
    ('Эльдорадо',         'eldorado.ru',           'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/eldorado.png',           'electronics',  true),
    ('DNS',               'dns-shop.ru',           'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/dns.png',               'electronics',  true),
    ('Ситилинк',          'citilink.ru',           'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/citilink.png',           'electronics',  true),
    ('Lamoda',            'lamoda.ru',             'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/lamoda.png',             'fashion',      true),
    ('ZARA',              'zara.com',              'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/zara.png',              'fashion',      true),
    ('H&M',               'hm.com',                'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/hm.png',                'fashion',      true),
    ('adidas',            'adidas.ru',             'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/adidas.png',             'sports',       true),
    ('Nike',              'nike.com',              'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/nike.png',              'sports',       true),
    ('Спортмастер',       'sportmaster.ru',        'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/sportmaster.png',        'sports',       true),
    ('Leroy Merlin',      'leroymerlin.ru',        'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/leroymerlin.png',        'home',         true),
    ('IKEA',              'ikea.com',              'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/ikea.png',              'home',         true),
    ('Детский мир',       'detmir.ru',             'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/detmir.png',             'kids',         true),
    ('Читай-город',       'chitai-gorod.ru',       'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/chitai-gorod.png',       'books',        true),
    ('Л''Этуаль',         'letual.ru',             'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/letual.png',             'beauty',       true)
ON CONFLICT (domain) DO NOTHING;
