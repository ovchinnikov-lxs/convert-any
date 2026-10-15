import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { t, useLang } from '../i18n';
import { engineThreads } from '../lib/ffmpeg';

/** Лежит ли ядро ffmpeg для этого браузера в кэше service worker. */
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
  /** Скачивает движок ffmpeg (и тем самым кладёт его в кэш). */
  onDownloadEngine: () => Promise<void>;
  /** Меняется, когда движок загрузился, — повод перепроверить кэш. */
  engineState: string;
  busy: boolean;
}

/** Плашка офлайн-режима в шапке и уведомление о новой версии сайта. */
export function OfflineStatus({ onDownloadEngine, engineState, busy }: Props) {
  useLang();
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
    pill = <span className="pill warn">{t('offline.noNet')}</span>;
  } else if (!appReady) {
    pill = <span className="pill muted">{t('offline.preparing')}</span>;
  } else if (cached) {
    pill = (
      <span className="pill ok" title={t('offline.readyTitle')}>
        {t('offline.ready')}
      </span>
    );
  } else {
    pill = (
      <button
        className="pill action"
        disabled={downloading || busy}
        title={t('offline.downloadTitle')}
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
        {downloading ? t('offline.downloading') : t('offline.download')}
      </button>
    );
  }

  return (
    <>
      {pill}
      {needRefresh && (
        <div className="update-toast" role="status">
          <span>{t('offline.update')}</span>
          <button className="btn primary small" disabled={busy} onClick={() => updateServiceWorker(true)}>
            {busy ? t('offline.afterConvert') : t('offline.updateNow')}
          </button>
          <button className="icon-btn" onClick={() => setNeedRefresh(false)} aria-label={t('offline.later')}>
            ✕
          </button>
        </div>
      )}
    </>
  );
}
