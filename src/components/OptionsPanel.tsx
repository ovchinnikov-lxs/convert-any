import type { Category, Options, OptionValue } from '../categories/types';

interface Props {
  category: Category;
  format: string;
  options: Options;
  onChange: (key: string, value: OptionValue) => void;
}

export function OptionsPanel({ category, format, options, onChange }: Props) {
  const fields = category.fields.filter((f) => !f.visible || f.visible(options, format));
  if (!fields.length) return null;
  return (
    <div className="options">
      {fields.map((f) => {
        const value = options[f.key];
        const id = `opt-${category.id}-${f.key}`;
        switch (f.type) {
          case 'slider':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>
                  {f.label}
                  <span className="field-value">
                    {String(value)}
                    {f.unit}
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
                {f.hint && <small>{f.hint}</small>}
              </div>
            );
          case 'number':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{f.label}</label>
                <div className="input-unit">
                  <input
                    id={id}
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step ?? 1}
                    placeholder={f.placeholder}
                    value={Number(value) || ''}
                    onChange={(e) => onChange(f.key, e.target.value === '' ? 0 : Number(e.target.value))}
                  />
                  {f.unit && <span>{f.unit}</span>}
                </div>
                {f.hint && <small>{f.hint}</small>}
              </div>
            );
          case 'select':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{f.label}</label>
                <select id={id} value={String(value)} onChange={(e) => onChange(f.key, e.target.value)}>
                  {f.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {f.hint && <small>{f.hint}</small>}
              </div>
            );
          case 'checkbox':
            return (
              <label className="field checkbox" key={f.key}>
                <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(f.key, e.target.checked)} />
                <span>{f.label}</span>
              </label>
            );
          case 'text':
            return (
              <div className="field" key={f.key}>
                <label htmlFor={id}>{f.label}</label>
                <input
                  id={id}
                  type="text"
                  placeholder={f.placeholder}
                  value={String(value ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
                {f.hint && <small>{f.hint}</small>}
              </div>
            );
        }
      })}
    </div>
  );
}
