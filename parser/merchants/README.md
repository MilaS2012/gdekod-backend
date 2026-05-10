# Конфиги магазинов

Каждый магазин описывается JSON-конфигом с селекторами для Playwright.

## Tier (приоритет проверки)

| Tier | Интервал | Кто туда попадает |
|------|----------|-------------------|
| 1    | 3 часа   | Топ-10: WB, Ozon, Магнит, Самокат, Я.Еда, М.Видео, Перекрёсток, Лента, Sephora, Lamoda |
| 2    | 8 часов  | Средние известные магазины |
| 3    | 24 часа  | Длинный хвост — малопосещаемые |

Tier хранится в БД в таблице `merchants` (поле `tier`), не в этих конфигах.

## Структура конфига

```json
{
  "merchant_id":            "wildberries",
  "name":                   "Wildberries",
  "cart_url":               "https://www.wildberries.ru/cart",
  "add_to_cart_selector":   ".add-to-basket-btn",
  "cart_page_url":          "https://www.wildberries.ru/cart",
  "promo_input_selector":   "input[name='promo']",
  "promo_apply_selector":   "button.btn-promo-apply"
}
```

| Поле | Обязательно | Описание |
|------|:-:|---|
| `merchant_id` | ✅ | ID в БД |
| `cart_url` | ✅ | Стартовая страница (обычно корзина или каталог) |
| `add_to_cart_selector` | — | CSS-селектор кнопки «В корзину». Если null — товар уже добавлен или не нужен. |
| `cart_page_url` | — | URL корзины, если переходим после добавления |
| `promo_input_selector` | ✅ | Поле ввода промокода |
| `promo_apply_selector` | — | Кнопка «Применить». Если null — Enter. |

## Как добавить новый магазин

1. Зайти на сайт под обычным юзером
2. Открыть DevTools → Inspector
3. Найти селекторы поля промокода и кнопки применения
4. Создать JSON-файл здесь
5. Запустить тест: `npm run test:single -- merchants/имя.json КОД-ПРОМОКОДА`
6. Если работает → добавить в БД через админку

## Что делать если сайт защищён от ботов

- Проверить `EXPIRED_SIGNALS` и `SUCCESS_SIGNALS` в `checker.js` — добавить фразы из ответа сайта
- Если Cloudflare/CAPTCHA блокируют → ставим `tier 3` и помечаем для ручной проверки
- См. ТЗ §20.7: статус `needs_manual_check` → задача оператору
