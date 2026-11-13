import { checkFile, findCuits } from './find-cuits.js';

// Test sources only ever hold allowlisted literals. To see a flag, the
// injected allowlist leaves them out.
const NONE: string[] = [];
const ALLOWED = ['30000000015'];

describe('findCuits', () => {
  it.each([
    ['without dashes', 'cuit 30000000015 here'],
    ['with dashes', 'cuit 30-00000001-5 here'],
    ['glued to letters', 'CUIT30000000015x'],
  ])('flags a valid CUIT off the allowlist %s', (_, text) => {
    expect(findCuits(text, NONE)).toHaveLength(1);
  });

  it.each([
    ['without dashes', 'cuit 30000000015 here'],
    ['with dashes', 'cuit 30-00000001-5 here'],
    ['glued to letters', 'CUIT30000000015x'],
  ])('lets an allowlisted CUIT through %s', (_, text) => {
    expect(findCuits(text, ALLOWED)).toEqual([]);
  });

  it('lets a wrong check digit through', () => {
    expect(findCuits('30-00000001-6 and 30000000016', NONE)).toEqual([]);
  });

  it('ignores a valid CUIT inside a longer run of digits', () => {
    expect(findCuits('id 1300000000155', NONE)).toEqual([]);
    expect(findCuits('id 300000000155', NONE)).toEqual([]);
  });

  it('reports line and column, and masks the number', () => {
    const findings = findCuits('first line\nsecond\n  x 20000000028\n', NONE);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding.line).toBe(3);
    expect(finding.column).toBe(5);
    expect(finding.masked).not.toContain('20000000028');
    expect(finding.masked.replace(/[^0-9]/g, '').length).toBeLessThan(11);
  });

  it('reports every finding in the text', () => {
    expect(findCuits('30000000015 30000000023\n30000000031', NONE)).toHaveLength(3);
  });
});

describe('checkFile', () => {
  const allowlists = { cuits: NONE, unscannedFiles: ['frontend/public/icon.png'] };
  const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);

  it('scans UTF-8 text for CUITs', () => {
    const result = checkFile('notes.md', Buffer.from('cuit 30-00000001-5\n'), allowlists);
    expect(result.unreadable).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('reads an empty file as text', () => {
    expect(checkFile('empty.txt', Buffer.alloc(0), allowlists)).toEqual({ unreadable: false, findings: [] });
  });

  it.each([
    ['a binary', BINARY],
    ['UTF-16 text', Buffer.from('cuit 30000000015', 'utf16le')],
    ['Latin-1 text', Buffer.from('raz\xf3n social 30000000015', 'latin1')],
  ])('marks %s as unreadable', (_, content) => {
    expect(checkFile('data.bin', content, allowlists)).toEqual({ unreadable: true, findings: [] });
  });

  it('lets through an unreadable file listed in unscannedFiles', () => {
    expect(checkFile('frontend/public/icon.png', BINARY, allowlists)).toEqual({
      unreadable: false,
      findings: [],
    });
  });

  it('still scans a listed file that is text', () => {
    const result = checkFile('frontend/public/icon.png', Buffer.from('30000000015'), allowlists);
    expect(result.findings).toHaveLength(1);
  });
});
