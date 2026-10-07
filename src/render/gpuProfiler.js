// GPU profiler (EXT_disjoint_timer_query_webgl2) za mjerenje troška pojedinih
// prolaza. Uključuje se iz konzole: __ht.profile(true); rezultati: __ht.profile().

export class GpuProfiler {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.enabled = false;
    this.active = null;
    this.pending = [];
    this.avg = {};
  }

  begin(label) {
    if (!this.enabled || !this.ext || this.active) return false;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, label };
    return true;
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  measure(label, fn) {
    const started = this.begin(label);
    try {
      return fn();
    } finally {
      if (started) this.end();
    }
  }

  wrap(obj, method, label) {
    const orig = obj[method].bind(obj);
    obj[method] = (...args) => this.measure(label, () => orig(...args));
  }

  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    this.pending = this.pending.filter(({ q, label }) => {
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return true;
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        const prev = this.avg[label];
        this.avg[label] = prev === undefined ? ms : prev * 0.9 + ms * 0.1;
      }
      gl.deleteQuery(q);
      return false;
    });
  }

  report() {
    const rows = Object.entries(this.avg).map(([k, v]) => [k, +v.toFixed(2)]);
    const total = rows.reduce((s, [, v]) => s + v, 0);
    return { total: +total.toFixed(2), ...Object.fromEntries(rows) };
  }
}
