(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	// Chat surfaces = the pages where the widget is useful. Everything else on
	// claude.ai (settings, projects, artifacts, recents, ...) hides the widget.
	// Allowlist rather than blocklist so new routes are hidden by default.
	function isChatSurface() {
		const p = window.location.pathname;
		return p === '/' || p === '/new' || p.startsWith('/chat/');
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);

		if (!fiveHour && !sevenDay) return null;
		return { five_hour: fiveHour, seven_day: sevenDay };
	}

	// ---- model → context limit ----
	// claude.ai model ids that offer a 1M context contain "1m"; everything else
	// gets the standard 200k. The widget falls back to the manual setting when
	// the model hasn't been observed yet or auto mode is off.
	let currentModel = null;

	function contextLimitForModel(model) {
		if (!model || typeof model !== 'string') return null;
		return model.toLowerCase().includes('1m') ? 1000000 : 200000;
	}

	function updateModel(model) {
		if (!model || typeof model !== 'string' || model === currentModel) return;
		currentModel = model;
		if (CC.widget) CC.widget.setContextLimit(contextLimitForModel(model));
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null; // last snapshot
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	function updatePageAllowed() {
		if (!CC.widget) return;
		const onlyChats = CC.settings ? CC.settings.get().showOnlyInChats !== false : true;
		CC.widget.setPageAllowed(!onlyChats || isChatSurface());
	}

	// Load persisted settings, then build UI. Watch for live changes from the popup.
	(async () => {
		if (CC.settings) {
			await CC.settings.load();
			CC.settings.watchStorage();
			CC.settings.onChange((next) => {
				if (CC.widget) CC.widget.applySettings(next);
				if (CC.sounds) CC.sounds.applySettings(next);
				if (CC.hoverTokens) CC.hoverTokens.setEnabled(next.showHoverTokens);
				updatePageAllowed();
			});
		}
		if (CC.widget) {
			CC.widget.build();
			if (CC.settings) CC.widget.applySettings(CC.settings.get());
		}
		if (CC.sounds && CC.settings) CC.sounds.applySettings(CC.settings.get());
		if (CC.hoverTokens) {
			CC.hoverTokens.install();
			CC.hoverTokens.setEnabled(CC.settings ? CC.settings.get().showHoverTokens : true);
		}
		updatePageAllowed();

		// Re-render ring gaps when the page theme flips.
		const themeObserver = new MutationObserver(() => {
			if (CC.widget) CC.widget.refreshTheme();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-mode', 'class', 'style']
		});
	})();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		if (CC.widget) CC.widget.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			if (CC.widget) CC.widget.setConversationMetrics({});
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
		} catch {
			// ignore
		}
	}

	function handleGenerationStart(payload) {
		updateModel(payload?.model);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		if (typeof data.model === 'string') updateModel(data.model);

		const metrics = await CC.tokens.computeConversationMetrics(data);
		if (CC.hoverTokens) CC.hoverTokens.setTrunk(data);
		if (CC.widget) {
			CC.widget.setConversationMetrics({
				totalTokens: metrics.totalTokens,
				lastPromptMs: metrics.lastAssistantMs,
				cachedUntil: metrics.cachedUntil
			});
		}
	}

	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');
	}

	function handleGenerationEnd() {
		// Answer completed → play the completed sound (gated on tab focus inside).
		if (CC.sounds) CC.sounds.playCompleted();
		// After a response finishes, an interactive choice widget may appear a beat
		// later (buttons render after message_stop). Check shortly after.
		scheduleInputRequiredCheck();
		// Re-fetch the conversation tree so the just-finished message is present in
		// our trunk (hover token counts + context metrics would otherwise be stale
		// until the next navigation or branch switch). Small delay so the server
		// has persisted the message.
		if (_postGenRefreshTimer) clearTimeout(_postGenRefreshTimer);
		_postGenRefreshTimer = setTimeout(() => {
			refreshConversation();
		}, 1200);
	}

	let _postGenRefreshTimer = null;

	// ---- input-required (interactive choice widget) detection ----
	// UNVERIFIED selectors: these have never been validated against a real
	// choice widget's DOM, and the substring matches can hit unrelated
	// elements. That is why soundOnInputRequired now DEFAULTS TO OFF — the
	// feature is opt-in until the selectors are confirmed against real markup.
	let _inputCheckTimer = null;
	let _lastInputSignature = null;

	function scheduleInputRequiredCheck() {
		if (_inputCheckTimer) clearTimeout(_inputCheckTimer);
		// give the DOM a moment to render the widget after message_stop
		_inputCheckTimer = setTimeout(runInputRequiredCheck, 600);
	}

	function runInputRequiredCheck() {
		try {
			const el = detectChoiceWidget();
			if (!el) return;
			// De-dupe: don't re-play for the same widget instance.
			const sig = el.getAttribute('data-cc-sig') || `${el.tagName}:${(el.textContent || '').slice(0, 40)}`;
			if (sig === _lastInputSignature) return;
			_lastInputSignature = sig;
			if (CC.sounds) CC.sounds.playInputRequired();
		} catch {
			// ignore
		}
	}

	// Returns the widget element if an interactive choice is present, else null.
	// Fail-safe: returns null (no sound) when unsure. See note above — the
	// selectors are unverified placeholders.
	function detectChoiceWidget() {
		const selectors = [
			'[data-testid*="option"]',
			'[data-testid*="choice"]',
			'[role="radiogroup"]',
			'button[data-choice]'
		];
		for (const sel of selectors) {
			const el = document.querySelector(sel);
			if (el && el.offsetParent !== null) return el;
		}
		return null;
	}

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);
	CC.bridge.on('cc:generation_end', handleGenerationEnd);

	async function handleUrlChange() {
		const previousConversationId = currentConversationId;
		currentConversationId = getConversationId();

		updatePageAllowed();

		// Conversation switched (including → new chat): clear the old chat's
		// metrics and hover data immediately instead of showing them while the
		// new conversation loads.
		if (currentConversationId !== previousConversationId) {
			if (CC.widget) CC.widget.setConversationMetrics({});
			if (CC.hoverTokens) CC.hoverTokens.setTrunk(null);
			_lastInputSignature = null;
		}

		if (!currentConversationId) return;

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level. Only fetch on first load or if stale.
		if (!usageState) await refreshUsage();
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// Initial attach + fetches
	handleUrlChange();

	function tick() {
		if (CC.widget) CC.widget.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		// Optional hourly safety refresh.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
