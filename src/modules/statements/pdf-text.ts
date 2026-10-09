interface PdfTextItem {
  str: string;
  transform: number[];
}
interface PdfPage {
  getTextContent(): Promise<{ items: Array<PdfTextItem | { type?: string }> }>;
  cleanup(): void;
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfJs {
  getDocument(src: object): { promise: Promise<PdfDoc> };
}

// pdfjs-dist 3.x ships a CommonJS build; newer versions are ESM only.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as PdfJs;

export class PdfPasswordError extends Error {
  constructor(public readonly incorrect: boolean) {
    super(incorrect ? 'Incorrect PDF password' : 'PDF password required');
  }
}

/**
 * Text of every page, one line per visual row. The password is only used here, in memory:
 * it is never stored, and the saved file stays locked exactly as the bank issued it.
 */
export async function extractPdfText(buf: Buffer, password?: string): Promise<string> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    password,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch (err) {
    const e = err as { name?: string; code?: number };
    // pdfjs codes: 1 = needs a password, 2 = the password given is wrong
    if (e.name === 'PasswordException') throw new PdfPasswordError(e.code === 2);
    throw err;
  }

  try {
    let text = '';
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5]!;
        if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
        else if (text && !text.endsWith('\n')) text += ' ';
        text += item.str;
        lastY = y;
      }
      text += '\n';
      page.cleanup();
    }
    return text;
  } finally {
    await doc.destroy();
  }
}
