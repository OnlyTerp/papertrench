(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hoverFine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  var still = reduced || saveData;
  var stage = document.querySelector('.lt-stage');
  var films = Array.prototype.slice.call(document.querySelectorAll('.lt-film'));
  var doors = Array.prototype.slice.call(document.querySelectorAll('.lt-door'));
  var lede = document.getElementById('stageLede');
  var openBtn = document.getElementById('stageOpen');
  var openLabel = document.getElementById('stageOpenLabel');
  var idle = {
    film: 'overlay',
    lede: lede ? lede.textContent : '',
    href: openBtn ? openBtn.getAttribute('href') : '',
    open: openLabel ? openLabel.textContent : 'Open Axiom'
  };

  function ensureSrc(node) {
    if (node.getAttribute('src')) return;
    var src = node.getAttribute('data-src');
    if (src) node.setAttribute('src', src);
  }

  function playOnly(key) {
    var i;
    var node;
    for (i = 0; i < films.length; i += 1) {
      node = films[i];
      if (node.getAttribute('data-film') === key) {
        node.classList.add('is-on');
        if (!still) {
          ensureSrc(node);
          var p = node.play();
          if (p && p.catch) p.catch(function () {});
        }
      } else {
        node.classList.remove('is-on');
        node.pause();
      }
    }
  }

  function setOpen(href, label) {
    if (!openBtn) return;
    openBtn.setAttribute('href', href);
    if (openLabel) openLabel.textContent = label;
  }

  function showDoor(door) {
    var i;
    for (i = 0; i < doors.length; i += 1) {
      doors[i].classList.toggle('is-on', doors[i] === door);
    }
    if (!door) {
      playOnly(idle.film);
      if (lede) lede.textContent = idle.lede;
      setOpen(idle.href, idle.open);
      return;
    }
    playOnly(door.getAttribute('data-film') || idle.film);
    if (lede) lede.textContent = door.getAttribute('data-lede') || idle.lede;
    setOpen(door.getAttribute('href'), door.getAttribute('data-open') || idle.open);
  }

  var doorTrack = document.querySelector('.lt-doors');

  function nearestDoor() {
    if (!doorTrack || !doors.length) return doors[0];
    var root = doorTrack.getBoundingClientRect();
    var mid = root.left + root.width * 0.38;
    var best = doors[0];
    var bestDist = Infinity;
    var i;
    for (i = 0; i < doors.length; i += 1) {
      var box = doors[i].getBoundingClientRect();
      var dist = Math.abs(box.left + box.width * 0.5 - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = doors[i];
      }
    }
    return best;
  }

  if (still) {
    films.forEach(function (node) {
      node.pause();
      node.classList.remove('is-on');
    });
  } else {
    doors.forEach(function (door) {
      door.addEventListener('pointerenter', function () { showDoor(door); });
      door.addEventListener('focus', function () { showDoor(door); });
    });
    if (stage && hoverFine) {
      stage.addEventListener('pointerleave', function () { showDoor(null); });
    }
    if (!hoverFine && doorTrack) {
      showDoor(doors[0]);
      var doorTick = 0;
      doorTrack.addEventListener('scroll', function () {
        if (doorTick) return;
        doorTick = window.requestAnimationFrame(function () {
          doorTick = 0;
          showDoor(nearestDoor());
        });
      }, { passive: true });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        films.forEach(function (node) { node.pause(); });
        return;
      }
      var on = document.querySelector('.lt-film.is-on');
      if (on) {
        var p = on.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
    window.setTimeout(function () {
      films.forEach(ensureSrc);
    }, 4000);
  }

  if (!still && window.gsap) {
    var gsap = window.gsap;
    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.lt-film.is-on', { scale: 1.08, duration: 1.7, ease: 'power2.out', clearProps: 'transform' }, 0)
      .from('.lt-hero > *', { y: 28, duration: 0.85, stagger: 0.08, clearProps: 'transform' }, 0.08);
    if (hoverFine) {
      tl.from('.lt-door', { y: 36, duration: 0.7, stagger: 0.06, clearProps: 'transform' }, 0.22);
    }
  }

  var root = document.querySelector('.lt-ca');
  var btn = document.getElementById('copyCa');
  var status = document.getElementById('copyStatus');
  if (!root || !btn) return;
  var CA = root.getAttribute('data-ca') || '';
  var timer = 0;

  function paint(ok) {
    btn.disabled = true;
    btn.classList.toggle('is-copied', ok);
    btn.classList.toggle('is-failed', !ok);
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    if (status) {
      status.textContent = ok
        ? 'Copied to clipboard'
        : 'Copy failed. Select the address above';
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      btn.disabled = false;
      btn.classList.remove('is-copied', 'is-failed');
      btn.textContent = 'Copy';
      if (status) status.textContent = '';
    }, 1800);
  }

  function fallback() {
    if (!CA) { paint(false); return; }
    var ta = document.createElement('textarea');
    ta.value = CA;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    paint(ok);
  }

  btn.addEventListener('click', function () {
    if (btn.disabled) return;
    btn.disabled = true;
    if (!CA) { paint(false); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(CA).then(function () { paint(true); })
        .catch(function () { fallback(); });
      return;
    }
    fallback();
  });
})();
