const P = window.PROBE;
const { view: v, host } = P.newProbeView(700, P.tallFenceDoc());
await P.showHost(host);
await P.settle(6, 400);
const vs = v.viewState;
const log = [];
const origLineBlockAt = vs.lineBlockAt.bind(vs);
const origScrollAnchorAt = vs.scrollAnchorAt.bind(vs);
vs.lineBlockAt = (pos) => {
  const b = origLineBlockAt(pos);
  log.push({ call: "lineBlockAt", pos, line: v.state.doc.lineAt(pos).number, top: Math.round(b.top * 100) / 100, height: Math.round(b.height * 100) / 100 });
  return b;
};
vs.scrollAnchorAt = (off) => {
  const b = origScrollAnchorAt(off);
  log.push({ call: "scrollAnchorAt", off: Math.round(off * 100) / 100, from: b.from, line: v.state.doc.lineAt(b.from).number, top: Math.round(b.top * 100) / 100, height: Math.round(b.height * 100) / 100 });
  return b;
};
const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
const writes = [];
Object.defineProperty(v.scrollDOM, "scrollTop", {
  configurable: true,
  get() { return desc.get.call(this); },
  set(val) {
    const prev = desc.get.call(this);
    writes.push({ from: Math.round(prev * 100) / 100, to: Math.round(val * 100) / 100, atLog: log.length, anchorState: { scrollAnchorPos: vs.scrollAnchorPos, scrollAnchorHeight: Math.round(vs.scrollAnchorHeight * 100) / 100, scrollOffset: Math.round(vs.scrollOffset * 100) / 100, viewport: { from: vs.viewport.from, to: vs.viewport.to } } });
    desc.set.call(this, val);
  },
});
v.scrollDOM.scrollTop = 6000;
await P.settle(3, 300);
const result = {
  after: Math.round(v.scrollDOM.scrollTop * 100) / 100,
  writes,
  fullLog: log.map((l, i) => ({ i, ...l })),
  heightMapNote: "tops above come from viewState.lineBlockAt/scrollAnchorAt",
};
v.destroy();
host.remove();
return result;
