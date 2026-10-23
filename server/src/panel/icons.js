/* ============================================================================
   图标 —— 与 src/components/Icons.tsx 同一套几何（24×24 视图盒、1.7 描边、
   圆头圆角）。管理页需要的几个（activity / users / devices / alert / scroll /
   book / refresh / external / filter / download / ban / check / x / search /
   sliders / key / globe / clock / layers / settings / menu）按同一规则画。
   ========================================================================= */

(function () {
  "use strict";

  var PATHS = {
    activity: '<path d="M3.5 12h3.2l2.4-6.4 3.6 12.8 2.6-6.4h5.2"/>',
    users:
      '<path d="M9.2 11.4a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M2.9 20.2c0-3.4 2.8-5.8 6.3-5.8s6.3 2.4 6.3 5.8"/><path d="M16.4 5.1a3.1 3.1 0 0 1 0 5.9"/><path d="M17.6 14.9c2.2.6 3.6 2.4 3.6 4.6"/>',
    devices:
      '<rect x="2.8" y="4.6" width="13.2" height="9.4" rx="1.6"/><path d="M6.6 18h5.6"/><path d="M9.4 14v4"/><rect x="17.2" y="10.2" width="4" height="9.2" rx="1.2"/>',
    alert:
      '<path d="M12 3.8 21 19.4H3z"/><path d="M12 9.4v4.4"/><path d="M12 16.7v.1"/>',
    scroll:
      '<path d="M6.4 3.5h11.2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M8.2 8.2h7.6"/><path d="M8.2 12h7.6"/><path d="M8.2 15.8h4.8"/>',
    book:
      '<path d="M4 5.2A2.2 2.2 0 0 1 6.2 3H20v15.4H6.2A2.2 2.2 0 0 0 4 20.6z"/><path d="M4 20.6V5.2"/><path d="M8.4 7.6h7.2"/>',
    refresh:
      '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.8v4.4h-4.4"/>',
    external:
      '<path d="M13.2 4.4H19a.6.6 0 0 1 .6.6v5.8"/><path d="m19.2 4.8-7.6 7.6"/><path d="M17.4 14.2v4.4a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6V8.2a1.6 1.6 0 0 1 1.6-1.6h4.4"/>',
    filter: '<path d="M3.6 5.4h16.8l-6.6 7.7v6.1l-3.6-1.9v-4.2z"/>',
    download: '<path d="M12 3.8v11.4"/><path d="m7.4 10.8 4.6 4.6 4.6-4.6"/><path d="M4.4 19.4h15.2"/>',
    ban: '<circle cx="12" cy="12" r="8.4"/><path d="m6.1 6.1 11.8 11.8"/>',
    check: '<path d="m4.8 12.6 4.6 4.6 9.8-10.4"/>',
    x: '<path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="m19.5 19.5-4-4"/>',
    sliders:
      '<path d="M4.2 7.4h6.2"/><path d="M14.6 7.4h5.2"/><path d="M4.2 16.6h4.2"/><path d="M12.6 16.6h7.2"/><circle cx="12.4" cy="7.4" r="2.1"/><circle cx="10.4" cy="16.6" r="2.1"/>',
    key:
      '<circle cx="8.2" cy="8.2" r="4.4"/><path d="m11.4 11.4 8.2 8.2"/><path d="m15.4 15.4-2 2"/><path d="m17.8 17.8-1.8 1.8"/>',
    globe:
      '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6a13 13 0 0 1 0 16.8 13 13 0 0 1 0-16.8Z"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 2"/>',
    layers:
      '<path d="m12 3.6 8.4 4.4-8.4 4.4-8.4-4.4z"/><path d="m3.6 12.4 8.4 4.4 8.4-4.4"/><path d="m3.6 16.6 8.4 4.4 8.4-4.4"/>',
    settings:
      '<circle cx="12" cy="12" r="2.9"/><path d="M12 3.2v2.1"/><path d="M12 18.7v2.1"/><path d="M4.8 7.8 6.6 8.9"/><path d="m17.4 15.1 1.8 1.1"/><path d="M4.8 16.2 6.6 15.1"/><path d="m17.4 8.9 1.8-1.1"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    chevronRight: '<path d="m9.5 6 5.5 6-5.5 6"/>',
    chevronDown: '<path d="m6 9.5 6 5.5 6-5.5"/>',
    chevronLeft: '<path d="m14.5 6-5.5 6 5.5 6"/>',
    copy:
      '<rect x="8.6" y="8.6" width="11" height="11" rx="1.8"/><path d="M15.4 5.4H5.6a1.6 1.6 0 0 0-1.6 1.6v9.8"/>',
    info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.2"/><path d="M12 7.9v.1"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.2"/><path d="M12 19v2.2"/><path d="M2.8 12h2.2"/><path d="M19 12h2.2"/><path d="m5.5 5.5 1.6 1.6"/><path d="m16.9 16.9 1.6 1.6"/><path d="m18.5 5.5-1.6 1.6"/><path d="m7.1 16.9-1.6 1.6"/>',
    moon: '<path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8Z"/>',
    shield:
      '<path d="M12 3.4 19.4 6v5.5c0 4.4-3 7.6-7.4 9.1-4.4-1.5-7.4-4.7-7.4-9.1V6z"/><path d="m9.2 11.9 2 2 3.6-3.9"/>',
    trash:
      '<path d="M4.5 7h15M9.5 7V5.4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/><path d="m6.5 7 .8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>',
    rotate:
      '<path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M17.7 2.9v3.5h-3.5"/><path d="M6.3 21.1v-3.5h3.5"/>',
    dot: '<circle cx="12" cy="12" r="4.2"/>'
  };

  function icon(name, size, extraClass) {
    var body = PATHS[name] || PATHS.info;
    var cls = extraClass ? ' class="' + extraClass + '"' : "";
    return (
      '<svg width="' + (size || 15) + '" height="' + (size || 15) + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false"' + cls + ">" + body + "</svg>"
    );
  }

  window.ICON = icon;
  window.ICON_NAMES = Object.keys(PATHS);
})();
