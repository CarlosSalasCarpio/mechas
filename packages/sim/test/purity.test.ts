import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// La simulación debe ser pura y determinista: nada de navegador, reloj, azar global ni trigonometría.
const FORBIDDEN: [RegExp, string][] = [
  [/Math\.random/, 'Math.random'],
  [/\bDate\b/, 'Date'],
  [/performance\./, 'performance'],
  [/\bwindow\b|\bdocument\b/, 'DOM'],
  [/from ['"](pixi|@epocas\/render|@epocas\/client)/, 'import de render/cliente'],
  [/Math\.(sin|cos|tan|atan2?|exp|log|pow|hypot|cbrt)\b/, 'Math trascendental'],
];

describe('pureza de sim/', () => {
  const dir = join(__dirname, '../src');
  for (const f of readdirSync(dir)) {
    it(f, () => {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const [re, name] of FORBIDDEN) expect(re.test(src), `${f} usa ${name}`).toBe(false);
    });
  }
});
