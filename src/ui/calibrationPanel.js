// C: kalibracijski panel — fizička veličina ekrana, položaj kamere, FOV,
// zaglađivanje, stereo. Sve se sprema u localStorage.

import { DEFAULTS, FIELDS, saveSettings, clearSettings } from '../config.js';

const CARD_WIDTH_CM = 8.56; // ISO/IEC 7810 ID-1 (bankovna kartica)

export class CalibrationPanel {
  constructor(settings, onChange) {
    this.settings = settings;
    this.onChange = onChange;
    this.form = document.getElementById('calib');
    this.visible = false;
    this.inputs = new Map();
    this.#build();
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.form.hidden = !this.visible;
  }

  /** Živo prikaži izmjerenu udaljenost — korisno za provjeru metrom i FOV-a. */
  showMeasurement(eye, source) {
    if (!this.visible) return;
    const messages = {
      kamera: `Izmjereno sada: z = ${eye[2].toFixed(1)} cm · x = ${eye[0].toFixed(1)} · y = ${eye[1].toFixed(1)}. Ako se z ne slaže s metrom, podesi FOV kamere.`,
      centar: 'Lice nije u kadru — mjerenje nije dostupno.',
      miš: 'Kamera nije aktivna — miš glumi glavu.',
    };
    const text = messages[source] ?? '';
    if (this.measure.textContent !== text) this.measure.textContent = text;
  }

  #build() {
    const f = this.form;
    f.innerHTML = `
      <header class="panel__head">
        <h2>Kalibracija</h2>
        <button type="button" class="icon-btn" data-act="close" aria-label="Zatvori">×</button>
      </header>
      <p class="panel__note">Upiši fizičke mjere vidljive površine ekrana (bez okvira). Zadano je MacBook Air 13".</p>
      <div class="panel__fields"></div>
      <label class="field field--row">
        <span>Gledaj iz oka</span>
        <select name="eye">
          <option value="center">sredina</option>
          <option value="left">lijevo</option>
          <option value="right">desno</option>
        </select>
      </label>
      <label class="field field--row field--check">
        <input type="checkbox" name="compensateWindow" />
        <span>Uračunaj položaj prozora kad nije fullscreen</span>
      </label>
      <p class="panel__measure" data-measure></p>
      <div class="card-calib" hidden data-card>
        <p>Prisloni bankovnu karticu na ekran i povlači klizač dok se širine ne poklope.</p>
        <div class="card-calib__card" data-card-rect></div>
        <input type="range" min="150" max="900" step="1" data-card-range />
        <button type="button" class="btn" data-act="card-apply">Primijeni</button>
      </div>
      <footer class="panel__foot">
        <button type="button" class="btn btn--ghost" data-act="card">Izmjeri karticom</button>
        <button type="button" class="btn btn--ghost" data-act="reset">Zadano</button>
        <button type="button" class="btn" data-act="close">Gotovo</button>
      </footer>`;

    const fields = f.querySelector('.panel__fields');
    for (const def of FIELDS) {
      const row = document.createElement('label');
      row.className = 'field';
      row.innerHTML = `
        <span>${def.label}</span>
        <span class="field__ctrl">
          ${def.range ? `<input type="range" min="${def.min}" max="${def.max}" step="${def.step}" data-range="${def.key}" />` : ''}
          <input type="number" name="${def.key}" min="${def.min}" max="${def.max}" step="${def.step}" />
          <em>${def.unit}</em>
        </span>`;
      fields.appendChild(row);
    }

    this.measure = f.querySelector('[data-measure]');
    this.#sync();

    f.addEventListener('input', (e) => {
      const el = e.target;
      const key = el.dataset.range ?? el.name;
      if (!key || !(key in DEFAULTS)) return;
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.tagName === 'SELECT') value = el.value;
      else {
        value = parseFloat(el.value);
        if (!Number.isFinite(value)) return;
      }
      this.settings[key] = value;
      // Uskladi parnjak (klizač ↔ broj).
      const twin = el.dataset.range ? f.querySelector(`input[name="${key}"]`) : f.querySelector(`[data-range="${key}"]`);
      if (twin) twin.value = value;
      this.#commit();
    });

    f.addEventListener('submit', (e) => e.preventDefault());
    f.addEventListener('keydown', (e) => e.stopPropagation()); // tipkanje u polja ne okida prečace

    const card = f.querySelector('[data-card]');
    const cardRect = f.querySelector('[data-card-rect]');
    const cardRange = f.querySelector('[data-card-range]');
    const pxPerCm = () => window.screen.width / this.settings.screenWidth;
    const drawCard = () => {
      cardRect.style.width = `${cardRange.value}px`;
      cardRect.style.height = `${(cardRange.value * 53.98) / 85.6}px`;
    };
    cardRange.addEventListener('input', drawCard);

    f.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.toggle(false);
      if (act === 'reset') {
        Object.assign(this.settings, DEFAULTS);
        clearSettings();
        this.#sync();
        this.onChange(this.settings);
      }
      if (act === 'card') {
        card.hidden = !card.hidden;
        cardRange.value = Math.round(pxPerCm() * CARD_WIDTH_CM);
        drawCard();
      }
      if (act === 'card-apply') {
        const ppcm = parseFloat(cardRange.value) / CARD_WIDTH_CM; // CSS px po cm
        this.settings.screenWidth = round1(window.screen.width / ppcm);
        this.settings.screenHeight = round1(window.screen.height / ppcm);
        card.hidden = true;
        this.#sync();
        this.#commit();
      }
    });
  }

  #sync() {
    const f = this.form;
    for (const def of FIELDS) {
      const v = this.settings[def.key];
      f.querySelector(`input[name="${def.key}"]`).value = v;
      const r = f.querySelector(`[data-range="${def.key}"]`);
      if (r) r.value = v;
    }
    f.querySelector('select[name="eye"]').value = this.settings.eye;
    f.querySelector('input[name="compensateWindow"]').checked = this.settings.compensateWindow;
  }

  #commit() {
    saveSettings(this.settings);
    this.onChange(this.settings);
  }
}

const round1 = (n) => Math.round(n * 10) / 10;
