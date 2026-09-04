(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}

	// Resolve a packaged sound file to a usable URL.
	function soundUrl(file) {
		const runtime = getRuntime();
		try {
			if (runtime?.getURL) return runtime.getURL(`src/sounds/${file}`);
		} catch {
			// ignore
		}
		return null;
	}

	class Sounds {
		constructor() {
			this.settings = CC.settings ? CC.settings.get() : {};
			// Pre-create Audio elements so first play has no fetch delay.
			this._cache = new Map();
			this._unlocked = false;
			this._installUnlock();
		}

		// Safari (and other browsers) block Audio.play() unless it's tied to a real
		// user gesture. The completion sound fires from a network-stream callback
		// with no gesture, so it gets blocked even though the file is fine. To work
		// around this, the first time the user interacts with the page we "prime"
		// each sound by playing it muted for an instant — this marks the Audio
		// elements as user-approved, after which gesture-less .play() is allowed.
		_installUnlock() {
			const unlock = () => {
				if (this._unlocked) return;
				this._unlocked = true;
				const files = [
					this.settings.soundCompletedFile || 'glass.mp3',
					this.settings.soundInputFile || 'basso.mp3'
				];
				for (const file of files) {
					const a = this._audio(file);
					if (!a) continue;
					try {
						const prevMuted = a.muted;
						const prevVol = a.volume;
						a.muted = true;
						a.volume = 0;
						const p = a.play();
						const restore = () => {
							try {
								a.pause();
								a.currentTime = 0;
								a.muted = prevMuted;
								a.volume = prevVol;
							} catch {
								// ignore
							}
						};
						if (p && typeof p.then === 'function') {
							p.then(restore).catch(restore);
						} else {
							restore();
						}
					} catch {
						// ignore
					}
				}
				// One-shot: remove listeners after first gesture.
				window.removeEventListener('pointerdown', unlock, true);
				window.removeEventListener('keydown', unlock, true);
			};
			// Capture-phase so we see the gesture even if the page stops propagation.
			window.addEventListener('pointerdown', unlock, true);
			window.addEventListener('keydown', unlock, true);
		}

		applySettings(s) {
			this.settings = s;
		}

		_audio(file) {
			if (this._cache.has(file)) return this._cache.get(file);
			const url = soundUrl(file);
			if (!url) return null;
			const a = new Audio(url);
			a.preload = 'auto';
			this._cache.set(file, a);
			return a;
		}

		// core play with volume + visibility gate. `force` bypasses the gate (used by
		// the popup "test" buttons). Normal sounds play only when the tab is NOT the
		// focused one — the idea is to ping you when you've looked away, and stay
		// silent when you're already watching the response finish.
		_play(file, { force = false } = {}) {
			const s = this.settings;
			// "Looking at it" = tab visible AND the window has focus. If either is
			// false (switched tab, minimized, or switched to another app), we treat
			// it as looked-away and DO play. force bypasses this for the test button.
			if (!force) {
				const lookingAtIt = document.visibilityState === 'visible' && document.hasFocus();
				if (lookingAtIt) return;
			}

			const a = this._audio(file);
			if (!a) return;
			try {
				a.currentTime = 0;
				a.volume = Math.max(0, Math.min(1, (s.soundVolume ?? 70) / 100));
				const p = a.play();
				if (p && typeof p.catch === 'function') {
					p.catch(() => {
						// Autoplay can be blocked until first user gesture; ignore.
					});
				}
			} catch {
				// ignore
			}
		}

		playCompleted() {
			if (!this.settings.soundOnCompleted) return;
			this._play(this.settings.soundCompletedFile || 'glass.mp3');
		}

		playInputRequired() {
			if (!this.settings.soundOnInputRequired) return;
			this._play(this.settings.soundInputFile || 'basso.mp3');
		}

		// Preview from popup — always plays (force), used by test buttons.
		test(which) {
			const file =
				which === 'input'
					? this.settings.soundInputFile || 'basso.mp3'
					: this.settings.soundCompletedFile || 'glass.mp3';
			this._play(file, { force: true });
		}
	}

	CC.sounds = new Sounds();
})();
