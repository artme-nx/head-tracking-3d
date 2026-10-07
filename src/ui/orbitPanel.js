// T: podešavanje ORBIT načina uživo (klizači), spremanje u localStorage.

import { ORBIT_DEFAULTS, ORBIT_FIELDS, saveOrbitSettings } from '../camera/orbitController.js';

export class OrbitPanel {
  constructor(settings, onChange) {
    this.settings = settings;
    this.onChange = onChange;
    this.el = document.createElement('form');
    this.el.className = 'panel panel--orbit';
    this.el.hidden = true;
    this.el.autocomplete = 'off';
    document.body.appendChild(this.el);
    this.visible = false;
    this.#build();
  }

  toggle(force) {
    this.visible = force ?? !this.visible;
    this.el.hidden = !this.visible;
  }

  #build() {
    const f = this.el;
    f.innerHTML = `
      <header class="panel__head">
        <h2>Orbit kamera</h2>
        <button type="button" class="icon-btn" data-act="close" aria-label="Zatvori">×</button>
      </header>
      <p class="panel__note">Pomak glave upravlja orbitom oko objekta. <kbd>N</kbd> postavlja trenutni položaj glave kao centar.</p>
      <div class="panel__fields"></div>
      <p class="panel__measure" data-live></p>
      <footer class="panel__foot">
        <button type="button" class="btn btn--ghost" data-act="reset">Zadano</button>
        <button type="button" class="btn" data-act="close">Gotovo</button>
      </footer>`;
    const fields = f.querySelector('.panel__fields');
    for (const def of ORBIT_FIELDS) {
      const row = document.createElement('label');
      row.className = 'field';
      row.innerHTML = `
        <span>${def.label}</span>
        <span class="field__ctrl">
          <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" data-range="${def.key}" />
          <input type="number" name="${def.key}" min="${def.min}" max="${def.max}" step="${def.step}" />
          <em>${def.unit}</em>
        </span>`;
      fields.appendChild(row);
    }
    this.live = f.querySelector('[data-live]');
    this.#sync();

    f.addEventListener('input', (e) => {
      const el = e.target;
      const key = el.dataset.range ?? el.name;
      if (!key || !(key in ORBIT_DEFAULTS)) return;
      const value = parseFloat(el.value);
      if (!Number.isFinite(value)) return;
      this.settings[key] = value;
      const twin = el.dataset.range ? f.querySelector(`input[name="${key}"]`) : f.querySelector(`[data-range="${key}"]`);
      if (twin) twin.value = value;
      saveOrbitSettings(this.settings);
      this.onChange(this.settings);
    });
    f.addEventListener('submit', (e) => e.preventDefault());
    f.addEventListener('keydown', (e) => e.stopPropagation());
    f.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.toggle(false);
      if (act === 'reset') {
        Object.assign(this.settings, ORBIT_DEFAULTS);
        saveOrbitSettings(this.settings);
        this.#sync();
        this.onChange(this.settings);
      }
    });
  }

  #sync() {
    for (const def of ORBIT_FIELDS) {
      const v = this.settings[def.key];
      this.el.querySelector(`input[name="${def.key}"]`).value = v;
      this.el.querySelector(`[data-range="${def.key}"]`).value = v;
    }
  }

  /** Živi prikaz stanja orbite dok je panel otvoren. */
  showState(text) {
    if (!this.visible) return;
    if (this.live.textContent !== text) this.live.textContent = text;
  }
}
