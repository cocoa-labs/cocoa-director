export function mockImageDataUrl(label: string, accent = "#a8ff60") {
  const safeLabel = escapeXml(label).slice(0, 80);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536">
  <defs>
    <linearGradient id="sky" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#07110f"/>
      <stop offset="0.45" stop-color="#162421"/>
      <stop offset="1" stop-color="#0b0d0c"/>
    </linearGradient>
    <radialGradient id="glow" cx="55%" cy="18%" r="65%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.72"/>
      <stop offset="0.28" stop-color="#68d8ff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect width="1024" height="1536" fill="url(#sky)"/>
  <rect width="1024" height="1536" fill="url(#glow)"/>
  <g opacity="0.52">
    <rect x="78" y="80" width="108" height="1050" fill="#121b19"/>
    <rect x="826" y="120" width="116" height="980" fill="#0e1715"/>
    <rect x="228" y="230" width="122" height="760" fill="#14201d"/>
    <rect x="670" y="210" width="96" height="820" fill="#172522"/>
    <path d="M0 1110 C210 1040 404 1048 575 1090 C754 1134 876 1115 1024 1054 L1024 1536 L0 1536 Z" fill="#050706"/>
  </g>
  <g opacity="0.78">
    <path d="M126 168 L126 1034" stroke="${accent}" stroke-width="7"/>
    <path d="M886 244 L886 1020" stroke="#68d8ff" stroke-width="5"/>
    <path d="M318 308 L318 925" stroke="#ff7065" stroke-width="4"/>
    <path d="M720 270 L720 1020" stroke="#ffbd6b" stroke-width="3"/>
  </g>
  <g filter="url(#blur)" opacity="0.58">
    <circle cx="512" cy="410" r="190" fill="${accent}"/>
    <circle cx="690" cy="650" r="140" fill="#68d8ff"/>
    <circle cx="260" cy="830" r="160" fill="#ff7065"/>
  </g>
  <rect x="70" y="90" width="884" height="1356" rx="38" fill="rgba(6,9,8,0.40)" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
  <path d="M210 1146 C340 940 510 905 810 1105" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="18" stroke-linecap="round"/>
  <path d="M210 1210 C375 1128 560 1128 832 1218" fill="none" stroke="${accent}" stroke-opacity="0.54" stroke-width="10" stroke-linecap="round"/>
  <circle cx="512" cy="650" r="122" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.26)" stroke-width="5"/>
  <path d="M512 508 L566 656 L512 790 L458 656 Z" fill="rgba(244,247,239,0.24)" stroke="rgba(244,247,239,0.45)" stroke-width="3"/>
  <text x="512" y="1290" text-anchor="middle" fill="#f4f7ef" font-family="Arial, sans-serif" font-size="54" font-weight="700">${safeLabel}</text>
  <text x="512" y="1356" text-anchor="middle" fill="${accent}" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="7">COCOA ANCHOR</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function mockVideoUrl(_videoId: string, shotIndex?: number, durationSeconds = 4, aspectRatio = "9:16") {
  return `/api/demo/media?kind=video&duration=${Math.min(300, Math.max(1, Math.round(durationSeconds)))}&aspect=${encodeURIComponent(aspectRatio)}&variant=${(shotIndex ?? 0) % 8}`;
}

export function mockAudioUrl(_videoId: string, durationSeconds = 60) {
  return `/api/demo/media?kind=audio&duration=${Math.min(300, Math.max(1, Math.round(durationSeconds)))}`;
}

export function mockImageUrl(variant = 0) {
  return `/api/demo/media?kind=image&variant=${variant % 8}`;
}

function escapeXml(value: string) {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}
