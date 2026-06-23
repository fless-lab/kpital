/* Kpital — mobile navigation drawer.
   Injects a hamburger toggle + slide-down drawer built from the page's
   existing nav. Works on the standard nav (.nav-links / .nav-right) and the
   dashboard nav (.dash-nav-links / .dash-nav-right). No-ops if no nav exists
   (e.g. login / signup pages). CSS lives in kpital.css under the 768px query. */
(function () {
  function init() {
    var nav = document.querySelector('nav');
    if (!nav) return;

    var inner = nav.querySelector('.nav-inner, .dash-nav-inner') || nav.firstElementChild;
    if (!inner) return;
    if (inner.querySelector('.nav-toggle')) return; // already initialised

    var linksWrap = nav.querySelector('.nav-links, .dash-nav-links');
    var rightWrap = nav.querySelector('.nav-right, .dash-nav-right');

    // Build the drawer from current nav content.
    var drawer = document.createElement('div');
    drawer.className = 'nav-drawer';

    if (linksWrap) {
      linksWrap.querySelectorAll('a').forEach(function (a) {
        var link = document.createElement('a');
        link.href = a.getAttribute('href') || '#';
        link.className = 'drawer-link' + (a.classList.contains('active') ? ' active' : '');
        link.textContent = a.textContent.trim();
        drawer.appendChild(link);
      });
    }

    if (rightWrap) {
      var actions = document.createElement('div');
      actions.className = 'drawer-actions';
      rightWrap.querySelectorAll('a, button').forEach(function (el) {
        actions.appendChild(el.cloneNode(true));
      });
      if (actions.children.length) drawer.appendChild(actions);
    }

    // Nothing to show → skip.
    if (!drawer.children.length) return;

    // Hamburger button.
    var toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-label', 'Menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

    inner.appendChild(toggle);
    nav.appendChild(drawer);

    function setOpen(open) {
      drawer.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.innerHTML = open
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    }

    toggle.addEventListener('click', function () {
      setOpen(!drawer.classList.contains('open'));
    });
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    // Reset when resizing back to desktop.
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
