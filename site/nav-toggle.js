/* PaperTrench site — mobile nav toggle.
 *
 * Below 860px the nav hides every page link (style.css) and shows the
 * hamburger button this script breathes life into. One class on the <nav>
 * element is the whole state machine; CSS turns .nav-open into the
 * dropdown. The list itself is the same .nav-links markup every page
 * already ships — the menu cannot drift from the desktop nav because it
 * IS the desktop nav.
 */
(function () {
  'use strict';

  var nav = document.querySelector('nav[aria-label="Primary"]');
  if (!nav) return;
  var burger = nav.querySelector('.nav-burger');
  var links = nav.querySelector('.nav-links');
  if (!burger || !links) return;

  function isOpen() {
    return nav.classList.contains('nav-open');
  }

  function setOpen(open) {
    nav.classList.toggle('nav-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  burger.addEventListener('click', function () {
    setOpen(!isOpen());
  });

  // Choosing a destination closes the menu — the page is navigating anyway,
  // and an in-page anchor (#install) should not leave the sheet covering
  // the page it just scrolled.
  links.addEventListener('click', function (e) {
    var target = e.target;
    while (target && target !== links) {
      if (target.tagName === 'A') {
        setOpen(false);
        return;
      }
      target = target.parentNode;
    }
  });

  // Escape closes and hands focus back to the button, so keyboard users are
  // not stranded where the menu left them.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      burger.focus();
    }
  });

  // A tap anywhere outside the open menu dismisses it.
  document.addEventListener('click', function (e) {
    if (isOpen() && !nav.contains(e.target)) setOpen(false);
  });

  // Crossing back to desktop hides the sheet; its open state must not
  // survive the media query that gave it a reason to exist.
  var mq = window.matchMedia('(min-width: 861px)');
  var onWide = function (m) {
    if (m.matches) setOpen(false);
  };
  if (mq.addEventListener) mq.addEventListener('change', onWide);
  else if (mq.addListener) mq.addListener(onWide);
})();
