# Claude i18n Session Report

Date: 2026-05-26
Workspace: `/mnt/f/claude-web-i18n`
Scope: Chrome Extension runtime rewrite, Vercel locale manifest update, caching design landing, README synchronization

## 1. Session goal

This session started from a clean-slate debugging request:

- temporarily strip the extension down to a minimal test shell
- verify whether `document_start + MAIN world` interception could alter Claude Web behavior before the main bundle settled
- rebuild the extension step by step around the actual request seams instead of whole-bundle replacement

The session then expanded into:

- rebuilding the extension runtime pipeline
- moving supported locale discovery to a remote manifest
- adding version-aware language pack caching
- updating release-facing documentation

## 2. Final outcome

By the end of the session, the extension was rebuilt into a 3-layer runtime:

- `extension/hook.js`
  Page-main-world hook installed at `document_start`.
- `extension/script.js`
  Bridge between page context and extension background.
- `extension/service.js`
  Background service worker for remote manifest fetch, version lookup, and language-pack caching.

The current extension version in [extension/manifest.json](/mnt/f/claude-web-i18n/extension/manifest.json:1) is `1.1.0`.

## 3. Major implementation work completed

### 3.1 Initial reset and Array-level probing

The extension was intentionally reduced to a minimal state to test a very early interception strategy:

- only `document_start + MAIN world` injection was kept
- every function-valued property on `Array.prototype` and `Array` was proxied
- the target heuristic was:
  - first item is `"en-US"`
  - last item is `"id-ID"`
  - append extension locales into that array

During this phase, two important bugs/decisions were discovered and corrected:

- mutating Array methods such as `push`, `splice`, `sort`, `reverse`, `shift`, `unshift`, `fill`, `copyWithin`, `pop` should not be proxied for rewrite purposes
- `Array.isArray` must never be proxied if internal hook logic also depends on it, otherwise recursive self-entry causes stack overflow

This probing phase established the safe baseline for the later runtime hook.

### 3.2 Request/response rewriting for Claude Web locale state

The page hook was expanded to intercept and normalize the key Claude Web endpoints used in language switching:

- `PUT /api/account_profile`
  - if the outgoing locale is one of the extension locales, cache the requested locale
  - rewrite the actual outgoing locale to fallback `en-US`
- `GET /api/account_profile`
  - restore the cached extension locale into the returned JSON
- `GET /api/organizations/<uuid>/experiences/claude_web?locale=xx-XX`
  - if `xx-XX` is an extension locale, rewrite it to fallback `en-US`
- `GET /edge-api/bootstrap/<uuid>/app_start`
  - rewrite `$.locale`
  - rewrite `$.gated_messages.locale` only if `gated_messages` exists
  - do not modify `$.gated_messages.messages`
- `GET /i18n/*.overrides.json`
  - intercept and return `{}`
- `GET /i18n/{locale}.json`
- `GET /i18n/statsig/{locale}.json`
  - if the locale is extension-provided, resolve the payload through the extension background/cache layer

### 3.3 Remote-supported locales manifest

The extension locale list is no longer hardcoded as the only source of truth.

Current design:

- page boot uses a default fallback locale list of `["zh-CN"]`
- cached remote locale manifest is read from:
  - `localStorage["__CLAUDE_EXTENSION_LOCALES_CACHE__"]`
- runtime global list is exposed as:
  - `window.__CLAUDE_EXTENSION_LOCALES__`
- a lazy refresh then fetches:
  - `https://claude-i18n.vercel.app/locales.json`

Refresh rule:

- cached locales are reused if they were checked recently
- otherwise the remote manifest is fetched
- the local cache is replaced only when:
  - the remote `version` changes, or
  - the locale array contents change

### 3.4 Version-aware language file caching

Language packs were moved to a proper metadata/body split:

- metadata cache:
  - `chrome.storage.local`
  - key prefix: `claude-i18n:version:`
- response body cache:
  - `Cache Storage`
  - cache name: `claude-i18n-cache-v1`

Lookup flow for extension locales:

1. hook asks the background for an i18n resource
2. background loads `/version/{locale}.json`
3. version hash for main/statsig is checked
4. cache key is built from locale + kind + hash
5. if cached body exists, return it immediately
6. if not, fetch the remote JSON, cache it, and prune stale hash entries

Remote endpoints used:

- `https://claude-i18n.vercel.app/locales.json`
- `https://claude-i18n.vercel.app/version/{locale}.json`
- `https://claude-i18n.vercel.app/i18n/{locale}.json`
- `https://claude-i18n.vercel.app/i18n/statsig/{locale}.json`

### 3.5 Extension manifest and permissions

The manifest was rebuilt to support the final runtime shape:

- `storage` permission added
- host permissions added for:
  - `https://claude.ai/*`
  - `https://claude-i18n.vercel.app/*`
