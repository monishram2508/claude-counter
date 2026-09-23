(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const STORAGE_KEY = 'cc_settings_v1';

	// The single source of truth for defaults. Popup and widget both read this.
	const DEFAULTS = Object.freeze({
		// master
		enabled: true,

		// which palette to paint with. 'auto' follows claude.ai's own light/dark
		// setting; the other two pin the widget to one palette regardless.
		themeMode: 'auto', // 'auto' | 'dark' | 'light'

		// colors — dark mode (the unsuffixed keys are the dark palette, kept
		// under their original names so existing saved settings still apply)
		fillColor: '#af6143',
		trackColor: '#4a4340',
		warnColor: '#ce2029',
		tickColor: 'rgba(255,255,255,0.35)',
		textColor: '#ffffff',
		markerColor: '#ffffff',

		// colors — light mode. Warm neutrals to sit on claude.ai's off-white,
		// with near-black text/marker so nothing washes out.
		fillColorLight: '#b5613c',
		trackColorLight: '#ddd7cc',
		warnColorLight: '#c0242b',
		tickColorLight: 'rgba(0,0,0,0.22)',
		textColorLight: '#2b2925',
		markerColorLight: '#1a1918',

		// time-progress marker (radial line showing elapsed fraction of the window)
		showTimeMarker: true,

		// thresholds & behavior
		warnThreshold: 85,
		warnStyle: 'flat', // 'flat' | 'pulse'
		autoContextScale: true, // infer the context limit from the model id
		contextScale: 200000, // manual fallback when auto is off / model unknown

		// ring appearance
		ringThickness: 13, // percent of radius
		tickSpacing: 10, // 5 | 10 | 25 | 0 (off)
		roundedCaps: false,

		// widget position & size
		corner: 'top-right', // top-right | top-left | bottom-right | bottom-left
		offsetY: 54, // px from top (or bottom) edge
		offsetX: 16, // px from side edge
		widgetWidth: 250,

		// show/hide
		showOnlyInChats: true, // hide the widget on claude.ai pages that aren't chats
		showSessionRing: true,
		showWeeklyRing: true,
		showTokenBar: true,
		showLastPrompt: true,
		showCacheCountdown: true,
		showHoverTokens: true,

		// clock format
		clockShowDays: true, // always show DD field
		lastPromptClock24h: true // 24h vs 12h for last-prompt timestamp
	});

	function getStorage() {
		return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
	}

	let current = { ...DEFAULTS };
	const listeners = new Set();

	function notify() {
		for (const fn of listeners) {
			try {
				fn(current);
			} catch {
				// ignore listener errors
			}
		}
	}

	async function load() {
		const store = getStorage();
		if (!store) {
			current = { ...DEFAULTS };
			return current;
		}
		try {
			const result = await store.get(STORAGE_KEY);
			const saved = result?.[STORAGE_KEY];
			// Merge saved over defaults so new keys added in updates still get defaults.
			current = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
		} catch {
			current = { ...DEFAULTS };
		}
		return current;
	}

	async function save(patch) {
		current = { ...current, ...patch };
		const store = getStorage();
		if (store) {
			try {
				await store.set({ [STORAGE_KEY]: current });
			} catch {
				// ignore write failures; in-memory copy still updated
			}
		}
		notify();
		return current;
	}

	async function resetAll() {
		current = { ...DEFAULTS };
		const store = getStorage();
		if (store) {
			try {
				await store.set({ [STORAGE_KEY]: current });
			} catch {
				// ignore
			}
		}
		notify();
		return current;
	}

	function get() {
		return current;
	}

	function onChange(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	}

	// Live sync: when storage changes in another context (popup), update here.
	function watchStorage() {
		const area = globalThis.browser?.storage || globalThis.chrome?.storage || null;
		if (!area?.onChanged) return;
		area.onChanged.addListener((changes, areaName) => {
			if (areaName !== 'local') return;
			if (!changes[STORAGE_KEY]) return;
			const next = changes[STORAGE_KEY].newValue;
			if (next && typeof next === 'object') {
				current = { ...DEFAULTS, ...next };
				notify();
			}
		});
	}

	CC.settings = {
		DEFAULTS,
		STORAGE_KEY,
		load,
		save,
		resetAll,
		get,
		onChange,
		watchStorage
	};
})();
