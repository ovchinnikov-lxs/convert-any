export type OptionValue = string | number | boolean;
export type Options = Record<string, OptionValue>;

export interface FormatDef {
  id: string;
  label: string;
  ext: string;
  mime: string;
  hint?: string;
  /** Input extensions (lowercase, no dot) this format can be produced from. Omitted = any. */
  from?: string[];
}

interface FieldBase {
  key: string;
  label: string;
  hint?: string;
  /** Show the field only when this returns true. `inputs` = extensions of the added files. */
  visible?: (options: Options, format: string, inputs: Set<string>) => boolean;
}

export type FieldDef =
  | (FieldBase & { type: 'slider'; min: number; max: number; step?: number; unit?: string })
  | (FieldBase & { type: 'number'; min?: number; max?: number; step?: number; placeholder?: string; unit?: string })
  | (FieldBase & { type: 'select'; choices: { value: string; label: string }[] })
  | (FieldBase & { type: 'checkbox' })
  | (FieldBase & { type: 'text'; placeholder?: string });

export interface BuildContext {
  input: string;
  file: File;
  format: FormatDef;
  options: Options;
  /** Media duration in seconds, when known. */
  duration?: number;
}

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

export interface Category {
  id: string;
  title: string;
  icon: string;
  description: string;
  status: 'ready' | 'soon';
  /** `accept` attribute for the file picker. */
  accept: string;
  formats: FormatDef[];
  defaultFormat: string;
  defaultOptions: Options;
  fields: FieldDef[];
  /** ffmpeg arguments between `-i` handling and the output path. */
  buildArgs?: (ctx: BuildContext) => string[];
  /** Custom (non-ffmpeg) converter. Used instead of `buildArgs` when present. */
  convert?: (ctx: ConvertContext) => Promise<ConvertOutput>;
  /** Combines several results into one file (e.g. merge PDFs), when `canMerge` says so. */
  merge?: (outputs: ConvertOutput[], options: Options) => Promise<ConvertOutput>;
  canMerge?: (format: string, options: Options) => boolean;
  /** Optional per-format option overrides applied when the format is picked. */
  formatDefaults?: Record<string, Options>;
  /** Whether the category needs the media duration (e.g. for target-size mode). */
  needsDuration?: boolean;
}
