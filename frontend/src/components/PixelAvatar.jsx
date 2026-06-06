// Deterministic pixel-art avatar (blockies-style). Same seed → same face.
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRand(seedNum) {
  let s = seedNum || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export default function PixelAvatar({ seed = "x", size = 44, accent }) {
  const rnd = makeRand(hashSeed(String(seed)));
  const hue = Math.floor(rnd() * 360);
  const color = accent || `hsl(${hue}, 68%, 62%)`;
  const color2 = `hsl(${(hue + 40) % 360}, 70%, 70%)`;
  const bg = `hsl(${(hue + 180) % 360}, 28%, 15%)`;
  const n = 5;
  const cells = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < 3; x++) {
      const r = rnd();
      if (r > 0.5) {
        const c = r > 0.78 ? color2 : color;
        cells.push([x, y, c]);
        if (x < 2) cells.push([n - 1 - x, y, c]);
      }
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      shapeRendering="crispEdges"
      style={{ borderRadius: size * 0.22, background: bg, flexShrink: 0, display: "block" }}
    >
      {cells.map(([x, y, c], i) => (
        <rect key={i} x={x} y={y} width="1" height="1" fill={c} />
      ))}
    </svg>
  );
}
