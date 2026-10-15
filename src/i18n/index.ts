import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ru, type Dict } from './ru';

export type Lang = 'ru' | 'en';
export type Key = keyof Dict;

const dicts: Record<Lang, Dict> = { ru, en };
const STORAGE_KEY = 'lang';

/** Languages that get the Russian UI by default. */
const RUSSIAN_LIKE = ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'ka'];

/** The user's choice, otherwise the first matching language from the browser settings. */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // localStorage may be unavailable (private mode etc.)
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
    // not critical — the choice just won't be remembered
  }
  applyToDocument();
  listeners.forEach((l) => l());
}

/**
 * Translates a key. Params replace `{name}` placeholders.
 * Works outside React too (e.g. for converter error messages).
 */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = dicts[current][key] ?? ru[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translates the string if it's a dictionary key, otherwise returns it as is (formats, units). */
export function tx(s: string, params?: Record<string, string | number>): string {
  return s in ru ? t(s as Key, params) : s;
}

/** Subscribes a component to language changes, so it re-renders on switch. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** An error whose message comes from the dictionary in the current language. */
export class LocalizedError extends Error {
  constructor(key: Key, params?: Record<string, string | number>) {
    super(t(key, params));
  }
}
