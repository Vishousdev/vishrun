import { installFetchExternalHandler } from './fetch-external';
import { installMacroResolveHandler } from './macro-resolve';
import { installMessageContentProcessor } from './message-content-processor';
import { installDispatchSlashHandler } from './dispatch-slash';
import { installThHelpersHandler } from './th-helpers';
import { installRegexTakeoverHandler } from './regex-takeover';
import { installHostReadHandler } from './host-read';

/**
 * Backend worker module. Vishrun is logically frontend-only, but the worker
 * must exist: its mere existence keeps the host's sandbox `corsProxy` bridge
 * alive, and it serves the frontend's backend-only needs — `fetch_external`
 * (CDN asset downloads via `spindle.cors`), `resolve_macros` (widget HTML
 * through `spindle.macros.resolve`), and the `/setvar` message content
 * processor. The host loads this with a bare `import()` and exposes the API as
 * `globalThis.spindle` first — no `setup(api)` callback — so registration runs
 * at module top level here; `setup()` stays as a no-op for the prior convention.
 */

installFetchExternalHandler();
installMacroResolveHandler();
installMessageContentProcessor();
installDispatchSlashHandler();
installThHelpersHandler();
installRegexTakeoverHandler();
installHostReadHandler();

export function setup(): void {
  // intentionally empty — registration happens at module top level (above).
}
