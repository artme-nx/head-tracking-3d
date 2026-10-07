// Fallback bez kamere: miš glumi glavu, kotačić mijenja udaljenost.

export class MouseHead {
  constructor() {
    this.nx = 0; // -1..1
    this.ny = 0;
    this.z = 60;
    this.head = [0, 0, 60];
    this.roll = 0;
    window.addEventListener('pointermove', (e) => {
      this.nx = (e.clientX / window.innerWidth) * 2 - 1;
      this.ny = 1 - (e.clientY / window.innerHeight) * 2;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.z = Math.min(150, Math.max(25, this.z * Math.exp(e.deltaY * 0.001)));
      },
      { passive: true },
    );
  }

  /** @param rect fizički pravokutnik canvasa u cm */
  update(rect, dt) {
    const target = [rect.cx + this.nx * rect.width * 0.75, rect.cy + this.ny * rect.height * 0.75, this.z];
    const k = 1 - Math.exp(-dt * 12);
    for (let i = 0; i < 3; i++) this.head[i] += (target[i] - this.head[i]) * k;
    return this.head;
  }
}
