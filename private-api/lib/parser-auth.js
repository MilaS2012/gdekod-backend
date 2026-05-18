// =============================================================================
// parser-auth.js — backend-to-backend защита парсер-эндпоинтов.
//
// Парсер (Azure) шлёт shared secret в заголовке X-Parser-Secret. JWT здесь
// не используется. Сравнение через timingSafeEqual защищает от timing-атак,
// которыми можно было бы по байтам угадывать секрет (даже не зная его
// полностью).
//
// PARSER_SECRET читается из process.env при КАЖДОМ вызове requireParserSecret —
// это нужно для тестируемости и для serverless (env могут перечитаться при
// пересоздании контейнера).
// =============================================================================

import { timingSafeEqual } from 'node:crypto';

export class ParserAuthError extends Error {
    /**
     * @param {'no_env_secret'|'no_header'|'invalid_secret'} reason
     */
    constructor(reason) {
        super('parser_auth_failed');
        this.name = 'ParserAuthError';
        this.reason = reason;
    }
}

/**
 * Проверяет, что в event пришёл корректный X-Parser-Secret.
 * Бросает ParserAuthError при любой проблеме.
 *
 * Возвращает true при успехе.
 */
export function requireParserSecret(event) {
    const expected = process.env.PARSER_SECRET || '';
    if (!expected) {
        // Защита от случайного запуска в env без секрета — иначе любой
        // запрос с пустым заголовком прошёл бы (`'' === ''`).
        throw new ParserAuthError('no_env_secret');
    }

    const headers = event?.headers ?? {};
    const header  = headers['x-parser-secret'] ?? headers['X-Parser-Secret'];
    if (typeof header !== 'string' || header.length === 0) {
        throw new ParserAuthError('no_header');
    }

    const a = Buffer.from(header,   'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
        // timingSafeEqual требует одинаковую длину буферов. Сравнение
        // длин в коде — не утечка, она равна длине ожидаемого секрета
        // (атакующий и так может выяснить длину через `Content-Length`).
        throw new ParserAuthError('invalid_secret');
    }
    if (!timingSafeEqual(a, b)) {
        throw new ParserAuthError('invalid_secret');
    }
    return true;
}
