(() => {
	'use strict';

	// Single source of truth for defaults + storage key: settings.js, which
	// popup.html loads before this file. No more hand-synced duplicate.
	const STORAGE_KEY = globalThis.ClaudeCounter.settings.STORAGE_KEY;
	const DEFAULTS = globalThis.ClaudeCounter.settings.DEFAULTS;

	function storage() {
		return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
	}

	// tickColor is stored as an rgba() string; the popup edits only its alpha.
	function parseAlpha(rgba) {
		const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(rgba || '');
		if (m) return Math.round(parseFloat(m[1]) * 100);
		return 35;
	}
	function makeTickColor(alphaPct) {
		const a = Math.max(0, Math.min(1, alphaPct / 100));
		return `rgba(255,255,255,${a})`;
	}

	let state = { ...DEFAULTS };

	async function load() {
		const store = storage();
		if (!store) {
			state = { ...DEFAULTS };
			return;
		}
		try {
			const res = await store.get(STORAGE_KEY);
			const saved = res?.[STORAGE_KEY];
			state = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
		} catch {
			state = { ...DEFAULTS };
		}
	}

	async function persist() {
		const store = storage();
		if (!store) return;
		try {
			await store.set({ [STORAGE_KEY]: state });
		} catch {
			// ignore
		}
	}

	const $ = (id) => document.getElementById(id);

	// map: element id -> {get from state, set to state}
	function bindCheckbox(id, key) {
		const el = $(id);
		el.checked = !!state[key];
		el.addEventListener('change', () => {
			state[key] = el.checked;
			persist();
		});
	}

	function bindColor(id, key) {
		const el = $(id);
		el.value = state[key];
		el.addEventListener('input', () => {
			state[key] = el.value;
			persist();
		});
	}

	function bindSelect(id, key, numeric) {
		const el = $(id);
		el.value = String(state[key]);
		el.addEventListener('change', () => {
			state[key] = numeric ? Number(el.value) : el.value;
			persist();
		});
	}

	function bindNumber(id, key) {
		const el = $(id);
		el.value = state[key];
		el.addEventListener('change', () => {
			const v = Number(el.value);
			if (Number.isFinite(v)) {
				state[key] = v;
				persist();
			}
		});
	}

	function bindRange(id, key, valId, suffix) {
		const el = $(id);
		const valEl = valId ? $(valId) : null;
		el.value = state[key];
		if (valEl) valEl.textContent = `${state[key]}${suffix || ''}`;
		el.addEventListener('input', () => {
			state[key] = Number(el.value);
			if (valEl) valEl.textContent = `${el.value}${suffix || ''}`;
			persist();
		});
	}

	function bindAll() {
		// master
		bindCheckbox('enabled', 'enabled');

		// colors
		bindColor('fillColor', 'fillColor');
		bindColor('trackColor', 'trackColor');
		bindColor('warnColor', 'warnColor');
		bindColor('textColor', 'textColor');
		bindColor('markerColor', 'markerColor');

		// tick alpha (special)
		const tickEl = $('tickColorAlpha');
		const tickValEl = $('tickColorAlphaVal');
		const initAlpha = parseAlpha(state.tickColor);
		tickEl.value = initAlpha;
		tickValEl.textContent = `${initAlpha}%`;
		tickEl.addEventListener('input', () => {
			tickValEl.textContent = `${tickEl.value}%`;
			state.tickColor = makeTickColor(Number(tickEl.value));
			persist();
		});

		// behavior
		bindRange('warnThreshold', 'warnThreshold', 'warnThresholdVal', '%');
		bindSelect('warnStyle', 'warnStyle', false);
		bindCheckbox('autoContextScale', 'autoContextScale');
		bindNumber('contextScale', 'contextScale');

		// ring
		bindRange('ringThickness', 'ringThickness', 'ringThicknessVal', '%');
		bindSelect('tickSpacing', 'tickSpacing', true);
		bindCheckbox('roundedCaps', 'roundedCaps');

		// position
		bindSelect('corner', 'corner', false);
		bindNumber('offsetY', 'offsetY');
		bindNumber('offsetX', 'offsetX');
		bindNumber('widgetWidth', 'widgetWidth');

		// visibility
		bindCheckbox('showOnlyInChats', 'showOnlyInChats');
		bindCheckbox('showSessionRing', 'showSessionRing');
		bindCheckbox('showWeeklyRing', 'showWeeklyRing');
		bindCheckbox('showTokenBar', 'showTokenBar');
		bindCheckbox('showLastPrompt', 'showLastPrompt');
		bindCheckbox('showCacheCountdown', 'showCacheCountdown');
		bindCheckbox('showHoverTokens', 'showHoverTokens');
		bindCheckbox('showTimeMarker', 'showTimeMarker');

		// clock
		bindCheckbox('clockShowDays', 'clockShowDays');
		bindCheckbox('lastPromptClock24h', 'lastPromptClock24h');

		// sounds
		bindCheckbox('soundOnCompleted', 'soundOnCompleted');
		bindCheckbox('soundOnInputRequired', 'soundOnInputRequired');
		bindRange('soundVolume', 'soundVolume', 'soundVolumeVal', '%');

		// test buttons — play the sound directly from the popup (simplest + reliable;
		// no tabs permission or content-script round-trip needed).
		const runtimeForUrl = globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
		const playTest = (file) => {
			try {
				const url = runtimeForUrl?.getURL
					? runtimeForUrl.getURL(`src/sounds/${file}`)
					: `../sounds/${file}`;
				const a = new Audio(url);
				a.volume = Math.max(0, Math.min(1, (state.soundVolume ?? 70) / 100));
				a.play().catch(() => {});
			} catch {
				// ignore
			}
		};
		$('testCompleted').addEventListener('click', () => playTest(state.soundCompletedFile || 'glass.mp3'));
		$('testInput').addEventListener('click', () => playTest(state.soundInputFile || 'basso.mp3'));

		// reset
		$('reset').addEventListener('click', async () => {
			state = { ...DEFAULTS };
			await persist();
			// re-render controls from fresh state
			refreshControls();
		});
	}

	function refreshControls() {
		// re-set all control values from state without rebinding listeners
		$('enabled').checked = state.enabled;
		$('fillColor').value = state.fillColor;
		$('trackColor').value = state.trackColor;
		$('warnColor').value = state.warnColor;
		$('textColor').value = state.textColor;
		$('markerColor').value = state.markerColor;
		const a = parseAlpha(state.tickColor);
		$('tickColorAlpha').value = a;
		$('tickColorAlphaVal').textContent = `${a}%`;
		$('warnThreshold').value = state.warnThreshold;
		$('warnThresholdVal').textContent = `${state.warnThreshold}%`;
		$('warnStyle').value = state.warnStyle;
		$('autoContextScale').checked = state.autoContextScale;
		$('contextScale').value = state.contextScale;
		$('ringThickness').value = state.ringThickness;
		$('ringThicknessVal').textContent = `${state.ringThickness}%`;
		$('tickSpacing').value = String(state.tickSpacing);
		$('roundedCaps').checked = state.roundedCaps;
		$('corner').value = state.corner;
		$('offsetY').value = state.offsetY;
		$('offsetX').value = state.offsetX;
		$('widgetWidth').value = state.widgetWidth;
		$('showOnlyInChats').checked = state.showOnlyInChats;
		$('showSessionRing').checked = state.showSessionRing;
		$('showWeeklyRing').checked = state.showWeeklyRing;
		$('showTokenBar').checked = state.showTokenBar;
		$('showLastPrompt').checked = state.showLastPrompt;
		$('showCacheCountdown').checked = state.showCacheCountdown;
		$('showHoverTokens').checked = state.showHoverTokens;
		$('showTimeMarker').checked = state.showTimeMarker;
		$('clockShowDays').checked = state.clockShowDays;
		$('lastPromptClock24h').checked = state.lastPromptClock24h;
		$('soundOnCompleted').checked = state.soundOnCompleted;
		$('soundOnInputRequired').checked = state.soundOnInputRequired;
		$('soundVolume').value = state.soundVolume;
		$('soundVolumeVal').textContent = `${state.soundVolume}%`;
	}

	document.addEventListener('DOMContentLoaded', async () => {
		await load();
		bindAll();
	});
})();
