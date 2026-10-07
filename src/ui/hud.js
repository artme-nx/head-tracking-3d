// Statusna traka, popis prečaca i kratke obavijesti.

export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.dot = document.getElementById('status-dot');
    this.text = document.getElementById('status-text');
    this.toastEl = document.getElementById('toast');
    this.state = '';
    this.toastTimer = 0;
  }

  toggle() {
    this.root.classList.toggle('is-hidden');
  }

  setStatus(state, label) {
    if (state === this.state && label === this.label) return;
    this.state = state;
    this.label = label;
    this.dot.dataset.state = state;
    this.text.textContent = label;
  }

  toast(message, ms = 2600) {
    clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    this.toastEl.classList.remove('is-out');
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.add('is-out');
      this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), 300);
    }, ms);
  }
}
