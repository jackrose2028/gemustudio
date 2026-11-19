const STORAGE_KEY = "emu:settings:v2";
const LEGACY_STORAGE_KEY = "emu:settings:v1";
export const EMU_SYSTEMS = [
  { id: "atari2600", label: "Atari 2600" },
  { id: "nes", label: "NES" },
  { id: "gb", label: "Game Boy" },
  { id: "snes", label: "SNES" },
  { id: "gamegear", label: "Game Gear" },
  { id: "n64", label: "Nintendo 64" },
  { id: "gbc", label: "Game Boy Color" }
];
export const VIDEO_FILTERS = [
  ["nearest", "Pixel sharp"], ["linear", "Smooth bilinear"], ["2xsai", "2×SaI"],
  ["super2xsai", "Super 2×SaI"], ["supereagle", "Super Eagle"], ["scale2x", "Scale2x"],
  ["scale3x", "Scale3x"], ["hq2x", "HQ2x"], ["hq3x", "HQ3x"], ["hq4x", "HQ4x"],
  ["xbrz2x", "xBRZ 2×"], ["xbrz3x", "xBRZ 3×"], ["xbrz4x", "xBRZ 4×"],
  ["xbrz5x", "xBRZ 5×"], ["xbrz6x", "xBRZ 6×"], ["lcd3x", "LCD 3×"],
  ["crt", "CRT"], ["crt-caligari", "CRT Caligari"], ["crt-geom", "CRT Geometry"],
  ["crt-lottes", "CRT Lottes"]
];
export const DEFAULT_EMULATOR_CONFIG = Object.freeze({
  videoEnabled: true, aspectRatio: true, videoFilter: "supereagle", videoRotate: "0", swapVideo: false,
  audioEnabled: true, audioVolume: 100, audioBufferSize: 2048,
  gamepad: true, defaultMapping: true, swapPlayers: false, inputHighlight: true,
  emulatorTouch: false, customTouchControls: true,
  showFps: false, showSpeed: false, threaded: false,
  saveSlot: "1", saveLocation: "browser", autosaveSeconds: 0, autoLoadState: false, saveOnExit: false,
  customOptions: {}, systemOverrides: {}
});
const OVERRIDE_DEFAULTS = Object.freeze({
  videoFilter: null, videoRotate: null, aspectRatio: null,
  audioEnabled: null, audioVolume: null, audioBufferSize: null,
  gamepad: null, defaultMapping: null, swapPlayers: null,
  threaded: null, showFps: null, showSpeed: null,
  saveSlot: null, autosaveSeconds: null, autoLoadState: null, saveOnExit: null
});
function cleanCustomOptions(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function cleanSystemOverrides(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(EMU_SYSTEMS.map(system => [system.id, { ...OVERRIDE_DEFAULTS, ...(source[system.id] || {}) }]));
}
export function loadEmulatorConfig() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = current === null ? localStorage.getItem(LEGACY_STORAGE_KEY) : null;
    const saved = JSON.parse(current ?? legacy ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { ...DEFAULT_EMULATOR_CONFIG, customOptions: {}, systemOverrides: cleanSystemOverrides({}) };
    if (current === null && legacy !== null && saved.videoFilter === "nearest") saved.videoFilter = "supereagle";
    const config = { ...DEFAULT_EMULATOR_CONFIG, ...saved, customOptions: cleanCustomOptions(saved.customOptions), systemOverrides: cleanSystemOverrides(saved.systemOverrides) };
    if (current === null && legacy !== null) localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return config;
  } catch { return { ...DEFAULT_EMULATOR_CONFIG, customOptions: {}, systemOverrides: cleanSystemOverrides({}) }; }
}
export function saveEmulatorConfig(config) {
  const next = { ...DEFAULT_EMULATOR_CONFIG, ...config, customOptions: cleanCustomOptions(config?.customOptions), systemOverrides: cleanSystemOverrides(config?.systemOverrides) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
export function makeEjsDefaultOptions(config = loadEmulatorConfig(), systemId = null) {
  const o = config.systemOverrides?.[systemId] || {};
  const val = key => o[key] ?? config[key];
  const bool = value => String(Boolean(value));
  const volume = Number(val("audioVolume") ?? 100);
  return {
    "video-enabled": bool(config.videoEnabled),
    "video-force-aspect-ratio": bool(val("aspectRatio")),
    "video-filter": String(val("videoFilter") || "nearest"),
    "video-rotate": String(val("videoRotate") ?? "0"),
    "video-swap": bool(config.swapVideo),
    "audio-enabled": bool(val("audioEnabled")),
    "audio-volume": String(volume),
    "volume": String((volume / 100).toFixed(2)),
    "audio-buffer-size": String(val("audioBufferSize") ?? 2048),
    "input-allow-gamepad": bool(val("gamepad")),
    "input-default-mapping": bool(val("defaultMapping")),
    "input-swap": bool(val("swapPlayers")),
    "input-highlight": bool(config.inputHighlight),
    "input-touch-controls": bool(config.emulatorTouch),
    "virtual-gamepad": config.emulatorTouch ? "enabled" : "disabled",
    "show-speed": bool(val("showSpeed")),
    "fps": bool(val("showFps")),
    "save-state-location": String(config.saveLocation || "browser"),
    "save-state-slot": String(val("saveSlot") || "1"),
    ...cleanCustomOptions(config.customOptions)
  };
}
