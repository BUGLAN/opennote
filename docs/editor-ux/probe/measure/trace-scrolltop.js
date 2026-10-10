const P = window.PROBE;
const { view: v, host } = P.newProbeView(700, P.tallFenceDoc());
await P.showHost(host);
await P.settle(6, 400);
const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
const traces = [];
Object.defineProperty(v.scrollDOM, "scrollTop", {
  configurable: true,
  get() { return desc.get.call(this); },
  set(val) {
    const prev = desc.get.call(this);
    const stack = (new Error().stack || "")
      .split("\n")
      .slice(1, 6)
      .map((s) => s.trim().replace(/https?:\/\/127\.0\.0\.1:5199/g, ""));
    traces.push({ from: prev, to: Math.round(val * 100) / 100, stack });
    desc.set.call(this, val);
  },
});

const round = (n) => Math.round(n * 100) / 100;

// A) one big jump
async function bigJump(target) {
  traces.length = 0;
  v.scrollDOM.scrollTop = target;
  await P.settle(3, 200);
  return { target, after: round(v.scrollDOM.scrollTop), delta: round(v.scrollDOM.scrollTop - target), writes: traces.slice() };
}

// B) the same distance, but in small steps (what a wheel/trackpad does)
async function smallSteps(from, to, step) {
  v.scrollDOM.scrollTop = from;
  await P.settle(3, 200);
  const start = round(v.scrollDOM.scrollTop);
  const marks = [];
  for (let t = from + step; t <= to; t += step) {
    v.scrollDOM.scrollTop = t;
    await P.settle(2, 90);
    marks.push({ requested: t, after: round(v.scrollDOM.scrollTop), delta: round(v.scrollDOM.scrollTop - t) });
  }
  const end = round(v.scrollDOM.scrollTop);
  return { from, to, step, start, end, drift: round(end - to), worstDelta: round(Math.max(...marks.map((m) => Math.abs(m.delta)))), marks };
}

v.scrollDOM.scrollTop = 0;
await P.settle(3, 200);
const big = await bigJump(6000);
v.scrollDOM.scrollTop = 0;
await P.settle(4, 300);
const small = await smallSteps(0, 6000, 100);
v.scrollDOM.scrollTop = 0;
await P.settle(4, 300);
const smallLarge = await smallSteps(0, 6000, 500);

v.destroy();
host.remove();
return { bigJump: big, smallSteps100: small, smallSteps500: smallLarge };
