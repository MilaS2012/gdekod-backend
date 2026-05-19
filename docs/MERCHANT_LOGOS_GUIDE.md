# Гид по загрузке логотипов магазинов

> **Кто делает:** Мила  
> **Когда:** после деплоя миграции 016 на production  
> **Зачем:** заменить placeholder-URL реальными логотипами в Yandex Object Storage

---

## Обзор

После применения миграции 016 в базе появятся 20 магазинов с временными URL вида:

```
https://storage.yandexcloud.net/gdekod-assets/merchants/logos/wildberries.png
```

Эти URL **не работают** пока ты не загрузишь реальные файлы. Ниже — пошаговая инструкция.

---

## Шаг 1. Подготовь логотипы

Собери PNG-логотипы для каждого магазина. Требования:

| Параметр       | Значение                          |
|----------------|-----------------------------------|
| Формат         | PNG с прозрачным фоном            |
| Размер         | 200×200 px (квадрат)              |
| Размер файла   | ≤ 50 KB                           |
| Цветовой режим | RGB (не CMYK)                     |

**Список файлов — точные имена (важно!):**

```
wildberries.png
ozon.png
aliexpress.png
sbermegamarket.png
yandex-market.png
mvideo.png
eldorado.png
dns.png
citilink.png
lamoda.png
zara.png
hm.png
adidas.png
nike.png
sportmaster.png
leroymerlin.png
ikea.png
detmir.png
chitai-gorod.png
letual.png
```

---

## Шаг 2. Загрузи в Yandex Object Storage

### Вариант А — через веб-консоль (проще)

1. Открой [Yandex Cloud Console](https://console.yandex.cloud) → **Object Storage**
2. Найди бакет `gdekod-assets` (или создай, если нет)
3. Перейди в папку `merchants/logos/` (создай, если нет)
4. Нажми **Загрузить объекты** → выбери все 20 файлов
5. После загрузки убедись, что файлы публично доступны:
   - Выдели все файлы → **Действия** → **Изменить права доступа** → **Публичный**

### Вариант Б — через YC CLI (быстрее, если уже настроен)

```bash
# Убедись, что aws CLI настроен под Yandex Cloud (или используй yc s3)
aws s3 cp ./logos/ s3://gdekod-assets/merchants/logos/ \
    --recursive \
    --acl public-read \
    --endpoint-url https://storage.yandexcloud.net
```

### Проверка загрузки

После загрузки каждый логотип должен открываться в браузере:

```
https://storage.yandexcloud.net/gdekod-assets/merchants/logos/wildberries.png
```

---

## Шаг 3. Проверь, что API отдаёт логотипы

После загрузки — проверь public-api:

```bash
# Замени BASE_URL на реальный URL твоего production public-api
BASE_URL="https://public-api.gdekod.ru"

curl -s "$BASE_URL/api/merchants" | \
    jq '.merchants[] | {name: .name, logo: .logo_url}' | \
    head -40
```

Ожидаемый результат: `logo_url` у каждого магазина — живой URL (не 404).

---

## Шаг 4. Если нужно добавить новый магазин

Это делается **вручную через SQL** (без новой миграции):

```sql
INSERT INTO public_data.merchants (name, domain, logo_url, category, is_active)
VALUES (
    'Название магазина',
    'domain.ru',
    'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/filename.png',
    'marketplace',   -- marketplace / electronics / fashion / sports / home / kids / books / beauty
    true
)
ON CONFLICT (domain) DO UPDATE
    SET logo_url  = EXCLUDED.logo_url,
        name      = EXCLUDED.name,
        is_active = EXCLUDED.is_active;
```

Загрузи логотип (шаг 2), затем выполни SQL через Yandex Cloud → Managed PostgreSQL → SQL-редактор.

---

## Шаг 5. Если нужно обновить logo_url (например, ты перегрузила файл)

```sql
UPDATE public_data.merchants
   SET logo_url = 'https://storage.yandexcloud.net/gdekod-assets/merchants/logos/wildberries.png'
 WHERE domain = 'wildberries.ru';
```

---

## Бакет и права доступа

| Параметр           | Значение                                                   |
|--------------------|------------------------------------------------------------|
| Бакет              | `gdekod-assets`                                            |
| Папка              | `merchants/logos/`                                         |
| ACL файлов         | `public-read` (анонимный GET)                              |
| Endpoint           | `https://storage.yandexcloud.net`                          |
| Полный URL шаблон  | `https://storage.yandexcloud.net/gdekod-assets/merchants/logos/{filename}.png` |

> ⚠️ Если бакет `gdekod-assets` ещё не создан — создай его в Yandex Cloud Console
> и убедись, что он **публичный** (иначе логотипы будут 403).

---

## Вопросы?

Смотри `README_DEPLOY.md` (раздел «Yandex Object Storage») или спроси в чате проекта.
