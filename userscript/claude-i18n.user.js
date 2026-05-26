// ==UserScript==
// @name         Claude i18n Firefox Tampermonkey Experimental
// @namespace    https://github.com/Pectics/claude-i18n
// @version      0.1.0
// @description  Experimental Firefox Tampermonkey bridge for Claude i18n.
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      claude-i18n.vercel.app
// ==/UserScript==

(function installClaudeI18nUserscript() {
  "use strict";

  const PAGE_SOURCE = "claude-i18n-page";
  const EXTENSION_SOURCE = "claude-i18n-extension";
  const EXTENSION_REQUEST_TYPE = "extension-request";
  const EXTENSION_RESPONSE_TYPE = "extension-response";
  const REMOTE_I18N_BASE_URL = "https://claude-i18n.vercel.app";
  const STORAGE_PREFIX = "claude-i18n:userscript:";
  const VERSION_CACHE_KEY_PREFIX = `${STORAGE_PREFIX}version:`;
  const RESOURCE_CACHE_KEY_PREFIX = `${STORAGE_PREFIX}resource:`;
  const RESOURCE_INDEX_KEY_PREFIX = `${STORAGE_PREFIX}resource-index:`;
  const VERSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const REMOTE_REQUEST_TIMEOUT_MS = 15 * 1000;
  const RESOURCE_HASH_INDEX = {
    base: 0,
    statsig: 1,
  };
  const MESSAGE_HANDLERS = {
    "fetch-locales-manifest": fetchLocalesManifest,
    "get-i18n-resource": getI18nResource,
  };
  const logger = createLogger("userscript");

  installBridge();
  injectPageHook();

  function installBridge() {
    window.addEventListener("message", async (event) => {
      if (!isPageMessage(event)) {
        return;
      }

      const request = parseExtensionRequest(event.data);
      if (!request) {
        return;
      }

      try {
        const payload = await handleMessage({
          type: request.action,
          payload: request.payload,
        });
        postExtensionResponse(request.requestId, payload);
      } catch (error) {
        logger.error("bridge.request.failed", {
          action: request.action,
          message: stringifyError(error),
        });
        postExtensionResponse(request.requestId, {
          ok: false,
          error: stringifyError(error),
        });
      }
    });
  }

  function injectPageHook() {
    const source = `(${installClaudeI18nHook.toString()})();`;
    const pageWindow = getPageWindow();

    try {
      pageWindow.Function(source)();
      logger.info("hook.injected", {
        mode: "unsafeWindow.Function",
      });
      return;
    } catch (error) {
      logger.warn("hook.function-inject.failed", {
        message: stringifyError(error),
      });
    }

    const doc = pageWindow.document || document;
    const target = doc.documentElement || doc.head || doc.body;
    if (!target) {
      logger.error("hook.inject.failed", {
        message: "No document target is available",
      });
      return;
    }

    try {
      const script = doc.createElement("script");
      script.textContent = source;
      target.appendChild(script);
      script.remove();
      logger.info("hook.injected", {
        mode: "script-element",
      });
    } catch (error) {
      logger.error("hook.inject.failed", {
        message: stringifyError(error),
      });
    }
  }

  function isPageMessage(event) {
    const pageWindow = getPageWindow();
    return event.source === window || event.source === pageWindow;
  }

  function getPageWindow() {
    if (typeof unsafeWindow === "object" && unsafeWindow) {
      return unsafeWindow;
    }

    return window;
  }

  function parseExtensionRequest(data) {
    if (!data || data.source !== PAGE_SOURCE || data.type !== EXTENSION_REQUEST_TYPE) {
      return null;
    }

    return {
      requestId: data.requestId,
      action: data.action,
      payload: data.payload,
    };
  }

  function postExtensionResponse(requestId, payload) {
    const pageWindow = getPageWindow();
    pageWindow.postMessage(
      {
        source: EXTENSION_SOURCE,
        type: EXTENSION_RESPONSE_TYPE,
        requestId,
        payload,
      },
      pageWindow.location.origin,
    );
  }

  async function handleMessage(message) {
    if (!message || typeof message !== "object") {
      logger.warn("message.invalid");
      return {
        ok: false,
        error: "Invalid message payload",
      };
    }

    const handler = MESSAGE_HANDLERS[message.type];
    if (!handler) {
      logger.warn("message.unknown", {
        type: String(message.type),
      });
      return {
        ok: false,
        error: `Unknown message type: ${String(message.type)}`,
      };
    }

    return handler(message.payload);
  }

  async function fetchLocalesManifest() {
    const { response, data } = await fetchJsonNoStore(`${REMOTE_I18N_BASE_URL}/locales.json`);

    if (!response.ok) {
      throw new Error(`Failed to fetch locales manifest: ${response.status}`);
    }

    if (!data || !Array.isArray(data.locales)) {
      throw new Error("Remote locales manifest is invalid");
    }

    logger.info("locales.manifest.fetched", {
      version: typeof data.version === "string" ? data.version : "unknown",
      localeCount: data.locales.filter(isString).length,
    });

    return {
      ok: true,
      version: typeof data.version === "string" ? data.version : "",
      locales: data.locales.filter(isString),
    };
  }

  async function getI18nResource(payload) {
    const request = normalizeI18nResourceRequest(payload);
    if (!request) {
      return {
        ok: false,
        error: "Invalid i18n resource request",
      };
    }

    const { locale, kind } = request;
    const versionInfo = await getVersionInfo(locale);
    const resourceHash = versionInfo.hash?.[RESOURCE_HASH_INDEX[kind]];
    if (typeof resourceHash !== "string" || resourceHash.length === 0) {
      return {
        ok: false,
        error: `Missing ${kind} hash for locale ${locale}`,
      };
    }

    const cacheKey = buildResourceCacheKey(locale, kind, resourceHash);
    const cached = readResourceCache(cacheKey);
    if (cached) {
      logger.info("i18n.resource.cache-hit", {
        locale,
        kind,
      });
      return {
        ...cached,
        meta: {
          source: "cache",
        },
      };
    }

    const remoteUrl = buildRemoteI18nUrl(locale, kind);
    const { response: remoteResponse, body } = await fetchTextNoStore(remoteUrl);
    if (!remoteResponse.ok) {
      return {
        ok: false,
        error: `Failed to fetch ${remoteUrl}: ${remoteResponse.status}`,
        status: remoteResponse.status,
      };
    }

    const payloadToReturn = {
      ok: true,
      status: remoteResponse.status,
      statusText: remoteResponse.statusText,
      headers: withJsonContentType(remoteResponse.headers),
      body,
      meta: {
        source: "remote",
      },
    };

    writeResourceCache(locale, kind, resourceHash, payloadToReturn);
    logger.info("i18n.resource.remote-fetched", {
      locale,
      kind,
      status: remoteResponse.status,
    });

    return payloadToReturn;
  }

  async function getVersionInfo(locale) {
    const storageKey = buildVersionStorageKey(locale);
    const cached = getStoredValue(storageKey, null);
    const now = Date.now();

    if (isFreshVersionCache(cached, now)) {
      return cached;
    }

    try {
      const { response, data } = await fetchJsonNoStore(
        `${REMOTE_I18N_BASE_URL}/version/${encodeURIComponent(locale)}.json`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch version for ${locale}: ${response.status}`);
      }

      const next = normalizeVersionInfo(locale, data, now);
      setStoredValue(storageKey, next);
      logger.info("version.updated", {
        locale,
        builtAt: next.builtAt || "unknown",
      });

      return next;
    } catch (error) {
      if (cached && Array.isArray(cached.hash)) {
        logger.warn("version.fetch.failed-using-cache", {
          locale,
          message: stringifyError(error),
        });
        return cached;
      }

      throw error;
    }
  }

  function readResourceCache(cacheKey) {
    const cached = getStoredValue(cacheKey, null);
    if (!cached || typeof cached.body !== "string") {
      return null;
    }

    return {
      ok: true,
      status: typeof cached.status === "number" ? cached.status : 200,
      statusText: typeof cached.statusText === "string" ? cached.statusText : "OK",
      headers: withJsonContentType(cached.headers),
      body: cached.body,
    };
  }

  function writeResourceCache(locale, kind, hash, payload) {
    const cacheKey = buildResourceCacheKey(locale, kind, hash);
    const indexKey = buildResourceIndexKey(locale, kind);

    try {
      const previous = getStoredValue(indexKey, null);
      setStoredValue(cacheKey, {
        status: payload.status,
        statusText: payload.statusText,
        headers: payload.headers,
        body: payload.body,
        checkedAt: Date.now(),
      });

      if (previous && previous.key && previous.key !== cacheKey) {
        deleteStoredValue(previous.key);
      }

      setStoredValue(indexKey, {
        hash,
        key: cacheKey,
        checkedAt: Date.now(),
      });
    } catch (error) {
      logger.warn("i18n.resource.cache-write.failed", {
        locale,
        kind,
        message: stringifyError(error),
      });
    }
  }

  function isFreshVersionCache(value, now) {
    return (
      value &&
      Array.isArray(value.hash) &&
      typeof value.checkedAt === "number" &&
      now - value.checkedAt < VERSION_REFRESH_INTERVAL_MS
    );
  }

  function buildRemoteI18nUrl(locale, kind) {
    if (kind === "statsig") {
      return `${REMOTE_I18N_BASE_URL}/i18n/statsig/${encodeURIComponent(locale)}.json`;
    }

    return `${REMOTE_I18N_BASE_URL}/i18n/${encodeURIComponent(locale)}.json`;
  }

  function buildVersionStorageKey(locale) {
    return `${VERSION_CACHE_KEY_PREFIX}${locale}`;
  }

  function buildResourceCacheKey(locale, kind, hash) {
    return `${RESOURCE_CACHE_KEY_PREFIX}${locale}:${kind}:${hash}`;
  }

  function buildResourceIndexKey(locale, kind) {
    return `${RESOURCE_INDEX_KEY_PREFIX}${locale}:${kind}`;
  }

  function normalizeVersionInfo(locale, data, checkedAt) {
    return {
      locale,
      hash: Array.isArray(data?.hash) ? data.hash : [],
      builtAt: typeof data?.builtAt === "string" ? data.builtAt : "",
      checkedAt,
    };
  }

  function normalizeI18nResourceRequest(payload) {
    const locale = payload?.locale;
    const kind = payload?.kind;

    if (typeof locale !== "string" || (kind !== "base" && kind !== "statsig")) {
      return null;
    }

    return {
      locale,
      kind,
    };
  }

  async function fetchJsonNoStore(url) {
    const { response, body } = await fetchTextNoStore(url);
    return {
      response,
      data: JSON.parse(body),
    };
  }

  async function fetchTextNoStore(url) {
    const result = await gmRequest({
      method: "GET",
      url,
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
    });

    return {
      response: {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        statusText: result.statusText || "",
        headers: headersToObject(result.responseHeaders || ""),
      },
      body: result.responseText || "",
    };
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest is not available"));
        return;
      }

      GM_xmlhttpRequest({
        ...details,
        timeout: REMOTE_REQUEST_TIMEOUT_MS,
        onload(response) {
          resolve(response);
        },
        onerror(error) {
          reject(new Error(`Request failed: ${stringifyError(error)}`));
        },
        ontimeout() {
          reject(new Error(`Request timed out: ${details.url}`));
        },
        onabort() {
          reject(new Error(`Request aborted: ${details.url}`));
        },
      });
    });
  }

  function headersToObject(headerText) {
    const output = {};
    for (const line of String(headerText).split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }

      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (key) {
        output[key] = value;
      }
    }

    return output;
  }

  function withJsonContentType(headers) {
    const output = headers && typeof headers === "object" ? { ...headers } : {};
    if (!output["content-type"]) {
      output["content-type"] = "application/json; charset=utf-8";
    }

    return output;
  }

  function getStoredValue(key, fallback) {
    try {
      return GM_getValue(key, fallback);
    } catch (error) {
      logger.warn("storage.get.failed", {
        key,
        message: stringifyError(error),
      });
      return fallback;
    }
  }

  function setStoredValue(key, value) {
    try {
      GM_setValue(key, value);
    } catch (error) {
      logger.warn("storage.set.failed", {
        key,
        message: stringifyError(error),
      });
      throw error;
    }
  }

  function deleteStoredValue(key) {
    try {
      GM_deleteValue(key);
    } catch (error) {
      logger.warn("storage.delete.failed", {
        key,
        message: stringifyError(error),
      });
    }
  }

  function createLogger(component) {
    return {
      info(event, detail) {
        log("info", event, detail);
      },
      warn(event, detail) {
        log("warn", event, detail);
      },
      error(event, detail) {
        log("error", event, detail);
      },
    };

    function log(level, event, detail) {
      const message = `[claude-i18n][${component}] ${event}`;
      const safeDetail = compactDetail(detail);
      if (safeDetail) {
        console[level](message, safeDetail);
        return;
      }

      console[level](message);
    }
  }

  function compactDetail(detail) {
    if (!detail || typeof detail !== "object") {
      return null;
    }

    const output = {};
    for (const [key, value] of Object.entries(detail)) {
      if (value !== undefined && value !== null && value !== "") {
        output[key] = value;
      }
    }

    return Object.keys(output).length > 0 ? output : null;
  }

  function isString(value) {
    return typeof value === "string";
  }

  function stringifyError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function installClaudeI18nHook() {
    if (window.__CLAUDE_ARRAY_PROXY_INSTALLED__) {
      return;
    }
    window.__CLAUDE_ARRAY_PROXY_INSTALLED__ = true;

    const TARGET_FIRST = "en-US";
    const TARGET_LAST = "id-ID";
    const DEFAULT_EXTENSION_LOCALES = ["zh-CN"];
    const EXTENSION_LOCALES_KEY = "__CLAUDE_EXTENSION_LOCALES__";
    const EXTENSION_LOCALES_STORAGE_KEY = "__CLAUDE_EXTENSION_LOCALES_CACHE__";
    const PROFILE_LOCALE_STORAGE_KEY = "__CLAUDE_EXTENSION_PROFILE_LOCALE__";
    const REPORT_KEY = "__CLAUDE_ARRAY_PROXY_REPORT__";
    const PAGE_SOURCE = "claude-i18n-page";
    const EXTENSION_SOURCE = "claude-i18n-extension";
    const EXTENSION_REQUEST_TYPE = "extension-request";
    const EXTENSION_RESPONSE_TYPE = "extension-response";
    const ACCOUNT_PROFILE_PATH = "/api/account_profile";
    const ACCOUNT_PROFILE_FALLBACK_LOCALE = "en-US";
    const LOCALES_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const EXTENSION_REQUEST_TIMEOUT_MS = 15 * 1000;

    const PATH_PATTERNS = {
      experience: /^\/api\/organizations\/[^/]+\/experiences\/claude_web$/,
      bootstrapAppStart: /^\/edge-api\/bootstrap\/[^/]+\/app_start$/,
      baseI18nResource: /^\/i18n\/([^/]+)\.json$/,
      statsigI18nResource: /^\/i18n\/statsig\/([^/]+)\.json$/,
      overridesI18n: /^\/i18n\/[^/]+\.overrides\.json$/,
    };
    const ORIGINAL = {
      isArray: Array.isArray,
      indexOf: Array.prototype.indexOf,
      push: Array.prototype.push,
      splice: Array.prototype.splice,
      fetch: window.fetch.bind(window),
      setTimeout: window.setTimeout.bind(window),
      clearTimeout: window.clearTimeout.bind(window),
    };
    const NON_PATCHABLE_KEYS = new Set(["length", "name", "prototype"]);
    const MUTATING_PROTOTYPE_METHODS = new Set([
      "copyWithin",
      "fill",
      "pop",
      "push",
      "reverse",
      "shift",
      "sort",
      "splice",
      "unshift",
    ]);
    const SKIPPED_STATIC_METHODS = new Set(["isArray"]);

    const runtime = createRuntimeState();
    const logger = createLogger("hook", recordLogEntry);

    install();

    function install() {
      installFetchInterceptor();
      installArrayPatches();
      scheduleLocalesRefresh();
      logger.info("hook.installed", {
        localeCount: runtime.extensionLocales.length,
        manifestVersion: runtime.report.localesManifestVersion || "none",
      });
    }

    function createRuntimeState() {
      const cachedLocales = readLocalesCache();
      const extensionLocales = initializeExtensionLocales(cachedLocales);
      const report = createReport(extensionLocales, cachedLocales);
      window[REPORT_KEY] = report;

      return {
        extensionLocales,
        report,
        requestCounter: 0,
      };
    }

    function createReport(extensionLocales, cachedLocales) {
      return {
        installedAt: Date.now(),
        extensionLocales: extensionLocales.slice(),
        localesManifestVersion: typeof cachedLocales?.version === "string" ? cachedLocales.version : "",
        prototypeMethodsPatched: [],
        staticMethodsPatched: [],
        prototypeMethodsSkipped: [],
        staticMethodsSkipped: [],
        localesManifestRefreshHits: 0,
        localesManifestRefreshErrors: 0,
        accountProfilePutHits: 0,
        accountProfileGetHits: 0,
        accountProfileResponseHits: 0,
        experienceLocaleRewriteHits: 0,
        bootstrapLocaleRewriteHits: 0,
        i18nOverridesHits: 0,
        i18nRedirectHits: 0,
        i18nCacheHits: 0,
        mutationCount: 0,
        lastMutation: null,
        logs: [],
        errors: [],
      };
    }

    function installArrayPatches() {
      patchFunctionGroup(Array.prototype, {
        kind: "prototype",
        shouldSkipKey(key) {
          return MUTATING_PROTOTYPE_METHODS.has(key);
        },
        invoke(original, key, receiver, args) {
          ensureTargetLocale(receiver, key);
          return Reflect.apply(original, receiver, args);
        },
      });

      patchFunctionGroup(Array, {
        kind: "static",
        shouldSkipKey(key) {
          return SKIPPED_STATIC_METHODS.has(key);
        },
        invoke(original, key, receiver, args) {
          if (args.length > 0) {
            ensureTargetLocale(args[0], key);
          }

          return Reflect.apply(original, receiver, args);
        },
      });
    }

    function patchFunctionGroup(target, config) {
      const patchedReportKey =
        config.kind === "prototype" ? "prototypeMethodsPatched" : "staticMethodsPatched";
      const skippedReportKey =
        config.kind === "prototype" ? "prototypeMethodsSkipped" : "staticMethodsSkipped";

      for (const key of Reflect.ownKeys(target)) {
        if (NON_PATCHABLE_KEYS.has(key)) {
          continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (!descriptor || typeof descriptor.value !== "function") {
          continue;
        }

        if (config.shouldSkipKey(key)) {
          runtime.report[skippedReportKey].push(formatKey(key));
          continue;
        }

        const original = descriptor.value;
        if (original.__claudeArrayProxyWrapped__) {
          continue;
        }

        const wrapped = function (...args) {
          return config.invoke(original, key, this, args);
        };

        Object.defineProperty(wrapped, "__claudeArrayProxyWrapped__", {
          value: true,
        });
        Object.defineProperty(target, key, {
          ...descriptor,
          value: wrapped,
        });
        runtime.report[patchedReportKey].push(formatKey(key));
      }
    }

    function ensureTargetLocale(value, key) {
      if (!ORIGINAL.isArray(value) || !shouldInjectLocale(value)) {
        return;
      }

      try {
        let changed = false;
        for (const locale of runtime.extensionLocales) {
          if (!isString(locale) || hasArrayValue(value, locale)) {
            continue;
          }

          ORIGINAL.push.call(value, locale);
          changed = true;
        }

        if (!changed) {
          return;
        }

        runtime.report.mutationCount += 1;
        runtime.report.lastMutation = {
          method: formatKey(key),
          length: value.length,
          locales: runtime.extensionLocales.slice(),
          at: Date.now(),
        };
      } catch (error) {
        pushError(`Failed to inject via ${formatKey(key)}: ${stringifyError(error)}`);
      }
    }

    function shouldInjectLocale(value) {
      return (
        value.length > 0 &&
        typeof value[0] === "string" &&
        value[0] === TARGET_FIRST &&
        typeof value[value.length - 1] === "string" &&
        value[value.length - 1] === TARGET_LAST
      );
    }

    function initializeExtensionLocales(cachedLocales) {
      const existing = window[EXTENSION_LOCALES_KEY];
      if (ORIGINAL.isArray(existing) && existing.length > 0) {
        return existing;
      }

      const locales =
        cachedLocales && ORIGINAL.isArray(cachedLocales.locales) && cachedLocales.locales.length > 0
          ? cachedLocales.locales.filter(isString)
          : DEFAULT_EXTENSION_LOCALES.slice();
      window[EXTENSION_LOCALES_KEY] = locales;
      return locales;
    }

    function scheduleLocalesRefresh() {
      const cached = readLocalesCache();
      if (
        cached &&
        typeof cached.checkedAt === "number" &&
        Date.now() - cached.checkedAt < LOCALES_REFRESH_INTERVAL_MS
      ) {
        return;
      }

      ORIGINAL.setTimeout(() => {
        refreshExtensionLocales().catch((error) => {
          runtime.report.localesManifestRefreshErrors += 1;
          pushError(`Failed to refresh locales manifest: ${stringifyError(error)}`);
        });
      }, 50);
    }

    async function refreshExtensionLocales() {
      const cached = readLocalesCache();
      const payload = await requestExtension("fetch-locales-manifest", {});
      if (!payload.ok || !ORIGINAL.isArray(payload.locales)) {
        throw new Error(payload.error || "Invalid locales manifest response");
      }

      const nextLocales = payload.locales.filter(isString);
      const nextVersion = typeof payload.version === "string" ? payload.version : "";
      if (nextLocales.length === 0) {
        throw new Error("Remote locales manifest is empty");
      }

      if (!cached || cached.version !== nextVersion || !sameStringArray(cached.locales, nextLocales)) {
        replaceArrayContents(runtime.extensionLocales, nextLocales);
        window[EXTENSION_LOCALES_KEY] = runtime.extensionLocales;
        writeLocalesCache({
          version: nextVersion,
          locales: nextLocales,
          checkedAt: Date.now(),
        });
        runtime.report.extensionLocales = runtime.extensionLocales.slice();
        runtime.report.localesManifestVersion = nextVersion;
        runtime.report.localesManifestRefreshHits += 1;
        logger.info("locales.refresh.updated", {
          version: nextVersion || "unknown",
          localeCount: nextLocales.length,
        });
        return;
      }

      writeLocalesCache({
        ...cached,
        checkedAt: Date.now(),
      });
    }

    function replaceArrayContents(target, nextValues) {
      ORIGINAL.splice.call(target, 0, target.length);
      for (const value of nextValues) {
        ORIGINAL.push.call(target, value);
      }
    }

    function installFetchInterceptor() {
      window.fetch = function interceptedFetch(...args) {
        return runFetchRules(this, args);
      };
    }

    async function runFetchRules(fetchThis, args) {
      const context = createFetchContext(args);
      const afterFetchRules = [];

      try {
        if (context.isGetRequest() && matchesSameOriginUrl(context.url, { pathnamePattern: PATH_PATTERNS.overridesI18n })) {
          runtime.report.i18nOverridesHits += 1;
          logger.info("i18n.overrides.served");
          return createJsonResponse("{}", 200);
        }

        const resource = context.isGetRequest() ? parseI18nResource(context.url) : null;
        if (resource && isExtensionLocale(resource.locale)) {
          runtime.report.i18nRedirectHits += 1;
          const payload = await requestExtension("get-i18n-resource", resource);
          if (!payload.ok) {
            throw new Error(payload.error || `Failed to resolve ${resource.kind} for ${resource.locale}`);
          }

          runtime.report.i18nCacheHits += 1;
          logger.info("i18n.resource.served", {
            locale: resource.locale,
            kind: resource.kind,
            source: payload.meta?.source || "unknown",
            status: payload.status,
          });
          return createResponseFromPayload(payload);
        }

        if (
          context.isGetRequest() &&
          matchesSameOriginUrl(context.url, { pathnamePattern: PATH_PATTERNS.experience }) &&
          isExtensionLocale(context.url.searchParams.get("locale"))
        ) {
          runtime.report.experienceLocaleRewriteHits += 1;
          logger.info("experience.request.rewritten", {
            locale: context.url.searchParams.get("locale") || "unknown",
          });
          context.replaceRequest(replaceUrl(context.input, context.init, buildExperienceUrl(context.url)));
        }

        if (
          context.isGetRequest() &&
          matchesSameOriginUrl(context.url, { pathnamePattern: PATH_PATTERNS.bootstrapAppStart })
        ) {
          afterFetchRules.push(rewriteBootstrapResponse);
        }

        const accountProfileState = await prepareAccountProfileRequest(context.input, context.init);
        if (accountProfileState) {
          context.replaceRequest(accountProfileState.request);
          afterFetchRules.push((response) => rewriteAccountProfileResponse(response, accountProfileState));
        }

        let response = await context.fetch(fetchThis);
        for (const afterFetch of afterFetchRules) {
          response = await afterFetch(response);
        }
        return response;
      } catch (error) {
        logger.error("fetch.rule.failed", {
          request: describeRequest(context.url),
          method: context.method,
          message: stringifyError(error),
        });
        throw error;
      }
    }

    function createFetchContext(args) {
      let [input, init] = args;
      let requestState = {
        url: toUrl(input),
        method: getRequestMethod(input, init),
      };

      return {
        get input() {
          return input;
        },
        get init() {
          return init;
        },
        get url() {
          return requestState.url;
        },
        get method() {
          return requestState.method;
        },
        isGetRequest() {
          return requestState.method === "GET";
        },
        replaceRequest(nextRequest) {
          input = nextRequest.input;
          init = nextRequest.init;
          requestState = {
            url: toUrl(input),
            method: getRequestMethod(input, init),
          };
        },
        fetch(fetchThis) {
          const fetchArgs = init === undefined ? [input] : [input, init];
          return Reflect.apply(ORIGINAL.fetch, fetchThis, fetchArgs);
        },
      };
    }

    async function prepareAccountProfileRequest(input, init) {
      const url = toUrl(input);
      if (!matchesSameOriginUrl(url, { pathname: ACCOUNT_PROFILE_PATH })) {
        return null;
      }

      const method = getRequestMethod(input, init);
      const originalRequest = {
        input,
        init,
      };
      if (method === "GET") {
        return createAccountProfileRequestState(originalRequest, method, readStoredProfileLocale());
      }

      if (method !== "PUT") {
        return createAccountProfileRequestState(originalRequest, method, null);
      }

      const bodyText = await readRequestBodyText(input, init);
      if (!bodyText) {
        clearStoredProfileLocale();
        return createAccountProfileRequestState(originalRequest, method, null);
      }

      const body = parseJsonObject(bodyText);
      if (!body) {
        clearStoredProfileLocale();
        return createAccountProfileRequestState(originalRequest, method, null);
      }

      if (!isExtensionLocale(body.locale)) {
        if (typeof body.locale === "string") {
          clearStoredProfileLocale();
        }

        return createAccountProfileRequestState(originalRequest, method, null);
      }

      const profileLocale = body.locale;
      writeStoredProfileLocale(profileLocale);
      body.locale = ACCOUNT_PROFILE_FALLBACK_LOCALE;
      runtime.report.accountProfilePutHits += 1;
      logger.info("account-profile.request.rewritten", {
        method,
        locale: profileLocale,
      });

      return createAccountProfileRequestState(
        replaceRequestBody(input, init, JSON.stringify(body)),
        method,
        profileLocale,
      );
    }

    function createAccountProfileRequestState(request, method, profileLocale) {
      return {
        request,
        method,
        profileLocale,
      };
    }

    async function rewriteAccountProfileResponse(response, requestState) {
      const profileLocale = requestState?.profileLocale;
      if (!isExtensionLocale(profileLocale)) {
        return response;
      }

      const body = await readJsonObjectResponse(response);
      if (!body) {
        return response;
      }

      body.locale = profileLocale;
      if (requestState.method === "GET") {
        runtime.report.accountProfileGetHits += 1;
      }
      runtime.report.accountProfileResponseHits += 1;
      logger.info("account-profile.response.rewritten", {
        method: requestState.method,
        locale: profileLocale,
      });

      return replaceJsonResponse(response, body);
    }

    async function rewriteBootstrapResponse(response) {
      const profileLocale = readStoredProfileLocale();
      if (!isExtensionLocale(profileLocale)) {
        return response;
      }

      const body = await readJsonObjectResponse(response);
      if (!body) {
        return response;
      }

      body.locale = profileLocale;
      if (
        body.gated_messages &&
        typeof body.gated_messages === "object" &&
        !ORIGINAL.isArray(body.gated_messages)
      ) {
        body.gated_messages.locale = profileLocale;
      }

      runtime.report.bootstrapLocaleRewriteHits += 1;
      logger.info("bootstrap.response.rewritten", {
        locale: profileLocale,
      });
      return replaceJsonResponse(response, body);
    }

    function requestExtension(action, payload) {
      return new Promise((resolve, reject) => {
        const requestId = `claude-i18n-${Date.now()}-${runtime.requestCounter++}`;
        const timeout = ORIGINAL.setTimeout(() => {
          window.removeEventListener("message", handleMessage);
          reject(new Error(`Timed out waiting for extension action ${action}`));
        }, EXTENSION_REQUEST_TIMEOUT_MS);

        function handleMessage(event) {
          if (event.source !== window) {
            return;
          }

          const data = event.data;
          if (
            !data ||
            data.source !== EXTENSION_SOURCE ||
            data.type !== EXTENSION_RESPONSE_TYPE ||
            data.requestId !== requestId
          ) {
            return;
          }

          ORIGINAL.clearTimeout(timeout);
          window.removeEventListener("message", handleMessage);
          resolve(data.payload);
        }

        window.addEventListener("message", handleMessage);
        window.postMessage(
          {
            source: PAGE_SOURCE,
            type: EXTENSION_REQUEST_TYPE,
            requestId,
            action,
            payload,
          },
          window.location.origin,
        );
      });
    }

    function hasArrayValue(value, expected) {
      return ORIGINAL.indexOf.call(value, expected) !== -1;
    }

    function isExtensionLocale(value) {
      return isString(value) && hasArrayValue(runtime.extensionLocales, value);
    }

    function sameStringArray(left, right) {
      if (!ORIGINAL.isArray(left) || !ORIGINAL.isArray(right) || left.length !== right.length) {
        return false;
      }

      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
          return false;
        }
      }

      return true;
    }

    function readStoredProfileLocale() {
      try {
        return window.localStorage.getItem(PROFILE_LOCALE_STORAGE_KEY);
      } catch {
        return null;
      }
    }

    function writeStoredProfileLocale(locale) {
      try {
        window.localStorage.setItem(PROFILE_LOCALE_STORAGE_KEY, locale);
      } catch {}
    }

    function clearStoredProfileLocale() {
      try {
        window.localStorage.removeItem(PROFILE_LOCALE_STORAGE_KEY);
      } catch {}
    }

    function readLocalesCache() {
      try {
        const raw = window.localStorage.getItem(EXTENSION_LOCALES_STORAGE_KEY);
        if (!raw) {
          return null;
        }

        const parsed = JSON.parse(raw);
        if (!parsed || !ORIGINAL.isArray(parsed.locales)) {
          return null;
        }

        return parsed;
      } catch {
        return null;
      }
    }

    function writeLocalesCache(value) {
      try {
        window.localStorage.setItem(EXTENSION_LOCALES_STORAGE_KEY, JSON.stringify(value));
      } catch {}
    }

    function matchesSameOriginUrl(url, criteria) {
      if (url.origin !== window.location.origin) {
        return false;
      }

      if (criteria.pathname && url.pathname !== criteria.pathname) {
        return false;
      }

      if (criteria.pathnamePattern && !criteria.pathnamePattern.test(url.pathname)) {
        return false;
      }

      return true;
    }

    function toUrl(input) {
      if (input instanceof URL) {
        return input;
      }

      if (input instanceof Request) {
        return new URL(input.url, window.location.href);
      }

      return new URL(String(input), window.location.href);
    }

    function getRequestMethod(input, init) {
      if (init && typeof init.method === "string") {
        return init.method.toUpperCase();
      }

      if (input instanceof Request) {
        return input.method.toUpperCase();
      }

      return "GET";
    }

    async function readRequestBodyText(input, init) {
      if (init && typeof init.body === "string") {
        return init.body;
      }

      if (input instanceof Request) {
        return input.clone().text();
      }

      return "";
    }

    function replaceRequestBody(input, init, bodyText) {
      if (input instanceof Request) {
        return {
          input: new Request(input, {
            body: bodyText,
          }),
          init,
        };
      }

      return {
        input,
        init: {
          ...(init || {}),
          body: bodyText,
        },
      };
    }

    function replaceUrl(input, init, url) {
      if (input instanceof Request) {
        return {
          input: new Request(url.href, {
            method: input.method,
            headers: input.headers,
            cache: input.cache,
            credentials: input.credentials,
            integrity: input.integrity,
            keepalive: input.keepalive,
            mode: input.mode,
            redirect: input.redirect,
            referrer: input.referrer,
            referrerPolicy: input.referrerPolicy,
            signal: input.signal,
          }),
          init,
        };
      }

      if (input instanceof URL) {
        return {
          input: new URL(url.href),
          init,
        };
      }

      return {
        input: url.href,
        init,
      };
    }

    function parseI18nResource(url) {
      if (url.origin !== window.location.origin) {
        return null;
      }

      let match = url.pathname.match(PATH_PATTERNS.baseI18nResource);
      if (match) {
        return {
          kind: "base",
          locale: match[1],
        };
      }

      match = url.pathname.match(PATH_PATTERNS.statsigI18nResource);
      if (match) {
        return {
          kind: "statsig",
          locale: match[1],
        };
      }

      return null;
    }

    function buildExperienceUrl(url) {
      const nextUrl = new URL(url.href);
      nextUrl.searchParams.set("locale", ACCOUNT_PROFILE_FALLBACK_LOCALE);
      return nextUrl;
    }

    function createJsonResponse(bodyText, status) {
      return new Response(bodyText, {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    function createResponseFromPayload(payload) {
      return new Response(payload.body, {
        status: payload.status,
        statusText: payload.statusText,
        headers: payload.headers,
      });
    }

    async function readJsonObjectResponse(response) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return null;
      }

      const text = await response.clone().text();
      if (!text) {
        return null;
      }

      return parseJsonObject(text);
    }

    function replaceJsonResponse(response, body) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");

      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    function parseJsonObject(text) {
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || ORIGINAL.isArray(value)) {
          return null;
        }

        return value;
      } catch {
        return null;
      }
    }

    function pushError(message) {
      runtime.report.errors.push({
        at: Date.now(),
        message,
      });
      logger.error("runtime.error", {
        message,
      });

      if (runtime.report.errors.length > 20) {
        runtime.report.errors.shift();
      }
    }

    function recordLogEntry(entry) {
      runtime.report.logs.push(entry);
      if (runtime.report.logs.length > 50) {
        runtime.report.logs.shift();
      }
    }

    function formatKey(key) {
      return typeof key === "symbol" ? key.toString() : String(key);
    }

    function stringifyError(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function isString(value) {
      return typeof value === "string";
    }

    function describeRequest(url) {
      const resource = parseI18nResource(url);
      if (resource) {
        return `i18n:${resource.kind}`;
      }

      if (matchesSameOriginUrl(url, { pathnamePattern: PATH_PATTERNS.overridesI18n })) {
        return "i18n:overrides";
      }

      if (matchesSameOriginUrl(url, { pathnamePattern: PATH_PATTERNS.experience })) {
        return "experience";
      }

      if (matchesSameOriginUrl(url, { pathnamePattern: PATH_PATTERNS.bootstrapAppStart })) {
        return "bootstrap";
      }

      if (matchesSameOriginUrl(url, { pathname: ACCOUNT_PROFILE_PATH })) {
        return "account-profile";
      }

      return "other";
    }

    function createLogger(component, onRecord) {
      return {
        info(event, detail) {
          log("info", event, detail);
        },
        error(event, detail) {
          log("error", event, detail);
        },
      };

      function log(level, event, detail) {
        const message = `[claude-i18n][${component}] ${event}`;
        const safeDetail = compactDetail(detail);
        const entry = {
          at: new Date().toISOString(),
          level,
          component,
          event,
          ...(safeDetail || {}),
        };

        if (typeof onRecord === "function") {
          onRecord(entry);
        }

        if (safeDetail) {
          console[level](message, safeDetail);
          return;
        }

        console[level](message);
      }
    }

    function compactDetail(detail) {
      if (!detail || typeof detail !== "object") {
        return null;
      }

      const output = {};
      for (const [key, value] of Object.entries(detail)) {
        if (value !== undefined && value !== null && value !== "") {
          output[key] = value;
        }
      }

      return Object.keys(output).length > 0 ? output : null;
    }
  }
})();
