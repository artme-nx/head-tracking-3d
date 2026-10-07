// Gdje se na fizičkom ekranu nalazi canvas (u cm, ishodište = centar ekrana).
// U fullscreenu je to cijeli ekran; u prozoru se procjenjuje iz položaja prozora,
// pa je "prozor u svijet" točno onaj dio ekrana koji prozor zauzima.

export function getCanvasRect(settings) {
  const W = settings.screenWidth;
  const H = settings.screenHeight;
  const full = { x0: -W / 2, x1: W / 2, y0: -H / 2, y1: H / 2 };

  const isFullscreen = !!document.fullscreenElement;
  const sw = window.screen.width;
  const sh = window.screen.height;
  if (!isFullscreen && settings.compensateWindow && sw > 0 && sh > 0) {
    const kx = W / sw;
    const ky = H / sh;
    const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - border);
    const screenLeft = window.screen.availLeft ?? 0;
    const screenTop = screenLeft !== 0 ? (window.screen.availTop ?? 0) : 0;
    const leftPx = window.screenX - screenLeft + border;
    const topPx = window.screenY - screenTop + chromeTop;
    full.x0 = -W / 2 + leftPx * kx;
    full.x1 = full.x0 + window.innerWidth * kx;
    full.y1 = H / 2 - topPx * ky;
    full.y0 = full.y1 - window.innerHeight * ky;
  }

  return {
    ...full,
    width: full.x1 - full.x0,
    height: full.y1 - full.y0,
    cx: (full.x0 + full.x1) / 2,
    cy: (full.y0 + full.y1) / 2,
  };
}

export function rectKey(r) {
  return `${r.x0.toFixed(2)}|${r.x1.toFixed(2)}|${r.y0.toFixed(2)}|${r.y1.toFixed(2)}`;
}
