import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createCanvas, ImageData} from '@napi-rs/canvas';
import {build} from 'esbuild';
import {createWorker} from 'tesseract.js';
import {cache, runBookMetadata} from './book-metadata-common.mjs';

const require = createRequire(import.meta.url);

async function readPages(file) {
    // DjVu.js ships browser sources with extensionless imports.
    const {outputFiles} = await build({
        entryPoints: [require.resolve('djvujs-dist/library/src/DjVuDocument.js')],
        bundle: true,
        format: 'esm',
        write: false,
        alias: {'pngjs/browser': require.resolve('pngjs/browser.js')},
        banner: {js: 'const self = globalThis;'},
    });
    globalThis.ImageData ??= ImageData;
    const {default: DjVuDocument} = await import(
        'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64')
    );
    const bytes = await readFile(file);
    const document = new DjVuDocument(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pages = [];
    let worker;

    try {
        for (let number = 1; number <= Math.min(3, document.getPagesQuantity()); number++) {
            const page = await document.getPage(number);
            let text = page.getText().trim();
            if (!/[\p{L}\p{N}]/u.test(text)) {
                worker ??= await createWorker(['rus', 'eng'], 1, {cachePath: cache});
                const image = page.getImageData();
                const canvas = createCanvas(image.width, image.height);
                canvas.getContext('2d').putImageData(image, 0, 0);
                const result = await worker.recognize(canvas.toBuffer('image/png'));
                text = result.data.text.trim();
            }
            pages.push(text);
        }
        return pages;
    } finally {
        await worker?.terminate();
    }
}

runBookMetadata(readPages, 'djvu-metadata.mjs', 'djvu').catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
