import {readFile} from 'node:fs/promises';
import {createWorker} from 'tesseract.js';
import {cache, runBookMetadata} from './book-metadata-common.mjs';

async function readPages(file) {
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = getDocument({data: new Uint8Array(await readFile(file))});
    let worker;
    const pages = [];

    try {
        const document = await loadingTask.promise;
        for (let number = 1; number <= Math.min(3, document.numPages); number++) {
            const page = await document.getPage(number);
            const {items} = await page.getTextContent();
            let text = items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('').trim();

            if (!/[\p{L}\p{N}]/u.test(text)) {
                worker ??= await createWorker(['rus', 'eng'], 1, {cachePath: cache});
                const viewport = page.getViewport({scale: 2});
                const {canvas, context} = document.canvasFactory.create(
                    Math.ceil(viewport.width), Math.ceil(viewport.height),
                );
                await page.render({canvasContext: context, viewport}).promise;
                const result = await worker.recognize(canvas.toBuffer('image/png'));
                text = result.data.text.trim();
            }

            pages.push(text);
            page.cleanup();
        }
        return pages;
    } finally {
        await Promise.all([worker?.terminate(), loadingTask.destroy()]);
    }
}

runBookMetadata(readPages, 'book-metadata.mjs', 'pdf').catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
