(() => {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hoverFine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if (reduced || saveData || !hoverFine) return;
  const videos = Array.from(document.querySelectorAll('video[data-src]'));
  if (!videos.length || !('IntersectionObserver' in window)) return;
  const onScreen = new Set();
  const playIfOn = (v) => {
    if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
    const p = v.play(); if (p && p.catch) p.catch(() => {});
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const v = entry.target;
      if (entry.isIntersecting) {
        onScreen.add(v);
        if (!document.hidden) playIfOn(v);
      } else {
        onScreen.delete(v);
        v.pause();
      }
    });
  }, { threshold: 0.15 });
  videos.forEach((v) => io.observe(v));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      videos.forEach((v) => v.pause());
      return;
    }
    onScreen.forEach(playIfOn);
  });
})();
