const folderPath = (path) => path.substring(0, path.lastIndexOf("/") + 1);

let scriptPath = (typeof window.EJS_pathtodata === "string") ? window.EJS_pathtodata : folderPath((new URL(document.currentScript.src)).pathname);
if (!scriptPath.endsWith("/")) {
    scriptPath += "/";
}

const debug = window.EJS_DEBUG_XX === true;
const useMinified = window.EJS_useMinified === true;

if (debug) {
    console.log("Script Path:", scriptPath);
}

function resolvePath(path) {
    let resolved;
    if ("undefined" != typeof EJS_paths && typeof EJS_paths[path] === "string") {
        resolved = EJS_paths[path];
    } else if (path.endsWith("emulator.min.js") || path.endsWith("css")) {
        resolved = scriptPath + path;
    } else {
        resolved = scriptPath + "src/" + path;
    }
    return new URL(resolved, document.baseURI).href;
}

async function loadScript(file) {
    try {
        const module = await import(resolvePath(file));
        return module.default;
    } catch (e) {
        console.error("Failed to load " + file, e);
        if (file === "emulator.min.js") {
            return loadScript("emulator.js");
        }
        return null;
    }
}

function loadStyle(file) {
    return new Promise((resolve) => {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = resolvePath(file);
        css.onload = resolve;
        css.onerror = () => {
            console.error("Failed to load " + file);
            if (file === "emulator.min.css") {
                loadStyle("emulator.css").then(resolve);
            } else {
                resolve();
            }
        };
        document.head.appendChild(css);
    });
}

async function fetchJson(path, quiet) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (e) {
        if (!quiet) console.warn("Failed to fetch", path, e.message);
        return null;
    }
}

function getLanguagePath(language) {
    if ("undefined" != typeof EJS_paths && typeof EJS_paths[language] === "string") {
        return { path: EJS_paths[language], fallback: null };
    }
    const base = scriptPath + "localization/" + language + ".json";
    let fallback = null;
    if (language.includes("-") || language.includes("_")) {
        fallback = scriptPath + "localization/" + language.split(/[-_]/)[0] + ".json";
    }
    return { path: base, fallback };
}

async function loadLanguage(config) {
    const defaultLangs = ["en", "en-US"];
    if (!config.language || defaultLangs.includes(config.language)) return config;

    const paths = getLanguagePath(config.language);
    const [specific, fallback] = await Promise.all([
        fetchJson(paths.path, !!paths.fallback),
        paths.fallback ? fetchJson(paths.fallback, true) : null
    ]);

    if (specific || fallback) {
        config.langJson = { ...(fallback || {}), ...(specific || {}) };
        if (!specific && paths.fallback) {
            config.language = config.language.split(/[-_]/)[0];
        }
    } else {
        console.warn(`No language file found for '${config.language}'`);
        delete config.language;
        delete config.langJson;
    }
    return config;
}

