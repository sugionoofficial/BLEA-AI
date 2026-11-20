import { useEffect, useState } from 'react';

export function getElapsedMs(createdAt, nowMs = Date.now()) {
  if (!createdAt) return 0;
  const startedMs = typeof createdAt === 'number' ? createdAt : Date.parse(String(createdAt));
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - startedMs);
}

export function formatElapsedRuntime(createdAt, nowMs = Date.now()) {
  const totalSeconds = Math.floor(getElapsedMs(createdAt, nowMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatElapsedHuman(createdAt, nowMs = Date.now()) {
  const totalSeconds = Math.floor(getElapsedMs(createdAt, nowMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} jam ${String(minutes).padStart(2, '0')} mnt`;
  if (minutes > 0) return `${minutes} mnt ${String(seconds).padStart(2, '0')} dtk`;
  return `${seconds} dtk`;
}

export function useNowTick(enabled = true, intervalMs = 1000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return nowMs;
}
