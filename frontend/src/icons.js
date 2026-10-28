// Crisp Scalable Vector Graphics for Flash-Sale Flagship Item & System UI

export const productSvgs = {
  smartphone: `
    <svg viewBox="0 0 400 480" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="titaniumFrameLight" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#334155"/>
          <stop offset="50%" stop-color="#1e293b"/>
          <stop offset="100%" stop-color="#0f172a"/>
        </linearGradient>
        <linearGradient id="screenGradLight" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="40%" stop-color="#1e293b"/>
          <stop offset="80%" stop-color="#2563eb"/>
          <stop offset="100%" stop-color="#0284c7"/>
        </linearGradient>
      </defs>
      <!-- Soft Ambient Shadow -->
      <ellipse cx="200" cy="455" rx="130" ry="12" fill="#cbd5e1" opacity="0.6"/>
      <!-- Outer Body -->
      <rect x="80" y="30" width="240" height="410" rx="8" fill="url(#titaniumFrameLight)" stroke="#cbd5e1" stroke-width="1.5"/>
      <!-- Inner Bezel -->
      <rect x="88" y="38" width="224" height="394" rx="6" fill="#020617"/>
      <!-- AMOLED Screen -->
      <rect x="92" y="42" width="216" height="386" rx="4" fill="url(#screenGradLight)"/>
      <!-- Subtle Screen Graphic Waves -->
      <path d="M92 280 Q 150 220 200 250 T 308 230 L 308 428 L 92 428 Z" fill="#3b82f6" opacity="0.3"/>
      <path d="M92 320 Q 160 270 220 300 T 308 270 L 308 428 L 92 428 Z" fill="#60a5fa" opacity="0.2"/>
      <circle cx="240" cy="160" r="50" fill="#38bdf8" opacity="0.2"/>
      <!-- Punch Hole Camera -->
      <circle cx="200" cy="58" r="4.5" fill="#020617" stroke="#475569" stroke-width="1"/>
      <circle cx="201" cy="57" r="1.5" fill="#38bdf8"/>
      <!-- Speaker grill -->
      <rect x="175" y="46" width="50" height="2" rx="1" fill="#64748b"/>
      <!-- UI Screen Typography -->
      <text x="200" y="115" font-family="Outfit, sans-serif" font-weight="700" font-size="26" fill="#ffffff" text-anchor="middle">E TITAN</text>
      <text x="200" y="136" font-family="Inter, sans-serif" font-weight="600" font-size="11" fill="#93c5fd" text-anchor="middle" letter-spacing="3">5G SMARTPHONE</text>
      <rect x="130" y="152" width="140" height="26" rx="3" fill="rgba(255,255,255,0.15)"/>
      <text x="200" y="169" font-family="Inter, sans-serif" font-weight="600" font-size="11" fill="#86efac" text-anchor="middle">BATCH OF 500</text>
      <!-- Bottom Indicator -->
      <rect x="160" y="416" width="80" height="3" rx="1.5" fill="#ffffff" opacity="0.8"/>
    </svg>
  `
};

export const uiIcons = {
  lightning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  shield: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  bolt: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  share: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  server: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  sync: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
};
