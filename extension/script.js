const PAGE_SOURCE = "claude-i18n-page";
const EXTENSION_SOURCE = "claude-i18n-extension";
const EXTENSION_REQUEST_TYPE = "extension-request";
const EXTENSION_RESPONSE_TYPE = "extension-response";
const logger = createLogger("bridge");

window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }

  const request = parseExtensionRequest(event.data);
  if (!request) {
    return;
  }

  try {
    const payload = await chrome.runtime.sendMessage({
      type: request.action,
      payload: request.payload,
    });

    postExtensionResponse(request.requestId, payload);
  } catch (error) {
    logger.error("bridge.request.failed", {
      action: request.action,
      message: error instanceof Error ? error.message : String(error),
    });
    postExtensionResponse(request.requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

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
  window.postMessage(
    {
      source: EXTENSION_SOURCE,
      type: EXTENSION_RESPONSE_TYPE,
      requestId,
      payload,
    },
    window.location.origin,
  );
}

function createLogger(component) {
  return {
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
