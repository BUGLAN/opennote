const P = window.PROBE;
const { view: v, host } = P.newProbeView(700, P.doc);
await P.showHost(host);
await P.settle(6, 400);
const snap = (tag) => ({
  tag,
  windowScrollY: Math.round(window.scrollY),
  hostRect: { top: Math.round(host.getBoundingClientRect().top), bottom: Math.round(host.getBoundingClientRect().bottom), height: Math.round(host.getBoundingClientRect().height) },
  scrollerTop: Math.round(v.scrollDOM.getBoundingClientRect().top),
  scrollerClientHeight: v.scrollDOM.clientHeight,
  scrollTop: Math.round(v.scrollDOM.scrollTop),
  scrollHeight: v.scrollDOM.scrollHeight,
  viewport: { from: v.viewport.from, to: v.viewport.to },
  hasTable: !!v.contentDOM.querySelector(".md-table"),
  hasMath: !!v.contentDOM.querySelector(".md-math"),
  hasMermaid: !!v.contentDOM.querySelector(".md-mermaid"),
  renderedLines: v.contentDOM.querySelectorAll(".cm-line").length,
  tableTop: v.contentDOM.querySelector(".md-table") ? Math.round(v.contentDOM.querySelector(".md-table").getBoundingClientRect().top) : null,
});
const steps = [];
steps.push(snap("after showHost"));
v.dispatch({ selection: { anchor: P.posOf("MARK0", 2) } });
v.scrollDOM.scrollTop = 0;
await P.settle(4, 250);
steps.push(snap("cursor at MARK0, scrollTop=0"));
// D1-style setup: push the table above the viewport
const table = v.contentDOM.querySelector(".md-table");
if (table) {
  const rel = table.getBoundingClientRect().bottom - v.scrollDOM.getBoundingClientRect().top;
  v.scrollDOM.scrollTop = v.scrollDOM.scrollTop + rel + 20;
}
await P.settle(5, 300);
steps.push(snap("after D1 setup (table above viewport)"));
v.dispatch({ selection: { anchor: P.posOf("| a1 |", 1) } });
await P.settle(6, 350);
steps.push(snap("after activate table (source view)"));
v.dispatch({ selection: { anchor: P.posOf("MARK0", 2) } });
v.scrollDOM.scrollTop = 0;
await P.settle(5, 300);
steps.push(snap("back to MARK0 / scrollTop=0 (D2 start)"));
v.destroy();
host.remove();
return steps;
