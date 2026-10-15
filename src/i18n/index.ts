import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ru, type Dict } from './ru';

export type Lang = 'ru' | 'en';
export type Key = keyof Dict;

const dicts: Record<Lang, Dict> = { ru, en };
const STORAGE_KEY = 'lang';

/** Языки, для которых по умолчанию показываем русский интерфейс. */
const RUSSIAN_LIKE = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'ka'];

/** Выбор пользователя, иначе — первый подходящий язык из настроек браузера. */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // localStorage может быть недоступен (приватный режим и т.п.)
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const code = l.toLowerCase().split('-')[0];
    if (RUSSIAN_LIKE.includes(code)) return 'ru';
    if (code === 'en') return 'en';
  }
  return 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

function applyToDocument() {
  document.documentElement.lang = current;
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
}
applyToDocument();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // не страшно — просто не запомним выбор
  }
  applyToDocument();
  listeners.forEach((l) => l());
}

/**
 * Перевод по ключу. Параметры подставляются вместо `{name}`.
 * Можно вызывать и вне React (например, в тексте ошибок конвертеров).
 */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = dicts[current][key] ?? ru[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Переводит строку, если это ключ словаря, иначе возвращает как есть (форматы, единицы). */
export function tx(s: string, params?: Record<string, string | number>): string {
  return s in ru ? t(s as Key, params) : s;
}

/** Подписка компонента на смену языка: компонент перерисуется, когда язык поменяется. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Ошибка, текст которой берётся из словаря на текущем языке. */
export class LocalizedError extends Error {
  constructor(key: Key, params?: Record<string, string | number>) {
    super(t(key, params));
  }
}
