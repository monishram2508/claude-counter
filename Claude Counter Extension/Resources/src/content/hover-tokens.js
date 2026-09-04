(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';
	const ROW_SELECTOR = '.group\\/message-row';
	// Screen-reader prefixes Claude injects into each row's text. We strip these
	// before matching DOM text against payload text.
	const SR_PREFIXES = [/^You said:\s*/i, /^Claude responded:\s*/i, /^Claude said:\s*/i];

	// ---- state ----
	let enabled = true;
	// Ordered trunk (root->leaf) of { uuid, sender, tokens, textKey } for the
	// current conversation. Rebuilt on each cc:conversation payload.
	let trunk = [];
	let installed = false;
	let tooltipEl = null;
	let lastEl = null; // avoid recompute while hovering the same message

	// ---- helpers reused from the payload shape (mirrors tokens.js walk) ----
	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tk = getTokenizer();
		if (!tk?.countTokens) return 0;
		try {
			return tk.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunkMessages(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}
		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const out = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			out.push(msg);
			currentId = msg.parent_message_uuid;
		}
		out.reverse();
		return out;
	}

	function stableStringify(value) {
		const seen = new WeakSet();
		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);
			if (Array.isArray(v)) return v.map(normalize);
			const out = {};
			for (const key of Object.keys(v).sort()) out[key] = normalize(v[key]);
			return out;
		};
		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';
		if (item.type === 'text' && typeof item.text === 'string') return item.text;
		if (item.type === 'tool_use') {
			return stableStringify({ id: item.id, name: item.name, input: item.input });
		}
		if (item.type === 'tool_result') {
			return stableStringify({ tool_use_id: item.tool_use_id, is_error: item.is_error, content: item.content });
		}
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	// Full countable text for a message — mirrors tokens.js so hover counts match
	// the context bar exactly (includes tool_use / tool_result / attachments).
	function messageCountableText(message) {
		const parts = [];
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) parts.push(a.extracted_content);
		}
		return parts.join('\n');
	}

	// Visible text only — used solely for DOM-matching against on-screen bubbles
	// (the SR text is plain prose, so tool JSON would never match anyway).
	function messageVisibleText(message) {
		const parts = [];
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
		}
		return parts.join('\n');
	}

	// Normalized comparison key: lowercase alnum, first N chars. Used to sanity-
	// check DOM-order matching against payload order.
	const KEY_LEN = 400;

	function makeKey(text, len) {
		return (text || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '')
			.slice(0, len || KEY_LEN);
	}

	function commonPrefixLen(a, b) {
		if (!a || !b) return 0;
		const n = Math.min(a.length, b.length);
		let i = 0;
		while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
		return i;
	}

	function setTrunk(conversation) {
		_stampCache = { value: null, at: 0 };
		const msgs = buildTrunkMessages(conversation);
		trunk = msgs.map((m) => {
			return {
				uuid: m?.uuid || null,
				// payload sender is 'human' | 'assistant'
				sender: m?.sender === 'assistant' ? 'assistant' : 'human',
				// full weight — matches the context bar (text + tools + attachments)
				tokens: countTokens(messageCountableText(m)),
				// visible text only — for matching against the on-screen bubble
				textKey: makeKey(messageVisibleText(m))
			};
		});
		lastEl = null;
		alignMap = new WeakMap();
		alignStamp = null;
	}

	// ---- DOM side ----
	function stripSrPrefix(text) {
		let t = (text || '').trim();
		for (const re of SR_PREFIXES) t = t.replace(re, '');
		return t;
	}

	function rowSender(row) {
		if (row.querySelector('[data-testid="user-message"]')) return 'human';
		if (row.querySelector('.font-claude-response')) return 'assistant';
		return null;
	}

	// Resolve a hovered row to a trunk entry.
	// Strategy: enumerate all rendered rows in DOM order, find the index of this
	// row AMONG rows of the same sender, then pick the Nth same-sender entry in
	// the trunk. Guard with a text-prefix check; if it disagrees, fall back to a
	// direct textKey search across same-sender entries.
	// The element holding the actual message content (excludes row chrome like
	// action buttons / timestamps, which polluted the old matching key).
	const MSG_SELECTOR = '[data-testid="user-message"], .font-claude-response';

	function findMessageEl(target) {
		if (!target || !target.closest) return null;
		const direct = target.closest(MSG_SELECTOR);
		if (direct) return direct;
		const row = target.closest(ROW_SELECTOR);
		if (!row) return null;
		return row.querySelector(MSG_SELECTOR);
	}

	// ---- resolution by SEQUENCE ALIGNMENT ----
	// Rendered messages are always a contiguous window of the conversation, so we
	// align the whole visible run against the trunk in one pass and let neighbours
	// anchor each other. Per-message matching alone was too easily fooled by DOM
	// text that doesn't match the payload (buttons, artifacts, edited prompts).
	// DOM order within the window is reliable; absolute DOM index is not.

	let alignMap = new WeakMap();
	let alignStamp = null;

	function domMessageItems() {
		const els = [...document.querySelectorAll(MSG_SELECTOR)].filter((e) => e.offsetParent);
		return els.map((el) => ({
			el,
			sender: el.matches('[data-testid="user-message"]') ? 'human' : 'assistant',
			key: makeKey(stripSrPrefix(el.textContent))
		}));
	}

	function computeAlignment() {
		const items = domMessageItems();
		alignMap = new WeakMap();
		alignStamp = currentStamp();
		if (!items.length || !trunk.length) return;

		let bestOffset = -1;
		let bestScore = -1;
		let bestPairs = 0;

		for (let off = 0; off < trunk.length; off++) {
			let score = 0;
			let pairs = 0;
			let ok = true;
			for (let i = 0; i < items.length; i++) {
				const t = trunk[off + i];
				if (!t) break; // dom window extends past trunk (newest not fetched yet)
				if (t.sender !== items[i].sender) { ok = false; break; }
				score += commonPrefixLen(items[i].key, t.textKey);
				pairs++;
			}
			if (ok && pairs && score > bestScore) {
				bestScore = score;
				bestOffset = off;
				bestPairs = pairs;
			}
		}

		if (bestOffset < 0 || !bestPairs) return;

		// Require meaningful average agreement before trusting the alignment.
		const avg = bestScore / bestPairs;
		if (CC.__ccDebug) {
			console.log('[cc:hover] align offset=', bestOffset, 'pairs=', bestPairs,
				'avgScore=', Math.round(avg), 'domItems=', items.length, 'trunk=', trunk.length);
		}
		if (avg < 10) return;

		for (let i = 0; i < bestPairs; i++) {
			alignMap.set(items[i].el, trunk[bestOffset + i].tokens);
		}
	}

	// The stamp is a cheap change-detector for "did the message DOM or trunk
	// change since the last alignment?". It runs on every mousemove, so the
	// underlying querySelectorAll is cached for 500ms — alignment freshness a
	// half-second behind the DOM is invisible to a hovering user.
	let _stampCache = { value: null, at: 0 };

	function currentStamp() {
		const now = Date.now();
		if (_stampCache.value !== null && now - _stampCache.at < 500) return _stampCache.value;
		_stampCache = {
			value: `${document.querySelectorAll(MSG_SELECTOR).length}:${trunk.length}`,
			at: now
		};
		return _stampCache.value;
	}

	function resolveMessageEl(el) {
		// Recompute only when the DOM/trunk actually changed. (Recomputing when
		// the element merely wasn't in the map re-ran the full O(trunk × DOM)
		// alignment on every mousemove whenever alignment had failed.)
		if (alignStamp !== currentStamp()) computeAlignment();
		const v = alignMap.has(el) ? alignMap.get(el) : null;
		if (CC.__ccDebug && v == null) {
			console.log('[cc:hover] no match for element', el);
		}
		return v;
	}

	// Debug helper: dump DOM side vs payload side so mismatches are visible.
	function __dump() {
		const items = domMessageItems();
		console.log('=== TRUNK (payload) ===', trunk.length);
		trunk.forEach((t, i) => console.log(i, t.sender, 'tokens=', t.tokens,
			'key=', JSON.stringify((t.textKey || '').slice(0, 40))));
		console.log('=== DOM (rendered) ===', items.length);
		items.forEach((d, i) => console.log(i, d.sender,
			'key=', JSON.stringify((d.key || '').slice(0, 40)),
			'resolved=', alignMap.has(d.el) ? alignMap.get(d.el) : null));
		return { trunkLen: trunk.length, domLen: items.length };
	}

	function ensureTooltip() {
		if (tooltipEl) return tooltipEl;
		const el = document.createElement('div');
		el.className = 'cc-hover-token-tip';
		el.style.cssText = [
			'position:fixed',
			'z-index:2147483647',
			'pointer-events:none',
			'padding:3px 7px',
			'border-radius:6px',
			'font:600 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace',
			'background:rgba(20,20,22,0.94)',
			'color:#fff',
			'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
			'white-space:nowrap',
			'opacity:0',
			'transition:opacity 90ms ease',
			'top:0',
			'left:0'
		].join(';');
		(document.body || document.documentElement).appendChild(el);
		tooltipEl = el;
		return el;
	}

	function showTip(x, y, tokens) {
		const el = ensureTooltip();
		el.textContent = `${tokens.toLocaleString()} tokens`;
		// position slightly up-right of cursor, keep on-screen
		const pad = 12;
		let left = x + pad;
		let top = y + pad;
		const rect = el.getBoundingClientRect();
		if (left + rect.width + 4 > window.innerWidth) left = x - rect.width - pad;
		if (top + rect.height + 4 > window.innerHeight) top = y - rect.height - pad;
		el.style.left = `${Math.max(2, left)}px`;
		el.style.top = `${Math.max(2, top)}px`;
		el.style.opacity = '1';
	}

	function hideTip() {
		if (tooltipEl) tooltipEl.style.opacity = '0';
		lastEl = null;
	}

	let _lastTokens = null;

	function onMove(e) {
		if (!enabled) return;
		const el = findMessageEl(e.target);
		if (!el) {
			if (lastEl) hideTip();
			return;
		}
		if (el !== lastEl) {
			lastEl = el;
			_lastTokens = resolveMessageEl(el);
		}
		if (_lastTokens == null) {
			if (tooltipEl) tooltipEl.style.opacity = '0';
			return;
		}
		showTip(e.clientX, e.clientY, _lastTokens);
	}

	function onLeaveDoc() {
		hideTip();
	}

	function install() {
		if (installed) return;
		installed = true;
		document.addEventListener('mousemove', onMove, { passive: true });
		document.addEventListener('mouseleave', onLeaveDoc, { passive: true });
	}

	function setEnabled(v) {
		enabled = !!v;
		if (!enabled) hideTip();
	}

	CC.hoverTokens = { setTrunk, install, setEnabled, __dump };
})();
