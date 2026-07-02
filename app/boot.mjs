// External module loader for @onsite/core (no inline scripts — the app CSP has script-src 'self' only).
import * as Core from "./core.bundle.js?v=2";
window.OnSiteCore = Core;
