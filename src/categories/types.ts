import type { Key } from '../i18n';
import type { MediaInfo } from '../lib/ffmpeg';

export type OptionValue = string | number | boolean;
export type Options = Record<string, OptionValue>;

export interface FormatDef {
  id: string;
  /** Format name (PNG, Markdown…) — the same in every language. */
  label: string;
  ext: string;
  mime: string;
  hint?: Key;
  /** Input extensions (lowercase, no dot) this format can be produced from. Omitted = any. */
  from?: string[];
}

interface FieldBase {
  /** Option name in `Options`. */
  key: string;
  label: Key;
  hint?: Key;
  /** Show the field only when this returns true. `inputs` = extensions of the added files. */
  visible?: (options: Options, format: string, inputs: Set<string>) => boolean;
}

/** Select choice: label is a dictionary key or literal text (e.g. "720p"), with optional params. */
export interface Choice {
  value: string;
  label: Key | string;
  params?: Record<string, string | number>;
}

/** `unit` is a dictionary key or a literal symbol (%, px). */
export type FieldDef =
  | (FieldBase & { type: 'slider'; min: number; max: number; step?: number; unit?: string })
  | (FieldBase & { type: 'number'; min?: number; max?: number; step?: number; placeholder?: Key; unit?: string })
  | (FieldBase & { type: 'select'; choices: Choice[] })
  | (FieldBase & { type: 'checkbox' })
  | (FieldBase & { type: 'text'; placeholder?: Key | string });

/** Everything needed to build ffmpeg arguments. */
export interface BuildContext {
  /** Input path inside ffmpeg's file system. */
  input: string;
  file: File;
  format: FormatDef;
  options: Options;
  /** Media duration in seconds, when known. */
  duration?: number;
  /** Probed source info (codecs, bitrates), when known. */
  media?: MediaInfo;
  /** Crop rectangle in source pixels (images), applied before any resizing. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Input options placed before `-i` (e.g. `-f apng`, `-f concat` for a frame sequence). */
  inputArgs?: string[];
  /** The source is an animation (animated WebP / APNG / GIF). */
  animated?: boolean;
  /** Duration of the source's last frame, ms (animations). */
  lastFrameMs?: number;
  /** Total duration of one loop of the source animation, ms. */
  animDuration?: number;
}

/** What `Category.postProcess` gets after ffmpeg has finished. */
export interface PostProcessContext {
  data: Uint8Array;
  /** ffmpeg log lines of the conversion. */
  logs: string[];
  format: FormatDef;
  options: Options;
  animated: boolean;
  lastFrameMs?: number;
  animDuration?: number;
}

/** Everything a custom (non-ffmpeg) converter needs. */
export interface ConvertContext {
  file: File;
  format: FormatDef;
  options: Options;
  onProgress: (ratio: number) => void;
}

export interface ConvertOutput {
  blob: Blob;
  /** File name including extension. */
  name: string;
}

/** Converter category (tab): formats, settings and how to convert. */
export interface Category {
  id: string;
  title: Key;
  icon: string;
  description: Key;
  /** Highlighted line under the description (e.g. a feature people look for). */
  note?: Key;
  status: 'ready' | 'soon';
  /** `accept` attribute for the file picker. */
  accept: string;
  formats: FormatDef[];
  defaultFormat: string;
  defaultOptions: Options;
  fields: FieldDef[];
  /** ffmpeg arguments (including `-i`), without the output path. */
  buildArgs?: (ctx: BuildContext) => string[];
  /** Optional step after ffmpeg (e.g. assembling or fixing up an animation). */
  postProcess?: (ctx: PostProcessContext) => Promise<Uint8Array>;
  /** Custom (non-ffmpeg) converter. Used instead of `buildArgs` when present. */
  convert?: (ctx: ConvertContext) => Promise<ConvertOutput>;
  /** Combines several results into one file (e.g. merge PDFs), when `canMerge` says so. */
  merge?: (outputs: ConvertOutput[], options: Options) => Promise<ConvertOutput>;
  canMerge?: (format: string, options: Options) => boolean;
  /** Option overrides applied when the format is picked. */
  formatDefaults?: Record<string, Options>;
  /** Whether to probe the input first (duration, bitrate). */
  needsDuration?: boolean;
}
