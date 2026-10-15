import { useRef, useState } from 'react';

interface Props {
  accept: string;
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

export function Dropzone({ accept, onFiles, compact }: Props) {
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
        <strong>{compact ? 'Добавить ещё файлы' : 'Перетащите файлы сюда'}</strong>
        {!compact && <span> или нажмите, чтобы выбрать</span>}
      </div>
    </div>
  );
}
