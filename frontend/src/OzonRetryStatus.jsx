import React, {useEffect, useState} from 'react';
import {formatOzonRetryDuration, ozonRetryRemainingSeconds} from './ozon-retry-status.mjs';
import './ozonRetryStatus.css';

/** Gentle, live feedback for an active background job paused by Ozon limits. */
export default function OzonRetryStatus({retryAt, compact=false}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const updateWhenVisible = () => { if (!document.hidden) setNow(Date.now()); };
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', updateWhenVisible);
    };
  }, [retryAt]);
  const left = ozonRetryRemainingSeconds(retryAt, now);
  return <span className={'ozon-retry-status'+(compact?' compact':'')}>
    <span className="ozon-retry-heading">Ozon временно ограничил частоту запросов</span>
    <span className="ozon-retry-subtitle">
      {left > 0
        ? <>Загрузка продолжится автоматически через <strong className="ozon-retry-clock" aria-live="off">{formatOzonRetryDuration(left)}</strong>.</>
        : 'Возобновляем загрузку автоматически…'}
    </span>
    {!compact&&<span className="ozon-retry-note">Ничего нажимать не нужно. Можно закрыть страницу — загрузка продолжится на сервере.</span>}
  </span>;
}
