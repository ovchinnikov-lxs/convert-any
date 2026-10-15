import type { Category } from './types';
import { documentCategory } from './document';
import { imageCategory } from './image';
import { videoCategory } from './video';

/**
 * Разделы конвертера (вкладки). Чтобы добавить новый, опишите его как `imageCategory`
 * (форматы + поля настроек + buildArgs или convert) и добавьте в этот список.
 */
export const categories: Category[] = [
  imageCategory,
  videoCategory,
  documentCategory,
];

export type { Category } from './types';
