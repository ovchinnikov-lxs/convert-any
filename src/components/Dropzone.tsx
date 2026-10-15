import { useRef, useState } from 'react';
import { t, useLang } from '../i18n';

interface Props {
  accept: string;
  onFiles: (files: File[]) => void;
  /** Compact look once files have been added. */
  compact?: boolean;
}

/** Drop zone for files; opens the file picker on click. */
export function Dropzone({ accept, onFiles, compact }: Props) {
  useLang();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
      <div className="dropzone-icon">⬆</div>
      <div>
        <strong>{compact ? t('drop.more') : t('drop.title')}</strong>
        {!compact && <span>{t('drop.or')}</span>}
      </div>
    </div>
  );
}