const config = {
    debug: debug,
    gameUrl: window.EJS_gameUrl,
    dataPath: scriptPath,
    system: window.EJS_core,
    biosUrl: window.EJS_biosUrl,
    gameName: window.EJS_gameName,
    color: window.EJS_color,
    adUrl: window.EJS_AdUrl,
    adMode: window.EJS_AdMode,
    adTimer: window.EJS_AdTimer,
    adSize: window.EJS_AdSize,
    alignStartButton: window.EJS_alignStartButton,
    VirtualGamepadSettings: window.EJS_VirtualGamepadSettings,
    buttonOpts: window.EJS_Buttons,
    volume: window.EJS_volume,
    defaultControllers: window.EJS_defaultControls,
    startOnLoad: window.EJS_startOnLoaded,
    fullscreenOnLoad: window.EJS_fullscreenOnLoaded,
    filePaths: window.EJS_paths,
    loadState: window.EJS_loadStateURL,
    cacheLimit: window.EJS_CacheLimit,
    cacheConfig: window.EJS_cacheConfig,
    cheats: window.EJS_cheats,
    cheatPath: window.EJS_cheatPath,
    defaultOptions: window.EJS_defaultOptions,
    gamePatchUrl: window.EJS_gamePatchUrl,
    gameParentUrl: window.EJS_gameParentUrl,
    netplayUrl: window.EJS_netplayServer,
    netplayICEServers: window.EJS_netplayICEServers,
    gameId: window.EJS_gameID,
    backgroundImg: window.EJS_backgroundImage,
    backgroundBlur: window.EJS_backgroundBlur,
    backgroundColor: window.EJS_backgroundColor,
    controlScheme: window.EJS_controlScheme,
    threads: window.EJS_threads,
    disableCue: window.EJS_disableCue,
    startBtnName: window.EJS_startButtonName,
    softLoad: window.EJS_softLoad,
    capture: window.EJS_screenCapture,
    externalFiles: window.EJS_externalFiles,
    dontExtractRom: window.EJS_dontExtractRom,
    dontExtractBIOS: window.EJS_dontExtractBIOS,
    disableLocalStorage: window.EJS_disableLocalStorage,
    forceLegacyCores: window.EJS_forceLegacyCores,
    noAutoFocus: window.EJS_noAutoFocus,
    videoRotation: window.EJS_videoRotation,
    hideSettings: window.EJS_hideSettings,
    browserMode: window.EJS_browserMode,
    additionalShaders: window.EJS_shaders,
    fixedSaveInterval: window.EJS_fixedSaveInterval,
    disableAutoUnload: window.EJS_disableAutoUnload,
    disableBatchBootup: window.EJS_disableBatchBootup,
    askBeforeExit: window.EJS_askBeforeExit,
    retroarchOpts: window.EJS_retroarchOpts,
    coreOpts: window.EJS_coreOpts,
    coreManifest: window.EJS_coreManifest,
    coreVersion: window.EJS_coreVersion
};

async function prepareLanguage() {
    try {
        const systemLang = Intl.DateTimeFormat().resolvedOptions().locale;
        config.language = window.EJS_language || systemLang;
        if (config.language && window.EJS_disableAutoLang !== false) {
            return await loadLanguage(config);
        }
    } catch (e) {
        console.warn("Language detection failed:", e.message);
        delete config.language;
        delete config.langJson;
    }
}

async function loadCoreManifest() {
    if (config.coreManifest) return config.coreManifest;
    const url = new URL(scriptPath + "cores/manifest.json", document.baseURI).href;
    const manifest = await fetchJson(url, true);
    if (manifest && manifest.files) {
        config.coreManifest = manifest;
    } else if (debug) {
        console.warn("No core manifest found; core variants will not be checked before download.");
    }
    return config.coreManifest;
}

(async function() {
    // Script, stylesheet, language pack and core manifest are independent: fetch them together
    const [EmulatorJS] = await Promise.all([
        loadScript(useMinified ? "emulator.min.js" : "emulator.js"),
        loadStyle(useMinified ? "emulator.min.css" : "emulator.css"),
        prepareLanguage(),
        loadCoreManifest()
    ]);

    if (!EmulatorJS) {
        console.error("EmulatorJS failed to load. Check for missing files.");
        return;
    }

    if (debug) {
        console.log("Language:", config.language);
        console.log("Language JSON loaded:", !!config.langJson);
    }

    window.EJS_emulator = new EmulatorJS(EJS_player, config);
    window.EJS_adBlocked = (url, del) => window.EJS_emulator.frontend.adBlocked(url, del);

    const handlers = [
        ["ready", window.EJS_ready],
        ["start", window.EJS_onGameStart],
        ["loadState", window.EJS_onLoadState],
        ["saveState", window.EJS_onSaveState],
        ["loadSave", window.EJS_onLoadSave],
        ["saveSave", window.EJS_onSaveSave],
        ["exit", window.EJS_onExit]
    ];

    handlers.forEach(([event, callback]) => {
        if (typeof callback === "function") {
            window.EJS_emulator.on(event, callback);
        }
    });

    if (typeof window.EJS_onSaveUpdate === "function") {
        window.EJS_emulator.on("saveUpdate", window.EJS_onSaveUpdate);
        window.EJS_emulator.enableSaveUpdateEvent();
    }
})();
