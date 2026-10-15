import type { Category, Options, OptionValue } from '../categories/types';
import { t, tx, useLang } from '../i18n';

interface Props {
  category: Category;
  format: string;
  options: Options;
  /** Расширения добавленных файлов — от них зависит, какие настройки показывать. */
  inputs: Set<string>;
  onChange: (key: string, value: OptionValue) => void;
}

/** Рисует настройки категории по их описанию (`fields`). */
export function OptionsPanel({ category, format, options, inputs, onChange }: Props) {
  useLang();
  const fields = category.fields.filter((f) => !f.visible || f.visible(options, format, inputs));
  if (!fields.length) return null;
  return (
    <div className="options">
      {fields.map((f) => {
        const value = options[f.key];
        const id = `opt-${category.id}-${f.key}`;
        const unit = 'unit' in f && f.unit ? tx(f.unit) : '';
        const hint = f.hint && <small>{t(f.hint)}</small>;
        switch (f.type) {
          case 'slider':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>
                  {t(f.label)}
                  <span className="field-value">
                    {String(value)}
                    {unit}
                  </span>
                </label>
                <input
                  id={id}
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={f.step ?? 1}
                  value={Number(value)}
                  onChange={(e) => onChange(f.key, Number(e.target.value))}
                />
                {hint}
              </div>
            );
          case 'number':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{t(f.label)}</label>
                <div className="input-unit">
                  <input
                    id={id}
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step ?? 1}
                    placeholder={f.placeholder && t(f.placeholder)}
                    value={Number(value) || ''}
                    onChange={(e) => onChange(f.key, e.target.value === '' ? 0 : Number(e.target.value))}
                  />
                  {unit && <span>{unit}</span>}
                </div>
                {hint}
              </div>
            );
          case 'select':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{t(f.label)}</label>
                <select id={id} value={String(value)} onChange={(e) => onChange(f.key, e.target.value)}>
                  {f.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {tx(c.label, c.params)}
                    </option>
                  ))}
                </select>
                {hint}
              </div>
            );
          case 'checkbox':
            return (
              <label className="field checkbox" key={f.key}>
                <input
                  id={id}
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onChange(f.key, e.target.checked)}
                />
                <span>{t(f.label)}</span>
              </label>
            );
          case 'text':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{t(f.label)}</label>
                <input
                  id={id}
                  type="text"
                  placeholder={f.placeholder && tx(f.placeholder)}
                  value={String(value ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
                {hint}
              </div>
            );
        }
      })}
    </div>
  );
}
