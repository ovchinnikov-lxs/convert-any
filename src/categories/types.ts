import type { Key } from '../i18n';
import type { MediaInfo } from '../lib/ffmpeg';

export type OptionValue = string | number | boolean;
export type Options = Record<string, OptionValue>;

export interface FormatDef {
  id: string;
  /** Название формата (PNG, Markdown…) — одинаковое на всех языках. */
  label: string;
  ext: string;
  mime: string;
  hint?: Key;
  /** Из каких расширений (строчными, без точки) можно получить этот формат. Не задано — из любых. */
  from?: string[];
}

interface FieldBase {
  /** Имя опции в `Options`. */
  key: string;
  label: Key;
  hint?: Key;
  /** Показывать поле, только если функция вернула true. `inputs` — расширения добавленных файлов. */
  visible?: (options: Options, format: string, inputs: Set<string>) => boolean;
}

/** Вариант выбора: подпись — ключ словаря или текст как есть (например «720p»), с параметрами. */
export interface Choice {
  value: string;
  label: Key | string;
  params?: Record<string, string | number>;
}

/** `unit` — ключ словаря или символ как есть (%, px). */
export type FieldDef =
  | (FieldBase & { type: 'slider'; min: number; max: number; step?: number; unit?: string })
  | (FieldBase & { type: 'number'; min?: number; max?: number; step?: number; placeholder?: Key; unit?: string })
  | (FieldBase & { type: 'select'; choices: Choice[] })
  | (FieldBase & { type: 'checkbox' })
  | (FieldBase & { type: 'text'; placeholder?: Key | string });

/** Всё, что нужно, чтобы собрать аргументы ffmpeg. */
export interface BuildContext {
  /** Путь к входному файлу внутри файловой системы ffmpeg. */
  input: string;
  file: File;
  format: FormatDef;
  options: Options;
  /** Длительность в секундах, если известна. */
  duration?: number;
  /** Сведения об исходнике (кодеки, битрейты), если известны. */
  media?: MediaInfo;
}

/** Всё, что нужно собственному (не ffmpeg) конвертеру. */
export interface ConvertContext {
  file: File;
  format: FormatDef;
  options: Options;
  onProgress: (ratio: number) => void;
}

export interface ConvertOutput {
  blob: Blob;
  /** Имя файла с расширением. */
  name: string;
}

/** Раздел конвертера (вкладка): форматы, настройки и способ конвертации. */
export interface Category {
  id: string;
  title: Key;
  icon: string;
  description: Key;
  status: 'ready' | 'soon';
  /** Атрибут `accept` для выбора файлов. */
  accept: string;
  formats: FormatDef[];
  defaultFormat: string;
  defaultOptions: Options;
  fields: FieldDef[];
  /** Аргументы ffmpeg (вместе с `-i`) без выходного пути. */
  buildArgs?: (ctx: BuildContext) => string[];
  /** Собственный (не ffmpeg) конвертер. Если задан, используется вместо `buildArgs`. */
  convert?: (ctx: ConvertContext) => Promise<ConvertOutput>;
  /** Склеивает несколько результатов в один файл (например, PDF), если `canMerge` разрешает. */
  merge?: (outputs: ConvertOutput[], options: Options) => Promise<ConvertOutput>;
  canMerge?: (format: string, options: Options) => boolean;
  /** Значения настроек, которые подставляются при выборе формата. */
  formatDefaults?: Record<string, Options>;
  /** Нужно ли перед конвертацией анализировать файл (длительность, битрейт). */
  needsDuration?: boolean;
}
