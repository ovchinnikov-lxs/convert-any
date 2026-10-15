import type { Category } from './types';
import { documentCategory } from './document';
import { imageCategory } from './image';
import { videoCategory } from './video';

/**
 * Converter categories. To add a new one, describe it like `imageCategory`
 * (formats + option fields + buildArgs) and put it in this list.
 */
export const categories: Category[] = [
  imageCategory,
  videoCategory,
  documentCategory,
];

export type { Category } from './types';
