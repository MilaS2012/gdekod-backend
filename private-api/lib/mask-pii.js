// =============================================================================
// mask-pii.js — маскирование персональных данных для логов.
//
// ★ По ТЗ §3.7, §21 и Стратегии тестирования: в логах НИКОГДА не должны
//   появляться phone, email, password, токены magic-link, JWT.
//
// Эти хелперы — единственный разрешённый способ упомянуть PII в логе.
// Если видишь в коде console.log(phone) или JSON.stringify(user) — это баг.
//
// Примеры:
//   maskPhone('+79261234567') === '+7926***4567'
//   maskEmail('user@example.com') === 'u***@e***.com'
//   maskToken('abcdef1234567890') === 'abcd...7890'
// =============================================================================

/**
 * Маскирует телефон в формате E.164 (+7...). Показывает код страны/оператора
 * и последние 4 цифры, остальное — '*'.
 *   '+79261234567' → '+7926***4567'
 * Если на вход пришло не строкой или короче 7 символов — возвращает '***'.
 */
export function maskPhone(phone) {
    if (typeof phone !== 'string') return '***';
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return '***';
    const head = digits.slice(0, 4);  // 7926
    const tail = digits.slice(-4);    // 4567
    return `+${head}***${tail}`;
}

/**
 * Маскирует email. Сохраняем первую букву локальной части и первую
 * букву домена, плюс TLD — всё остальное звёздочками.
 *   'user@example.com' → 'u***@e***.com'
 *   'a@b.co'          → 'a***@b***.co'
 * При невалидном формате — '***'.
 */
export function maskEmail(email) {
    if (typeof email !== 'string') return '***';
    const at = email.indexOf('@');
    if (at < 1 || at === email.length - 1) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    if (dot < 1 || dot === domain.length - 1) return '***';
    const tld = domain.slice(dot); // '.com'
    return `${local[0]}***@${domain[0]}***${tld}`;
}

/**
 * Маскирует токен (magic-link, email-verify, JWT). Показывает первые
 * и последние 4 символа — этого достаточно для дебага «тот ли токен
 * пришёл», но не достаточно для использования.
 *   'abcdef1234567890' → 'abcd...7890'
 * Если короче 12 символов — отдаём '***' (нечего маскировать осмысленно).
 */
export function maskToken(token) {
    if (typeof token !== 'string' || token.length < 12) return '***';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
