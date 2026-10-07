import { describe, expect, it } from 'vitest';
import { ModelEchoes } from './modelEchoes';

describe('Monaco source acknowledgements', () => {
  it('recognizes delayed echoes while newer keystrokes are already in the model', () => {
    const echoes = new ModelEchoes();
    echoes.remember('d'); echoes.remember('dr'); echoes.remember('draft');
    expect(echoes.acknowledge('d')).toBe(true);
    expect(echoes.acknowledge('draft')).toBe(true);
    expect(echoes.acknowledge('dr')).toBe(false);
  });
  it('accepts a genuine reset to an older previously acknowledged string', () => {
    const echoes = new ModelEchoes();
    echoes.remember('first'); expect(echoes.acknowledge('first')).toBe(true);
    echoes.remember('second'); expect(echoes.acknowledge('second')).toBe(true);
    expect(echoes.acknowledge('first')).toBe(false);
  });
  it('recognizes normalized line endings without modifying source text', () => {
    const echoes = new ModelEchoes(); echoes.remember('first\r\nsecond\r\n');
    expect(echoes.acknowledge('first\nsecond\n')).toBe(true);
    expect(echoes.acknowledge('first\nsecond')).toBe(false);
  });
  it('forgets previous document changes on source replacement', () => {
    const echoes = new ModelEchoes(); echoes.remember('previous draft'); echoes.clear();
    expect(echoes.acknowledge('previous draft')).toBe(false);
  });
  it('bounds pending snapshots when a consumer never echoes change notifications', () => {
    const echoes = new ModelEchoes();
    for (let index = 0; index < 40; index++) echoes.remember(`draft ${index}`);
    expect(echoes.acknowledge('draft 7')).toBe(false);
    expect(echoes.acknowledge('draft 8')).toBe(true);
    expect(echoes.acknowledge('draft 39')).toBe(true);
    expect(echoes.acknowledge('draft 38')).toBe(false);
  });
});
