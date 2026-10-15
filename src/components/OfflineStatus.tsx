import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { engineThreads } from '../lib/ffmpeg';

/** True when the ffmpeg core for this browser is already in the service-worker cache. */
async function engineCached(): Promise<boolean> {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open('ffmpeg-core');
    return Boolean(await cache.match(`/ffmpeg/${engineThreads()}/ffmpeg-core.wasm`));
  } catch {
    return false;
  }
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

interface Props {
  /** Downloads (and thereby caches) the ffmpeg engine. */
  onDownloadEngine: () => Promise<void>;
  /** Changes whenever the engine finishes loading, to re-check the cache. */
  engineState: string;
  busy: boolean;
}

export function OfflineStatus({ onDownloadEngine, engineState, busy }: Props) {
  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const online = useOnline();
  const [cached, setCached] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const supported = 'serviceWorker' in navigator;
  const [controlled, setControlled] = useState(Boolean(navigator.serviceWorker?.controller));

  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.ready.then(() => setControlled(true));
  }, [supported]);

  useEffect(() => {
    void engineCached().then(setCached);
  }, [engineState, offlineReady, controlled]);

  if (!supported) return null;

  const appReady = offlineReady || controlled;
  let pill;
  if (!online) {
    pill = <span className="pill warn">Нет сети — работаем офлайн</span>;
  } else if (!appReady) {
    pill = <span className="pill muted">Офлайн-режим готовится…</span>;
  } else if (cached) {
    pill = (
      <span className="pill ok" title="Сайт и движок конвертации сохранены на устройстве — работает без интернета">
        ✓ Работает офлайн
      </span>
    );
  } else {
    pill = (
      <button
        className="pill action"
        disabled={downloading || busy}
        title="Документы уже работают офлайн. Для фото и видео нужно один раз скачать движок ffmpeg."
        onClick={async () => {
          setDownloading(true);
          try {
            await onDownloadEngine();
          } finally {
            setDownloading(false);
            setCached(await engineCached());
          }
        }}
      >
        {downloading ? 'Скачиваю движок…' : '⬇ Скачать для офлайна (≈31 МБ)'}
      </button>
    );
  }

  return (
    <>
      {pill}
      {needRefresh && (
        <div className="update-toast" role="status">
          <span>Доступна новая версия сайта</span>
          <button className="btn primary small" disabled={busy} onClick={() => updateServiceWorker(true)}>
            {busy ? 'После конвертации' : 'Обновить'}
          </button>
          <button className="icon-btn" onClick={() => setNeedRefresh(false)} aria-label="Позже">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