- background service worker reintroduced
- content scripts split into:
  - isolated-world `script.js`
  - main-world `hook.js`

## 4. Vercel / repository-side work completed

### 4.1 `locales.json` format simplification

The repository’s root `locales.json` was changed from object entries with names to a plain string array:

Old shape:

```json
{
  "version": "0000000",
  "locales": [
    {
      "locale": "zh-CN",
      "name": "简体中文 (中国大陆)"
    }
  ]
}
```

New shape:

```json
{
  "version": "0000000",
  "locales": ["zh-CN"]
}
```

### 4.2 Build pipeline adaptation

[build.sh](/mnt/f/claude-web-i18n/build.sh:1) was updated to read the new string-array locale format and continue generating:

- `dist/locales.json`
- `dist/<locale>/version.json`

for each locale listed.

### 4.3 Deploy commit and push

The locale-manifest-format change was staged, committed, and pushed separately so Vercel could deploy it independently of the larger extension rewrite.

Committed and pushed:

- commit: `3809a67`
- message: `Simplify locales manifest format`

This was intentionally isolated from the larger uncommitted extension/runtime work.

## 5. Documentation work completed

Three README files were updated to match the current implementation:

- [README.md](/mnt/f/claude-web-i18n/README.md:1)
- [README.en.md](/mnt/f/claude-web-i18n/README.en.md:1)
- [README.tw.md](/mnt/f/claude-web-i18n/README.tw.md:1)

Updated sections included:

- how the extension works
- supported-language string counts
- contribution instructions
- changelog / `v1.1.0`-level implementation details

Other README synchronization done in the same pass:

- screenshot references updated to `.jpg`
- screenshot block expanded into a collapsible gallery
- repository clone / releases links updated to `Pectics/claude-i18n`
- contribution steps updated for the new `locales.json` format

## 6. Validation performed during the session

The following checks were actually run during this session:

- `./build.sh`
  - passed after `locales.json` shape update
- `node --check extension/hook.js`
- `node --check extension/script.js`
- `node --check extension/service.js`
- `python3 -m json.tool extension/manifest.json`

These checks verified:

- build script still produces distributable assets
- extension JS files are syntactically valid
- manifest JSON remained valid

## 7. Important implementation details worth remembering

### Locale truth and storage

- current fallback backend locale:
  - `en-US`
- current profile-locale cache:
  - `localStorage["__CLAUDE_EXTENSION_PROFILE_LOCALE__"]`
- current extension locale manifest cache:
  - `localStorage["__CLAUDE_EXTENSION_LOCALES_CACHE__"]`
- current runtime locale list:
  - `window.__CLAUDE_EXTENSION_LOCALES__`

### Array interception rule

The Array proxy still exists, but only for non-mutating paths.

Target heuristic:

- first item: `"en-US"`
- last item: `"id-ID"`

If matched, extension locales are appended into that array before the original function runs.

### Request strategy

The extension does not try to patch Claude’s root JS bundle or rewrite response bodies at the network layer via DevTools Protocol in the shipped product.

Instead, it works at stable semantic seams:

- account profile locale
- bootstrap locale
- experience locale query parameter
- i18n resource URLs
- language-array construction

## 8. Known gaps / next recommended steps

The session ended with the runtime and docs in place, but a few things were still explicitly not finished:

- no end-to-end live validation against real `claude.ai` was performed after the final architecture landed
- current interception path is built around `fetch`
  - if Claude moves any of the key endpoints to `XMLHttpRequest`, equivalent XHR interception still needs to be added
- the large runtime rewrite is not yet described in a persisted changelog commit in git
- some unrelated worktree changes already existed and were not cleaned up in this session

## 9. Current worktree context at the end of the session

At the time this report was written, the repository still contained additional unrelated or pre-existing modifications outside the core extension files, including:

- `.original/*` diffs
- README diffs
- asset moves
- deleted historical `notes/*` files in the current worktree

Because `notes/` was already absent in the working tree, this report was intentionally written to the repository root instead of recreating the old notes directory.

## 10. Files most relevant to today’s work

- [extension/manifest.json](/mnt/f/claude-web-i18n/extension/manifest.json:1)
- [extension/hook.js](/mnt/f/claude-web-i18n/extension/hook.js:1)
- [extension/script.js](/mnt/f/claude-web-i18n/extension/script.js:1)
- [extension/service.js](/mnt/f/claude-web-i18n/extension/service.js:1)
- [locales.json](/mnt/f/claude-web-i18n/locales.json:1)
- [build.sh](/mnt/f/claude-web-i18n/build.sh:1)
- [README.md](/mnt/f/claude-web-i18n/README.md:1)
- [README.en.md](/mnt/f/claude-web-i18n/README.en.md:1)
- [README.tw.md](/mnt/f/claude-web-i18n/README.tw.md:1)
