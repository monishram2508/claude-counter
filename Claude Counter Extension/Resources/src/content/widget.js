(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	const SVGNS = 'http://www.w3.org/2000/svg';

	// ---- formatting helpers ----

	function pad(n) {
		return String(n).padStart(2, '0');
	}

	function splitCountdown(timestampMs) {
		let diffMs = timestampMs - Date.now();
		if (diffMs < 0) diffMs = 0;
		const total = Math.floor(diffMs / 1000);
		return {
			days: Math.floor(total / 86400),
			hours: Math.floor((total % 86400) / 3600),
			minutes: Math.floor((total % 3600) / 60),
			seconds: total % 60
		};
	}

	function formatLastPrompt(ms, is24h) {
		if (!ms) return null;
		const d = new Date(ms);
		const y = d.getFullYear();
		const mo = pad(d.getMonth() + 1);
		const da = pad(d.getDate());
		let hh = d.getHours();
		const mm = pad(d.getMinutes());
		if (is24h) {
			return `${y}-${mo}-${da} ${pad(hh)}:${mm}`;
		}
		const ampm = hh >= 12 ? 'PM' : 'AM';
		hh = hh % 12 || 12;
		return `${y}-${mo}-${da} ${hh}:${mm} ${ampm}`;
	}

	// ---- SVG ring construction ----
	// Builds a ring where the filled arc represents `pct`, with optional gaps every
	// `tickSpacing` percent. Uses stroke-dasharray on circles.

	function describeRing(svg, opts) {
		const { size, thicknessPct } = opts;
		const cx = size / 2;
		const cy = size / 2;
		const stroke = (thicknessPct / 100) * (size / 2) * 2; // thickness in px
		const clampedStroke = Math.max(2, Math.min(size / 2 - 1, stroke));
		const r = (size - clampedStroke) / 2;

		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
		svg.setAttribute('width', size);
		svg.setAttribute('height', size);

		return { cx, cy, r, stroke: clampedStroke, circumference: 2 * Math.PI * r };
	}

	class Ring {
		constructor(size) {
			this.size = size;
			this.svg = document.createElementNS(SVGNS, 'svg');
			this.svg.classList.add('cc-ring');
			// rotate so 0% starts at top (12 o'clock) and fills clockwise
			this.g = document.createElementNS(SVGNS, 'g');
			this.trackCircle = document.createElementNS(SVGNS, 'circle');
			this.fillCircle = document.createElementNS(SVGNS, 'circle');
			this.g.appendChild(this.trackCircle);
			this.g.appendChild(this.fillCircle);
			this.svg.appendChild(this.g);

			// centered percentage text (HTML overlay handled by widget, not SVG,
			// so it uses the page font cleanly)
			this.geom = null;
		}

		layout(thicknessPct, roundedCaps) {
			this.geom = describeRing(this.svg, { size: this.size, thicknessPct });
			const { cx, cy, r, stroke } = this.geom;

			for (const c of [this.trackCircle, this.fillCircle]) {
				c.setAttribute('cx', cx);
				c.setAttribute('cy', cy);
				c.setAttribute('r', r);
				c.setAttribute('fill', 'none');
				c.setAttribute('stroke-width', stroke);
			}
			this.fillCircle.setAttribute('stroke-linecap', roundedCaps ? 'round' : 'butt');
			this.trackCircle.setAttribute('stroke-linecap', 'butt');

			// start at top, go clockwise
			this.g.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
		}

		// pct 0..100; colors {fill, track}; tickSpacing percent (0 = none)
		render(pct, colors, tickSpacing, markerPct) {
			if (!this.geom) return;
			const { circumference } = this.geom;
			const clamped = Math.max(0, Math.min(100, pct));

			this.trackCircle.setAttribute('stroke', colors.track);
			this.fillCircle.setAttribute('stroke', colors.fill);

			// Fill arc via dasharray: visible length then gap for the rest.
			const filledLen = (clamped / 100) * circumference;
			this.fillCircle.setAttribute('stroke-dasharray', `${filledLen} ${circumference - filledLen}`);
			this.fillCircle.setAttribute('stroke-dashoffset', '0');

			// Ticks: overlay small gaps by drawing a dashed mask circle on top in the
			// track/background color at each tick boundary. Simpler + robust approach:
			// draw tick marks as short radial gaps using a dasharray on a separate circle.
			this._renderTicks(tickSpacing, colors);

			// Time-progress marker: a thin radial line at the elapsed fraction of the
			// window, crossing the ring band. Drawn last so it sits on top.
			this._renderMarker(markerPct, colors);
		}

		_renderMarker(markerPct, colors) {
			if (this._markerLine) {
				this._markerLine.remove();
				this._markerLine = null;
			}
			if (markerPct == null || markerPct < 0) return;

			const { cx, cy, r, stroke } = this.geom;
			// The group is rotated -90deg so angle 0 points up (12 o'clock) and
			// increases clockwise. Convert pct -> radians in that rotated frame:
			// place the marker along +X in the rotated group (which is "up" on screen).
			const frac = Math.max(0, Math.min(1, markerPct / 100));
			const angle = frac * 2 * Math.PI; // radians clockwise from top (in group frame)
			// In the rotated group, x-axis = screen up. A point at `angle` clockwise:
			const px = cx + Math.cos(angle) * (r);
			const py = cy + Math.sin(angle) * (r);
			// radial direction (unit vector from center to point)
			const dx = Math.cos(angle);
			const dy = Math.sin(angle);
			const half = stroke / 2 + 1.5; // extend slightly beyond the band
			const x1 = cx + dx * (r - half);
			const y1 = cy + dy * (r - half);
			const x2 = cx + dx * (r + half);
			const y2 = cy + dy * (r + half);

			const line = document.createElementNS(SVGNS, 'line');
			line.setAttribute('x1', x1);
			line.setAttribute('y1', y1);
			line.setAttribute('x2', x2);
			line.setAttribute('y2', y2);
			line.setAttribute('stroke', colors.marker || '#ffffff');
			line.setAttribute('stroke-width', '2');
			line.setAttribute('stroke-linecap', 'round');

			this._markerLine = line;
			this.g.appendChild(line);
		}

		_renderTicks(tickSpacing, colors) {
			if (this._tickCircle) {
				this._tickCircle.remove();
				this._tickCircle = null;
			}
			if (!tickSpacing || tickSpacing <= 0) return;

			const { cx, cy, r, stroke, circumference } = this.geom;
			const tick = document.createElementNS(SVGNS, 'circle');
			tick.setAttribute('cx', cx);
			tick.setAttribute('cy', cy);
			tick.setAttribute('r', r);
			tick.setAttribute('fill', 'none');
			tick.setAttribute('stroke', colors.gapColor || '#1a1a1a');
			tick.setAttribute('stroke-width', stroke + 2);
			tick.setAttribute('stroke-linecap', 'butt');

			// Number of ticks = 100 / spacing. Each tick is a tiny gap.
			const count = Math.round(100 / tickSpacing);
			const gapPx = 2.2; // width of each slit
			const segLen = circumference / count;
			// dash pattern: (segLen - gapPx) drawn as gapColor? No — we want gaps to
			// show the page background *through* the ring. Instead we punch holes by
			// drawing gapColor slits over both track and fill.
			tick.setAttribute('stroke-dasharray', `${gapPx} ${segLen - gapPx}`);
			// offset so a tick sits exactly at the top (0%)
			tick.setAttribute('stroke-dashoffset', gapPx / 2);

			this._tickCircle = tick;
			this.g.appendChild(tick);
		}
	}

	// ---- Segmented clock (DD:HH:MM:SS) using tabular figures ----

	function buildSegmentedClock(showDays) {
		const wrap = document.createElement('div');
		wrap.className = 'cc-clock';

		const fields = [];
		const specs = showDays
			? [['d', 'days'], ['h', 'hours'], ['m', 'minutes'], ['s', 'seconds']]
			: [['h', 'hours'], ['m', 'minutes'], ['s', 'seconds']];

		specs.forEach(([key, name], i) => {
			if (i > 0) {
				const sep = document.createElement('span');
				sep.className = 'cc-clock__sep';
				sep.textContent = ':';
				wrap.appendChild(sep);
			}
			const field = document.createElement('span');
			field.className = 'cc-clock__field';
			field.textContent = '00';
			wrap.appendChild(field);
			fields.push({ key, name, el: field });
		});

		return { wrap, fields };
	}

	function updateClock(clock, parts) {
		for (const f of clock.fields) {
			const v = parts[f.name] ?? 0;
			const text = pad(v);
			if (f.el.textContent !== text) f.el.textContent = text;
		}
	}

	// ---- The widget ----

	class Widget {
		constructor() {
			this.root = null;
			this.settings = CC.settings.get();

			this.sessionRing = null;
			this.weeklyRing = null;
			this.sessionPctEl = null;
			this.weeklyPctEl = null;
			this.sessionClock = null;
			this.weeklyClock = null;
			this.sessionBlock = null;
			this.weeklyBlock = null;

			this.tokenValueEl = null;
			this.tokenBarFill = null;
			this.tokenBarWrap = null;
			this.lastPromptEl = null;
			this.cacheRow = null;
			this.tokenRow = null;
			this.lastPromptRow = null;
			this.chatBlock = null;

			// live data
			this.sessionUtil = null;
			this.weeklyUtil = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.totalTokens = null;
			this.lastPromptMs = null;
			this.cachedUntilMs = null;

			this.ringSize = 96;
			this.sidePanelOpen = false;
			this.pageAllowed = true; // false on non-chat claude.ai pages
			this.detectedLimit = null; // context limit inferred from the model id
			this._panelObserver = null;
		}

		_colors() {
			const s = this.settings;
			return {
				fill: s.fillColor,
				track: s.trackColor,
				warn: s.warnColor,
				tick: s.tickColor,
				text: s.textColor,
				marker: s.markerColor,
				// gap color = try to match page background; fall back to near-black.
				gapColor: this._pageBg()
			};
		}

		_pageBg() {
			// The slits in the ring should read as the widget's own backdrop, not the
			// page behind it. The panel background is a translucent tint over the page;
			// sampling the panel's computed background gives the closest match so the
			// slit doesn't look like a mismatched color.
			try {
				if (this.root) {
					const bg = getComputedStyle(this.root).backgroundColor;
					if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
				}
				const bodyBg = getComputedStyle(document.body).backgroundColor;
				if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent') return bodyBg;
			} catch {
				// ignore
			}
			return '#1a1a1a';
		}

		// Detect whether a side panel (documents list / artifact or document viewer)
		// is open, so we can hide the widget to avoid overlap.
		//
		// Strategy: geometric, not name-based. Earlier versions guessed selectors
		// and aria-labels, which false-fired on always-present buttons. Instead we
		// look for a large panel-like element (big, tall, right-side, above the
		// chat surface) that overlaps the widget's own rectangle. If nothing
		// overlaps the widget, there is nothing to avoid — stay visible.
		// Fail-open: any uncertainty = show.
		_detectSidePanel() {
			try {
				if (!this.root) return false;
				const w = this.root.getBoundingClientRect();
				if (w.width === 0) {
					// widget currently hidden: use its configured position instead
					// (approximate rect from settings so we can decide to re-show)
					const s = this.settings;
					const width = s.widgetWidth || 250;
					const height = 340;
					const top = s.corner.startsWith('top') ? s.offsetY : window.innerHeight - s.offsetY - height;
					const left = s.corner.endsWith('right')
						? window.innerWidth - s.offsetX - width
						: s.offsetX;
					return this._anyPanelOverlaps({ top, left, right: left + width, bottom: top + height });
				}
				return this._anyPanelOverlaps(w);
			} catch {
				return false; // fail open
			}
		}

		_anyPanelOverlaps(rect) {
			// A "panel" = an element that is (a) at least 260px wide and 45% of the
			// viewport tall, (b) positioned in the right portion of the screen, and
			// (c) actually overlaps the widget's rectangle. Rather than scanning
			// every div on the page (which forced layout on thousands of elements
			// several times a second while Claude streams), hit-test a few points
			// inside the widget's own rect: document.elementsFromPoint returns the
			// full stack of elements rendered at a point, which is exactly the set
			// that can overlap us there.
			const vh = window.innerHeight;
			const vw = window.innerWidth;
			const points = [
				[(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2],
				[rect.left + 4, rect.top + 4],
				[rect.right - 4, rect.bottom - 4]
			];
			const seen = new Set();
			for (const [x, y] of points) {
				if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
				for (const el of document.elementsFromPoint(x, y)) {
					if (seen.has(el)) continue;
					seen.add(el);
					if (el === this.root || this.root.contains(el) || el.contains(this.root)) continue;
					const r = el.getBoundingClientRect();
					if (r.width < 260 || r.height < vh * 0.45) continue; // too small to be a panel
					if (r.left < vw * 0.4) continue; // panel sits in the right portion
					if (r.width > vw * 0.95) continue; // not a full-width wrapper / the app root
					return true;
				}
			}
			return false;
		}

		_watchSidePanel() {
			if (this._panelObserver) return;
			let debounceTimer = null;
			const recheck = () => {
				if (document.hidden) return; // nothing visible to avoid; recheck on next mutation
				const open = this._detectSidePanel();
				if (CC.__ccDebug) {
					console.log('[CC] panel check:', {
						open,
						widgetHiddenNow: this.sidePanelOpen,
						innerWidth: window.innerWidth,
						innerHeight: window.innerHeight
					});
				}
				if (open !== this.sidePanelOpen) {
					this.sidePanelOpen = open;
					this._applyVisibility();
				}
			};
			const scheduleRecheck = () => {
				if (debounceTimer) return;
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					recheck();
				}, 400);
			};
			this._panelObserver = new MutationObserver(scheduleRecheck);
			this._panelObserver.observe(document.body, { childList: true, subtree: true });
			window.addEventListener('resize', () => {
				this._applyPosition();
				scheduleRecheck();
			});
			recheck();
		}

		// Central visibility: hidden if disabled, on a non-chat page, or when a
		// side panel is open.
		_applyVisibility() {
			if (!this.root) return;
			const hidden = !this.settings.enabled || !this.pageAllowed || this.sidePanelOpen;
			this.root.classList.toggle('cc-hidden', hidden);
		}

		setPageAllowed(allowed) {
			this.pageAllowed = !!allowed;
			this._applyVisibility();
		}

		// Context limit inferred from the observed model id (null = unknown).
		setContextLimit(limit) {
			const v = typeof limit === 'number' && limit > 0 ? limit : null;
			if (v === this.detectedLimit) return;
			this.detectedLimit = v;
			this._renderChat();
		}

		build() {
			if (this.root) return;
			const s = this.settings;

			this.root = document.createElement('div');
			this.root.className = 'cc-widget';
			this.root.setAttribute('data-cc-widget', 'true');

			// --- rings row ---
			const ringsRow = document.createElement('div');
			ringsRow.className = 'cc-widget__rings';

			this.sessionBlock = this._buildRingBlock('Session', 'session');
			this.weeklyBlock = this._buildRingBlock('Weekly', 'weekly');
			ringsRow.appendChild(this.sessionBlock.block);
			ringsRow.appendChild(this.weeklyBlock.block);

			this.sessionRing = this.sessionBlock.ring;
			this.sessionPctEl = this.sessionBlock.pctEl;
			this.sessionClock = this.sessionBlock.clock;
			this.weeklyRing = this.weeklyBlock.ring;
			this.weeklyPctEl = this.weeklyBlock.pctEl;
			this.weeklyClock = this.weeklyBlock.clock;

			this.root.appendChild(ringsRow);

			// --- divider ---
			const divider = document.createElement('div');
			divider.className = 'cc-widget__divider';
			this.root.appendChild(divider);
			this.chatDivider = divider;

			// --- chat info block ---
			this.chatBlock = document.createElement('div');
			this.chatBlock.className = 'cc-widget__chat';

			// token bar row
			this.tokenRow = document.createElement('div');
			this.tokenRow.className = 'cc-chatRow';
			const tokenLabel = document.createElement('div');
			tokenLabel.className = 'cc-chatRow__label';
			tokenLabel.textContent = 'context';
			this.tokenValueEl = document.createElement('div');
			this.tokenValueEl.className = 'cc-chatRow__value';
			this.tokenValueEl.textContent = '—';
			const tokenTop = document.createElement('div');
			tokenTop.className = 'cc-chatRow__top';
			tokenTop.appendChild(tokenLabel);
			tokenTop.appendChild(this.tokenValueEl);
			this.tokenBarWrap = document.createElement('div');
			this.tokenBarWrap.className = 'cc-tokenBar';
			this.tokenBarFill = document.createElement('div');
			this.tokenBarFill.className = 'cc-tokenBar__fill';
			this.tokenBarWrap.appendChild(this.tokenBarFill);
			this.tokenRow.appendChild(tokenTop);
			this.tokenRow.appendChild(this.tokenBarWrap);
			this.chatBlock.appendChild(this.tokenRow);

			// last prompt row
			this.lastPromptRow = document.createElement('div');
			this.lastPromptRow.className = 'cc-chatRow cc-chatRow--inline';
			const lpLabel = document.createElement('span');
			lpLabel.className = 'cc-chatRow__label';
			lpLabel.textContent = 'last prompt';
			this.lastPromptEl = document.createElement('span');
			this.lastPromptEl.className = 'cc-chatRow__value cc-mono';
			this.lastPromptEl.textContent = '—';
			this.lastPromptRow.appendChild(lpLabel);
			this.lastPromptRow.appendChild(this.lastPromptEl);
			this.chatBlock.appendChild(this.lastPromptRow);

			// cache countdown row
			this.cacheRow = document.createElement('div');
			this.cacheRow.className = 'cc-chatRow cc-chatRow--inline';
			const cacheLabel = document.createElement('span');
			cacheLabel.className = 'cc-chatRow__label';
			cacheLabel.textContent = 'cache';
			this.cacheClockValue = document.createElement('span');
			this.cacheClockValue.className = 'cc-chatRow__value cc-mono';
			this.cacheClockValue.textContent = '—';
			this.cacheRow.appendChild(cacheLabel);
			this.cacheRow.appendChild(this.cacheClockValue);
			this.chatBlock.appendChild(this.cacheRow);

			this.root.appendChild(this.chatBlock);

			document.body.appendChild(this.root);

			this.applySettings(this.settings);
			this._renderAll();
			this._watchSidePanel();
		}

		_buildRingBlock(title, kind) {
			const block = document.createElement('div');
			block.className = `cc-ringBlock cc-ringBlock--${kind}`;

			const titleEl = document.createElement('div');
			titleEl.className = 'cc-ringBlock__title';
			titleEl.textContent = title;

			const ringWrap = document.createElement('div');
			ringWrap.className = 'cc-ringBlock__ringWrap';

			const ring = new Ring(this.ringSize);
			ringWrap.appendChild(ring.svg);

			const pctEl = document.createElement('div');
			pctEl.className = 'cc-ringBlock__pct';
			pctEl.textContent = '0%';
			ringWrap.appendChild(pctEl);

			const clock = buildSegmentedClock(this.settings.clockShowDays);
			clock.wrap.classList.add('cc-ringBlock__clock');

			block.appendChild(titleEl);
			block.appendChild(ringWrap);
			block.appendChild(clock.wrap);

			return { block, ring, pctEl, clock };
		}

		applySettings(s) {
			this.settings = s;
			if (!this.root) return;

			const c = this._colors();

			// master enable (combined with side-panel state)
			this._applyVisibility();

			// text color
			this.root.style.setProperty('--cc-text', c.text);
			this.root.style.setProperty('--cc-fill', c.fill);
			this.root.style.setProperty('--cc-track', c.track);
			this.root.style.setProperty('--cc-warn', c.warn);
			this.root.style.setProperty('--cc-tick', c.tick);

			// width
			this.root.style.width = `${s.widgetWidth}px`;

			// position (clamped to the viewport)
			this._applyPosition();

			// ring layout
			if (this.sessionRing) this.sessionRing.layout(s.ringThickness, s.roundedCaps);
			if (this.weeklyRing) this.weeklyRing.layout(s.ringThickness, s.roundedCaps);

			// show/hide rings
			this.sessionBlock.block.classList.toggle('cc-hidden', !s.showSessionRing);
			this.weeklyBlock.block.classList.toggle('cc-hidden', !s.showWeeklyRing);

			// show/hide chat rows
			this.tokenRow.classList.toggle('cc-hidden', !s.showTokenBar);
			this.lastPromptRow.classList.toggle('cc-hidden', !s.showLastPrompt);
			this.cacheRow.classList.toggle('cc-hidden', !s.showCacheCountdown);

			// hide the chat block + divider entirely if nothing in it is shown
			const anyChat = s.showTokenBar || s.showLastPrompt || s.showCacheCountdown;
			this.chatBlock.classList.toggle('cc-hidden', !anyChat);
			this.chatDivider.classList.toggle('cc-hidden', !anyChat);

			// rebuild clocks if day-visibility changed
			this._syncClockFields(this.sessionClock, s.clockShowDays, this.sessionBlock);
			this._syncClockFields(this.weeklyClock, s.clockShowDays, this.weeklyBlock);

			this._renderAll();
		}

		// Adaptive positioning: apply the configured corner + offsets, but clamp
		// them so the widget always stays fully on-screen. A small display (or a
		// window resize) with a large saved offset would otherwise push the widget
		// partly or entirely out of view.
		_applyPosition() {
			if (!this.root) return;
			const s = this.settings;
			this.root.style.top = '';
			this.root.style.bottom = '';
			this.root.style.left = '';
			this.root.style.right = '';
			const vertical = s.corner.startsWith('top') ? 'top' : 'bottom';
			const horizontal = s.corner.endsWith('right') ? 'right' : 'left';

			const margin = 8;
			const rect = this.root.getBoundingClientRect();
			const height = rect.height || 340;
			const width = s.widgetWidth || rect.width || 250;
			const maxY = Math.max(0, window.innerHeight - height - margin);
			const maxX = Math.max(0, window.innerWidth - width - margin);
			const y = Math.min(Math.max(0, s.offsetY || 0), maxY);
			const x = Math.min(Math.max(0, s.offsetX || 0), maxX);
			this.root.style[vertical] = `${y}px`;
			this.root.style[horizontal] = `${x}px`;
		}

		_syncClockFields(clock, showDays, block) {
			const hasDays = clock.fields.some((f) => f.name === 'days');
			if (hasDays === showDays) return;
			const fresh = buildSegmentedClock(showDays);
			fresh.wrap.classList.add('cc-ringBlock__clock');
			clock.wrap.replaceWith(fresh.wrap);
			// mutate in place so references in block stay valid
			clock.wrap = fresh.wrap;
			clock.fields = fresh.fields;
		}

		// ---- data setters ----

		setUsage(usage) {
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;

			this.sessionUtil = session && typeof session.utilization === 'number' ? session.utilization : null;
			this.sessionResetMs = session?.resets_at ? Date.parse(session.resets_at) : null;

			this.weeklyUtil = weekly && typeof weekly.utilization === 'number' ? weekly.utilization : null;
			this.weeklyResetMs = weekly?.resets_at ? Date.parse(weekly.resets_at) : null;

			this._renderRings();
			this._renderClocks();
		}

		setConversationMetrics({ totalTokens, lastPromptMs, cachedUntil } = {}) {
			this.totalTokens = typeof totalTokens === 'number' ? totalTokens : null;
			this.lastPromptMs = typeof lastPromptMs === 'number' ? lastPromptMs : null;
			this.cachedUntilMs = typeof cachedUntil === 'number' ? cachedUntil : null;
			this._renderChat();
		}

		// ---- rendering ----

		_renderAll() {
			this._renderRings();
			this._renderClocks();
			this._renderChat();
		}

		_renderRings() {
			if (!this.root) return;
			const c = this._colors();
			const s = this.settings;

			// Window lengths (ms): session = 5h, weekly = 7d. The elapsed fraction is
			// (now - windowStart) / windowLength, where windowStart = resetAt - length.
			const SESSION_MS = 5 * 60 * 60 * 1000;
			const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

			const elapsedPct = (resetMs, lengthMs) => {
				if (!resetMs) return null;
				const start = resetMs - lengthMs;
				const frac = (Date.now() - start) / lengthMs;
				if (!isFinite(frac)) return null;
				return Math.max(0, Math.min(100, frac * 100));
			};

			const renderOne = (ring, pctEl, util, markerPct) => {
				if (!ring) return;
				const pct = util ?? 0;
				const warn = pct >= s.warnThreshold;
				const fill = warn ? c.warn : c.fill;
				ring.render(
					pct,
					{ fill, track: c.track, gapColor: c.gapColor, marker: c.marker },
					s.tickSpacing,
					s.showTimeMarker ? markerPct : null
				);
				pctEl.textContent = `${Math.round(pct)}%`;
				pctEl.classList.toggle('cc-warn', warn);
				if (s.warnStyle === 'pulse') {
					pctEl.classList.toggle('cc-pulse', warn);
					ring.svg.classList.toggle('cc-pulse', warn);
				} else {
					pctEl.classList.remove('cc-pulse');
					ring.svg.classList.remove('cc-pulse');
				}
			};

			renderOne(
				this.sessionRing,
				this.sessionPctEl,
				this.sessionUtil,
				elapsedPct(this.sessionResetMs, SESSION_MS)
			);
			renderOne(
				this.weeklyRing,
				this.weeklyPctEl,
				this.weeklyUtil,
				elapsedPct(this.weeklyResetMs, WEEKLY_MS)
			);
		}

		_renderClocks() {
			if (this.sessionResetMs) {
				updateClock(this.sessionClock, splitCountdown(this.sessionResetMs));
			} else {
				updateClock(this.sessionClock, { days: 0, hours: 0, minutes: 0, seconds: 0 });
			}
			if (this.weeklyResetMs) {
				updateClock(this.weeklyClock, splitCountdown(this.weeklyResetMs));
			} else {
				updateClock(this.weeklyClock, { days: 0, hours: 0, minutes: 0, seconds: 0 });
			}
		}

		_renderChat() {
			if (!this.root) return;
			const s = this.settings;

			// token bar
			if (this.totalTokens != null) {
				const scale = (s.autoContextScale !== false && this.detectedLimit)
					? this.detectedLimit
					: (s.contextScale || 200000);
				const pct = Math.max(0, Math.min(100, (this.totalTokens / scale) * 100));
				this.tokenBarFill.style.width = `${pct}%`;
				this.tokenValueEl.textContent = `${this.totalTokens.toLocaleString()} / ${scale.toLocaleString()}`;
				this.tokenBarFill.classList.toggle('cc-warn', pct >= s.warnThreshold);
			} else {
				this.tokenBarFill.style.width = '0%';
				this.tokenValueEl.textContent = '—';
				this.tokenBarFill.classList.remove('cc-warn');
			}

			// last prompt
			const lp = formatLastPrompt(this.lastPromptMs, s.lastPromptClock24h);
			this.lastPromptEl.textContent = lp || '—';

			// cache handled in tick()
			this._renderCache();
		}

		_renderCache() {
			const now = Date.now();
			if (this.cachedUntilMs && this.cachedUntilMs > now) {
				const parts = splitCountdown(this.cachedUntilMs);
				const mins = parts.days * 24 * 60 + parts.hours * 60 + parts.minutes;
				this.cacheClockValue.textContent = `${pad(mins)}:${pad(parts.seconds)}`;
				this.cacheClockValue.classList.remove('cc-muted');
			} else {
				this.cacheClockValue.textContent = '—';
				this.cacheClockValue.classList.add('cc-muted');
			}
		}

		// called every second
		tick() {
			this._renderClocks();
			this._renderCache();
			// The time-progress marker advances slowly; re-render rings about once a
			// minute so the marker creeps forward without wasting work each second.
			this._tickCounter = (this._tickCounter || 0) + 1;
			if (this._tickCounter % 60 === 0) {
				this._renderRings();
			}
		}

		// re-detect page bg (theme change) and re-render ring gaps
		refreshTheme() {
			this._renderRings();
		}
	}

	CC.widget = new Widget();
})();
