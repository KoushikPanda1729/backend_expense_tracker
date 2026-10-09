// Import the library file directly: the package index runs a debug routine when it is
// loaded without a parent module, which breaks bundled/ESM setups.
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdf(data: Buffer, options?: object): Promise<{ text: string; numpages: number }>;
  export = pdf;
}
