(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000,
		// Wait for the server to persist a finished message before re-reading it.
		POST_GENERATION_DELAY_MS: 1200,
		// How stale the usage rings may get before we ask for them ourselves.
		USAGE_POLL_MS: 60 * 1000
	});
})();
