// Keys from a terminal in raw mode: the bytes it sends, read as keys. Escape sequences can arrive split across
// reads, so a reader keeps an unfinished one until the rest comes. Mouse wheel reports (SGR mode) and
// bracketed paste are keys too: a paste arrives whole, as one key, so its line breaks are not Enter.

export type Key =
  | { name: 'text'; text: string }
  | { name: 'paste'; text: string }
  | {
      name:
        | 'enter'
        | 'backspace'
        | 'delete'
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        | 'home'
        | 'end'
        | 'pageup'
        | 'pagedown'
        | 'tab'
        | 'shift-tab'
        | 'escape'
        | 'wheelup'
        | 'wheeldown';
    }
  | { name: 'ctrl'; key: string };

// CSI sequences that end in a letter, and those of the form ESC [ n ~.
const letters: Record<string, Key['name']> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'shift-tab',
};
const tilde: Record<string, Key['name']> = {
  '1': 'home',
  '7': 'home',
  '4': 'end',
  '8': 'end',
  '3': 'delete',
  '5': 'pageup',
  '6': 'pagedown',
};
const pasteStart = '\x1b[200~';
const pasteEnd = '\x1b[201~';

export class KeyReader {
  private pending = '';
  // The keys in a chunk of input, with any unfinished sequence held for the next chunk.
  feed(chunk: string): Key[] {
    let s = this.pending + chunk;
    this.pending = '';
    const keys: Key[] = [];
    let text = '';
    const flush = () => {
      if (text) keys.push({ name: 'text', text });
      text = '';
    };
    while (s.length) {
      if (s.startsWith(pasteStart)) {
        const end = s.indexOf(pasteEnd);
        if (end < 0) {
          this.pending = s;
          break;
        }
        flush();
        keys.push({ name: 'paste', text: s.slice(pasteStart.length, end).replace(/\r\n?/g, '\n') });
        s = s.slice(end + pasteEnd.length);
        continue;
      }
      const c = s[0]!;
      if (c === '\x1b') {
        const seq = sequence(s);
        if (seq === 'incomplete') {
          this.pending = s;
          break;
        }
        flush();
        if (seq.key) keys.push(seq.key);
        s = s.slice(seq.length);
        continue;
      }
      s = s.slice(1);
      if (c === '\r' || c === '\n') {
        flush();
        keys.push({ name: 'enter' });
      } else if (c === '\x7f' || c === '\b') {
        flush();
        keys.push({ name: 'backspace' });
      } else if (c === '\t') {
        flush();
        keys.push({ name: 'tab' });
      } else if (c < ' ') {
        flush();
        keys.push({ name: 'ctrl', key: String.fromCharCode(c.charCodeAt(0) + 96) });
      } else text += c;
    }
    flush();
    return keys;
  }
}

// The key an escape sequence at the start of s spells, and its length; 'incomplete' when s ends inside it.
function sequence(s: string): { key: Key | null; length: number } | 'incomplete' {
  if (s.length === 1) return { key: { name: 'escape' }, length: 1 };
  const next = s[1]!;
  if (next !== '[' && next !== 'O') return { key: { name: 'escape' }, length: 1 };
  // SGR mouse: ESC [ < button ; x ; y (M|m). Only the wheel is a key; clicks are ignored.
  if (s.startsWith('\x1b[<')) {
    const m = /^\x1b\[<(\d+);\d+;\d+([Mm])/.exec(s);
    if (!m) return /^\x1b\[<[\d;]*$/.test(s) ? 'incomplete' : { key: null, length: 3 };
    const button = Number(m[1]);
    return {
      key: button === 64 ? { name: 'wheelup' } : button === 65 ? { name: 'wheeldown' } : null,
      length: m[0].length,
    };
  }
  const m = /^\x1b[[O]([\d;]*)([A-Za-z~])/.exec(s);
  if (!m) return /^\x1b[[O][\d;]*$/.test(s) ? 'incomplete' : { key: null, length: 2 };
  const [all, params, final] = m;
  const name = final === '~' ? tilde[params!.split(';')[0]!] : letters[final!];
  return { key: name ? ({ name } as Key) : null, length: all!.length };
}
