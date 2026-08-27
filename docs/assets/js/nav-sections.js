/*
 * Sidebar section navigation.
 *
 * `_includes/components/nav/page_headings.html` lists the current page's own
 * headings underneath its entry in the sidebar. This adds the two behaviours
 * the static markup cannot have:
 *
 *   1. the link for the section you are reading is marked `active`, the same
 *      way the theme marks the link for the page you are on;
 *   2. the subsections of that section are expanded, so the `###` level stays
 *      collapsed on a long page until it is the part you are actually in.
 *
 * The theme's own expander handler (assets/js/just-the-docs.js) does the
 * clicking; this only reads and sets the same `active` class it uses. An
 * expander the reader has operated themselves is left alone from then on.
 *
 * Everything here is optional polish: with JS off, the sections are still
 * listed and still link to their anchors.
 */
(function () {
  "use strict";

  var TOP_OFFSET = 24; // a heading counts as "current" once it reaches here

  var nav = document.getElementById("site-nav");
  if (!nav) return;

  var list = nav.querySelector(".nav-section-list");
  if (!list) return;

  var entries = [];
  var links = list.querySelectorAll('a.nav-list-link[href^="#"]');

  for (var i = 0; i < links.length; i += 1) {
    var link = links[i];
    var id;
    try {
      id = decodeURIComponent(link.getAttribute("href").slice(1));
    } catch (e) {
      id = link.getAttribute("href").slice(1);
    }
    var heading = id ? document.getElementById(id) : null;
    if (!heading) continue;

    // The group is the top-level item of the section list that contains this
    // link — itself for a section, its parent section for a subsection.
    var group = link.closest(".nav-list-item");
    while (group && group.parentNode !== list) {
      group = group.parentNode.closest(".nav-list-item");
    }

    entries.push({ link: link, heading: heading, group: group });
  }

  if (!entries.length) return;

  // Remember which expanders the reader worked themselves, and stop managing
  // those. Registered on the list, so it never sees clicks elsewhere in the nav.
  list.addEventListener("click", function (event) {
    var expander = event.target.closest(".nav-list-expander");
    if (!expander || !list.contains(expander)) return;
    var item = expander.parentNode;
    if (item && item.classList.contains("nav-list-item")) {
      item.setAttribute("data-nav-user-toggled", "true");
    }
  });

  var activeEntry = null;
  var openedGroup = null;

  function setExpanded(group, expanded) {
    if (!group || group.hasAttribute("data-nav-user-toggled")) return;
    group.classList.toggle("active", expanded);
    var expander = group.querySelector(":scope > .nav-list-expander");
    if (expander) expander.setAttribute("aria-expanded", String(expanded));
  }

  function apply(entry) {
    if (entry === activeEntry) return;

    if (activeEntry) activeEntry.link.classList.remove("active");
    entry.link.classList.add("active");
    activeEntry = entry;

    if (openedGroup !== entry.group) {
      setExpanded(openedGroup, false);
      openedGroup = null;
    }
    // A section with no subsections has no expander; expanding it is a no-op.
    if (entry.group && entry.group.querySelector(".nav-list")) {
      setExpanded(entry.group, true);
      openedGroup = entry.group;
    }
  }

  function current() {
    // The last heading that has scrolled past the offset wins; at the very
    // bottom of the page the last heading wins outright, so the final section
    // is reachable even when it is shorter than the viewport.
    var atBottom =
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2;
    if (atBottom) return entries[entries.length - 1];

    var found = entries[0];
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].heading.getBoundingClientRect().top <= TOP_OFFSET) {
        found = entries[i];
      } else {
        break;
      }
    }
    return found;
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () {
      queued = false;
      apply(current());
    });
  }

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("hashchange", schedule);
  schedule();
})();
