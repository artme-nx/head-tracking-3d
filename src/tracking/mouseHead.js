// Fallback bez kamere: miš glumi glavu, kotačić mijenja udaljenost.
// Dok miš glumi ruku (Shift, B…), glava stoji — inače bi se kamera micala s prstom.

export class MouseHead {
  constructor() {
    this.nx = 0; // -1..1
    this.ny = 0;
    this.z = 60;
    this.head = [0, 0, 60];
    this.roll = 0;
    this.held = [0, 0];
    window.addEventListener('pointermove', (e) => {
      this.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.ny = 1 - (e.clientY / window.innerHeight) * 2;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (e.shiftKey) return; // Shift + kotačić = dubina prsta
        this.z = Math.min(150, Math.max(25, this.z * Math.exp(e.deltaY * 0.001)));
      },
      { passive: true },
    );
  }

  /**
   * @param rect fizički pravokutnik canvasa u cm
   * @param {boolean} frozen miš trenutno glumi ruku — glava zadržava položaj
   */
  update(rect, dt, frozen = false) {
    if (!frozen) this.held = [this.nx, this.ny];
    const target = [rect.cx + this.held[0] * rect.width * 0.75, rect.cy + this.held[1] * rect.height * 0.75, this.z];
    const k = 1 - Math.exp(-dt * 12);
    for (let i = 0; i < 3; i++) this.head[i] += (target[i] - this.head[i]) * k;
    return this.head;
  }
}
