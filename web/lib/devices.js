// Device profiles and the hostContext each one sends to an MCP App View.
//
// Sources:
// - MCP Apps spec 2026-01-26, HostContext (theme, displayMode, availableDisplayModes, containerDimensions, locale,
//   timeZone, userAgent, platform, deviceCapabilities, safeAreaInsets, styles).
// - Alexa+ "Layout and rendering": the Alexa host also sends deviceClass, maxWidth, maxHeight and isMobile, and
//   surfaces include mobile, Echo Show 8, Echo Show 15 and voice-only.
// - Alexa+ "Visual foundations": widgets are authored on a 768×480 base canvas; Echo Show 8 renders at 1280×800.
// Not published by Amazon (our assumptions, marked in the UI): the exact `deviceClass` strings, and the Echo Show 15
// widget viewport (we use its 1920×1080 panel at 1.5×, i.e. 1280×720 CSS pixels).

export const DEVICES = {
  show15: { id: 'show15', label: 'Echo Show 15', short: 'Show 15', hasScreen: true, css: { w: 1280, h: 720 }, scale: 1.5, bezel: 22, platform: 'web', isMobile: false, touch: true, note: '1920×1080 panel, laid out at 1280×720 (1.5×)' },
  show8: { id: 'show8', label: 'Echo Show 8', short: 'Show 8', hasScreen: true, css: { w: 1280, h: 800 }, scale: 1, bezel: 56, platform: 'web', isMobile: false, touch: true, note: '1280×800' },
  phone: { id: 'phone', label: 'Alexa app (phone)', short: 'Phone', hasScreen: true, css: { w: 390, h: 844 }, scale: 1, bezel: 14, platform: 'mobile', isMobile: true, touch: true, note: '390×844, safe areas 47 / 34' , safeArea: { top: 47, right: 0, bottom: 34, left: 0 } },
  dot: { id: 'dot', label: 'Echo Dot', short: 'Dot', hasScreen: false, platform: 'web', isMobile: false, touch: false, note: 'no screen, voice only' },
};
export const DEVICE_IDS = Object.keys(DEVICES);

// A few of the spec's standard theme variables, so Views that read them match the host.
export function styleVariables(theme) {
  const dark = theme === 'dark';
  return {
    '--color-background-primary': dark ? '#000000' : '#f2f2f7',
    '--color-background-secondary': dark ? '#1c1c1e' : '#ffffff',
    '--color-text-primary': dark ? '#ffffff' : '#000000',
    '--color-text-secondary': dark ? 'rgba(235,235,245,0.62)' : '#6e6e73',
    '--color-border-primary': dark ? 'rgba(84,84,88,0.6)' : 'rgba(60,60,67,0.18)',
    '--color-ring-primary': dark ? '#0a84ff' : '#0071e3',
    '--font-sans': '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif',
    '--font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  };
}

/**
 * @param {string} deviceId
 * @param {object} o
 * @param {'light'|'dark'} o.theme
 * @param {'inline'|'fullscreen'} [o.displayMode]
 * @param {{width?:number, height?:number}} [o.container]  size of the card slot in CSS pixels
 */
export function hostContextFor(deviceId, { theme = 'light', displayMode = 'inline', container = {}, locale = 'en-US', timeZone = 'UTC' } = {}) {
  const d = DEVICES[deviceId] || DEVICES.show8;
  const dims = {};
  if (container.width) dims.width = Math.round(container.width);
  if (container.height) dims.maxHeight = Math.round(container.height);
  return {
    theme,
    displayMode,
    availableDisplayModes: d.hasScreen ? ['inline', 'fullscreen'] : [],
    containerDimensions: dims,
    locale,
    timeZone,
    userAgent: 'mcp-voice-host/0.1.0',
    platform: d.platform,
    deviceCapabilities: { touch: d.touch, hover: false },
    safeAreaInsets: d.safeArea || { top: 0, right: 0, bottom: 0, left: 0 },
    styles: { variables: styleVariables(theme) },
    // Alexa+ extensions (names from Amazon's Layout and Rendering page; values are this host's).
    deviceClass: d.id,
    maxWidth: d.css?.w,
    maxHeight: d.css?.h,
    isMobile: d.isMobile,
  };
}
