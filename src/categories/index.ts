import type { Category } from './types';
import { documentCategory } from './document';
import { imageCategory } from './image';
import { videoCategory } from './video';

const soon = (id: string, title: string, icon: string, description: string): Category => ({
  id,
  title,
  icon,
  description,
  status: 'soon',
  accept: '',
  formats: [],
  defaultFormat: '',
  defaultOptions: {},
  fields: [],
});

/**
 * Converter categories. To add a new one, describe it like `imageCategory`
 * (formats + option fields + buildArgs) and put it in this list.
 */
export const categories: Category[] = [
  imageCategory,
  videoCategory,
  soon('audio', 'Аудио', '🎵', 'MP3, WAV, OGG, FLAC, M4A'),
  documentCategory,
  soon('archives', 'Архивы', '🗜️', 'ZIP, 7Z, TAR'),
];

export type { Category } from './types';
