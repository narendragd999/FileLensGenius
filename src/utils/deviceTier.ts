/**
 * Lightweight hardware-tier detection so low-RAM / low-core Android devices
 * stay responsive without WebView stalls or OOM crashes.
 */
export function isLowEndDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency;
  if (typeof mem === 'number' && mem > 0 && mem <= 4) return true;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return true;
  return false;
}
