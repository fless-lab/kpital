/* KPITAL — shared front-end behaviour */
(function () {
  // Mobile navigation drawer
  var toggle = document.querySelector(".nav-toggle");
  var drawer = document.getElementById("navDrawer");
  if (toggle && drawer) {
    function setOpen(open) {
      drawer.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    toggle.addEventListener("click", function () {
      setOpen(!drawer.classList.contains("open"));
    });
    drawer.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 768) setOpen(false);
    });
  }
})();
