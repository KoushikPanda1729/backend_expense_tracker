import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';

const run = promisify(execFile);

export class WrongPasswordError extends Error {}

/**
 * Removes the password from a PDF with qpdf and returns the unlocked file.
 * The password goes through a private temp file, not the command line, so it never shows
 * up in the process list. The temp folder is deleted afterwards.
 */
export async function unlockPdf(input: Buffer, password: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kharcha-'));
  try {
    const inFile = path.join(dir, 'in.pdf');
    const outFile = path.join(dir, 'out.pdf');
    const pwFile = path.join(dir, 'pw.txt');
    await writeFile(inFile, input, { mode: 0o600 });
    await writeFile(pwFile, password.split('\n')[0]!, { mode: 0o600 }); // qpdf reads the first line

    try {
      await run(env.QPDF_PATH, [`--password-file=${pwFile}`, '--decrypt', inFile, outFile], { timeout: 30_000 });
    } catch (err) {
      const e = err as { code?: string | number; stderr?: string; stdout?: string };
      if (e.code === 'ENOENT') {
        throw new AppError(501, 'QPDF_MISSING', 'qpdf is not installed on the server (brew install qpdf)');
      }
      // exit code 3 means "finished with warnings": the output file is still good
      if (e.code !== 3) {
        if (/invalid password/i.test(`${e.stderr ?? ''}${e.stdout ?? ''}`)) throw new WrongPasswordError();
        throw err;
      }
    }
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
